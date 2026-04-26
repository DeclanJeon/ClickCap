(function() {
  'use strict';
  const CLICKCAP_REGISTER_EVENT = 'register-pons-link';

  const PROTOCOL = 'pons-clickcap';
  const REQUEST_TYPE = 'PONS_CLICKCAP_REQUEST';
  const RESPONSE_TYPE = 'PONS_CLICKCAP_RESPONSE';

  const isRequest = (data) => {
    return !!data
      && typeof data === 'object'
      && data.source === 'pons-link'
      && data.target === 'clickcap-extension'
      && data.protocol === PROTOCOL
      && data.version === 1
      && data.type === REQUEST_TYPE
      && typeof data.requestId === 'string';
  };

  const createResponse = (request, response) => ({
    source: 'clickcap-extension',
    target: 'pons-link',
    protocol: PROTOCOL,
    version: 1,
    type: RESPONSE_TYPE,
    requestId: request.requestId,
    action: request.action,
    ...response,
  });

  const install = ({ sendToExtension, extensionVersion = 'unknown' }) => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }

    if (window.__clickCapPageBridgeInstalled) {
      return;
    }
    window.__clickCapPageBridgeInstalled = true;

    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const request = event.data;
      if (!isRequest(request)) return;

      if (request.action === 'ping') {
        window.postMessage(createResponse(request, {
          ok: true,
          payload: { installed: true, extensionVersion },
        }), window.location.origin);
        return;
      }

      if (request.action === 'start-capture') {
        try {
          const payload = request.payload || {};
          const mode = payload.mode === 'full-screen' ? 'full-screen' : 'area';
          const result = await sendToExtension({
            type: 'start-recording',
            data: {
              mode,
              preferences: payload.preferences,
            },
          });

          window.postMessage(createResponse(request, {
            ok: result?.success !== false,
            payload: result?.success === false ? undefined : {
              started: true,
              streamId: result?.streamId,
            },
            error: result?.success === false ? (result.error || 'ClickCap capture could not start') : undefined,
          }), window.location.origin);
        } catch (error) {
          window.postMessage(createResponse(request, {
            ok: false,
            error: error instanceof Error ? error.message : 'ClickCap capture could not start',
          }), window.location.origin);
        }
        return;
      }

      if (request.action === 'prepare-capture') {
        const result = await sendToExtension({
          type: CLICKCAP_REGISTER_EVENT,
          requestId: request.requestId,
          data: {
            roomHint: request.payload?.roomHint,
          },
        });

        window.postMessage(createResponse(request, {
          ok: result?.success !== false,
          error: result?.success === false ? (result.error || 'ClickCap capture host registration failed') : undefined,
        }), window.location.origin);
        return;
      }

      window.postMessage(createResponse(request, {
        ok: false,
        error: `Unsupported ClickCap bridge action: ${request.action}`,
      }), window.location.origin);
    });
  };

  window.ClickCapPageBridge = { install };
})();
