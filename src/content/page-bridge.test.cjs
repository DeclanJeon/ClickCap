const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridgePath = path.resolve(__dirname, 'page-bridge.js');

const loadBridge = () => {
  const listeners = new Map();
  const postedMessages = [];
  const window = {
    location: { origin: 'https://pons.test' },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    postMessage(message, targetOrigin) {
      postedMessages.push({ message, targetOrigin });
    },
  };
  const sandbox = {
    window,
    globalThis: window,
    console: { warn() {}, error() {}, log() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), sandbox);
  return { window, listeners, postedMessages };
};

test('ClickCap page bridge replies to Pons-Link ping requests', async () => {
  const { window, listeners, postedMessages } = loadBridge();
  window.ClickCapPageBridge.install({
    sendToExtension: async () => ({ success: true }),
    extensionVersion: '1.0.1',
  });

  listeners.get('message')({
    source: window,
    data: {
      source: 'pons-link',
      target: 'clickcap-extension',
      protocol: 'pons-clickcap',
      version: 1,
      type: 'PONS_CLICKCAP_REQUEST',
      requestId: 'req-1',
      action: 'ping',
    },
  });

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].targetOrigin, 'https://pons.test');
  assert.equal(JSON.stringify(postedMessages[0].message), JSON.stringify({
    source: 'clickcap-extension',
    target: 'pons-link',
    protocol: 'pons-clickcap',
    version: 1,
    type: 'PONS_CLICKCAP_RESPONSE',
    requestId: 'req-1',
    action: 'ping',
    ok: true,
    payload: { installed: true, extensionVersion: '1.0.1' },
  }));
});

test('ClickCap page bridge forwards start-capture requests to the extension runtime', async () => {
  const { window, listeners, postedMessages } = loadBridge();
  const sentMessages = [];
  window.ClickCapPageBridge.install({
    sendToExtension: async (message) => {
      sentMessages.push(message);
      return { success: true };
    },
    extensionVersion: '1.0.1',
  });

  await listeners.get('message')({
    source: window,
    data: {
      source: 'pons-link',
      target: 'clickcap-extension',
      protocol: 'pons-clickcap',
      version: 1,
      type: 'PONS_CLICKCAP_REQUEST',
      requestId: 'req-2',
      action: 'start-capture',
      payload: { mode: 'area', preferences: { fps: 30 } },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(JSON.stringify(sentMessages), JSON.stringify([{
    type: 'start-recording',
    data: { mode: 'area', preferences: { fps: 30 } },
  }]));
  assert.equal(postedMessages[0].message.requestId, 'req-2');
  assert.equal(postedMessages[0].message.action, 'start-capture');
  assert.equal(postedMessages[0].message.ok, true);
  assert.equal(JSON.stringify(postedMessages[0].message.payload), JSON.stringify({ started: true }));
});

test('ClickCap page bridge forwards prepare-capture requests to extension', async () => {
  const { window, listeners, postedMessages } = loadBridge();
  const sentMessages = [];
  window.ClickCapPageBridge.install({
    sendToExtension: async (message) => {
      sentMessages.push(message);
      return { success: true };
    },
    extensionVersion: '1.0.1',
  });

  await listeners.get('message')({
    source: window,
    data: {
      source: 'pons-link',
      target: 'clickcap-extension',
      protocol: 'pons-clickcap',
      version: 1,
      type: 'PONS_CLICKCAP_REQUEST',
      requestId: 'req-3',
      action: 'prepare-capture',
      payload: { roomHint: 'room-1' },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(JSON.stringify(sentMessages), JSON.stringify([{
    type: 'register-pons-link',
    requestId: 'req-3',
    data: { roomHint: 'room-1' },
  }]));
  assert.equal(postedMessages[0].message.requestId, 'req-3');
  assert.equal(postedMessages[0].message.action, 'prepare-capture');
  assert.equal(postedMessages[0].message.ok, true);
});

test('ClickCap page bridge ignores foreign window messages', async () => {
  const { window, listeners, postedMessages } = loadBridge();
  const sentMessages = [];
  window.ClickCapPageBridge.install({
    sendToExtension: async (message) => {
      sentMessages.push(message);
      return { success: true };
    },
  });

  listeners.get('message')({
    source: {},
    data: {
      source: 'pons-link',
      target: 'clickcap-extension',
      protocol: 'pons-clickcap',
      version: 1,
      type: 'PONS_CLICKCAP_REQUEST',
      requestId: 'req-3',
      action: 'ping',
    },
  });

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(postedMessages, []);
});
