import { MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';

class SafeChrome {
  static async sendMessage(message, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(response || { success: true });
            }
          });
        });
        return res;
      } catch (e) {
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 200 * (i + 1)));
        }
      }
    }
    return { success: false, error: 'Receiving end does not exist' };
  }

  static async sendTabMessage(tabId, message, retries = 3) {
    // Check if tab exists before sending message
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.id) {
        return { success: false, error: 'Tab does not exist' };
      }
    } catch {
      return { success: false, error: 'Tab does not exist' };
    }

    for (let i = 0; i < retries; i++) {
      try {
        const res = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
              const error = chrome.runtime.lastError.message;
              // Silently handle "Receiving end does not exist" errors
              if (error.includes('Receiving end does not exist')) {
                resolve({ success: false, error: 'Receiving end does not exist' });
              } else {
                reject(chrome.runtime.lastError);
              }
            } else {
              resolve(response || { success: true });
            }
          });
        });
        return res;
      } catch (e) {
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 200 * (i + 1)));
        }
      }
    }
    return { success: false, error: 'Receiving end does not exist' };
  }
}

class MessageQueue {
  constructor() {
    this.queues = new Map();
    this.processing = new Set();
  }

  async enqueue(tabId, message) {
    if (!this.queues.has(tabId)) {
      this.queues.set(tabId, []);
    }
    this.queues.get(tabId).push(message);
    if (!this.processing.has(tabId)) {
      await this.processQueue(tabId);
    }
  }

  async processQueue(tabId) {
    if (this.processing.has(tabId)) return;
    this.processing.add(tabId);
    const queue = this.queues.get(tabId);

    while (queue && queue.length > 0) {
      const message = queue.shift();
      try {
        if (!(await tabExists(tabId))) break;
        const isReady = await this.pingContentScript(tabId);
        if (!isReady) {
          queue.unshift(message);
          setTimeout(() => this.processQueue(tabId), 500);
          break;
        }
        const result = await SafeChrome.sendTabMessage(tabId, message);
        if (!result?.success) {
          queue.unshift(message);
          setTimeout(() => this.processQueue(tabId), 1000);
          break;
        }
      } catch {
        if (queue.length > 0) {
          queue.unshift(message);
          setTimeout(() => this.processQueue(tabId), 1000);
          break;
        }
      }
    }
    this.processing.delete(tabId);
  }

  async pingContentScript(tabId) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: 'ping' }, (response) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(response);
        });
      });
      return response?.success === true;
    } catch {
      return false;
    }
  }

  clear(tabId) {
    this.queues.delete(tabId);
    this.processing.delete(tabId);
  }
}

const messageQueue = new MessageQueue();
const PENDING_PONS_LINK_CAPTURE_HOST_TTL_MS = 8 * 60 * 60 * 1000;
const isValidPonsLinkHost = (host) => {
  return !!host
    && Number.isInteger(host.tabId)
    && host.tabId > 0
    && typeof host.requestedAt === 'number';
};

async function tabExists(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return !!t?.id;
  } catch {
    return false;
  }
}

class ServiceWorkerMain {
  constructor() {
    this.state = {
      currentTabId: null,
      isRecording: false,
      isPaused: false,
      cropArea: null,
      preferences: { ...DEFAULT_PREFERENCES },
      startedAt: 0,
      isStarting: false,
      offscreenReady: false,

      // ✅ 추가: 녹화 세션 상태
      recordingSession: null, // { tabId, cropArea, startTime, isActive, preferences }
      pendingPonsLinkCaptureHost: null, // { tabId, requestId, roomHint, requestedAt }
      ponsLinkShareSession: null, // { host, sourceTabId, startedAt }
      activeCaptureSession: null, // { mode, type, status, sourceTabId, startedAt, preferences }
    };
    this.setup();
    this.setupKeepAlive();
    void this.init();
  }

  setup() {
    chrome.runtime.onInstalled.addListener(() => {
      void this.init();
    });
    chrome.runtime.onStartup.addListener(() => {
      void this.init();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handle(message, sender).then(sendResponse).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      messageQueue.clear(tabId);
      if (this.state.currentTabId === tabId) {
        this.state.currentTabId = null;
        this.state.isRecording = false;
        this.state.isPaused = false;
        void this.clearActiveCaptureSession();
      }
      if (this.state.pendingPonsLinkCaptureHost?.tabId === tabId) {
        void this.clearPendingPonsLinkCaptureHost();
      }
      if (this.state.ponsLinkShareSession?.host?.tabId === tabId) {
        this.state.ponsLinkShareSession = null;
        this.state.isRecording = false;
        this.state.isPaused = false;
        void this.clearActiveCaptureSession();
      }
    });

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete') {
        // ✅ 녹화 중인 탭인지 확인
        if (this.state.recordingSession?.isActive &&
            this.state.recordingSession.tabId === tabId) {

          console.log('🔄 [ServiceWorker] Recording tab updated, restoring UI...');

          // Content script 재주입 (이미 있으면 스킵됨)
          chrome.tabs.sendMessage(tabId, { type: 'ping' }, async (response) => {
            if (chrome.runtime.lastError || !response?.success) {
              console.log('📌 [ServiceWorker] Re-injecting content script');

              try {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  files: ['src/content/content-script.js']
                });

                console.log('✅ [ServiceWorker] Content script re-injected');
              } catch (err) {
                console.warn('[ServiceWorker] Failed to re-inject:', err);
              }
            }
          });
        } else {
          // 일반 메시지 큐 처리
          setTimeout(() => messageQueue.processQueue(tabId), 100);
        }
      }
    });

    // ✅ Tab 네비게이션 감지 (디버깅용 로깅만)
    chrome.webNavigation.onCommitted.addListener(async (details) => {
      if (details.frameId !== 0) return; // 메인 프레임만 처리

      const tabId = details.tabId;

      // 녹화 중인 탭인지 확인
      if (this.state.recordingSession?.isActive &&
          this.state.recordingSession.tabId === tabId) {

        console.log('🔄 [ServiceWorker] Page navigation detected during recording');
        console.log('📊 [ServiceWorker] Navigation details:', {
          transitionType: details.transitionType,
          url: details.url
        });
        // 자동 중지 기능 제거 - 사용자가 수동으로 중지할 수 있도록 함
      }
    });

    chrome.commands.onCommand.addListener(async (command) => {
      if (command === 'toggle-recording') {
        if (this.state.isRecording) {
          await this.stopCmd();
        } else {
          await this.startCmd({ mode: 'full-screen', preferences: this.state.preferences });
        }
      } else if (command === 'pause-recording') {
        await this.recordingCommand('pause');
      }
    });
  }

  setupKeepAlive() {
    try {
      setInterval(() => {
        try {
          chrome.runtime.getPlatformInfo(() => {});
        } catch {}
      }, 20000);
    } catch {}
  }

  async init() {
    await storageManager.init();
    const saved = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
    if (saved) this.state.preferences = { ...this.state.preferences, ...saved };

    await this.loadPendingPonsLinkCaptureHost();
    await this.loadActiveCaptureSession();
  }

  async loadActiveCaptureSession() {
    const saved = await storageManager.getChromeStorage(STORAGE_KEYS.ACTIVE_CAPTURE_SESSION);
    if (!saved || typeof saved !== 'object') return;

    const sourceTabId = saved.sourceTabId;
    if (Number.isInteger(sourceTabId) && sourceTabId > 0 && !(await tabExists(sourceTabId))) {
      await this.clearActiveCaptureSession();
      return;
    }

    this.state.activeCaptureSession = saved;
    this.state.currentTabId = Number.isInteger(sourceTabId) ? sourceTabId : this.state.currentTabId;
    this.state.isRecording = saved.status === 'sharing' || saved.status === 'recording' || saved.status === 'selecting';
    this.state.startedAt = saved.startedAt || this.state.startedAt;
    if (saved.type === 'pons-link') {
      this.state.ponsLinkShareSession = saved.ponsLinkShareSession || this.state.ponsLinkShareSession;
    }
  }

  async persistActiveCaptureSession(session) {
    this.state.activeCaptureSession = session;
    await storageManager.saveChromeStorage(STORAGE_KEYS.ACTIVE_CAPTURE_SESSION, session);
  }

  async clearActiveCaptureSession() {
    this.state.activeCaptureSession = null;
    await storageManager.removeChromeStorage(STORAGE_KEYS.ACTIVE_CAPTURE_SESSION);
  }

  async loadPendingPonsLinkCaptureHost() {
    const saved = await storageManager.getChromeStorage(STORAGE_KEYS.PENDING_PONS_LINK_CAPTURE_HOST);

    if (!isValidPonsLinkHost(saved)) {
      if (saved) {
        await storageManager.removeChromeStorage(STORAGE_KEYS.PENDING_PONS_LINK_CAPTURE_HOST);
      }
      return;
    }

    const pendingAge = Date.now() - saved.requestedAt;
    if (pendingAge > PENDING_PONS_LINK_CAPTURE_HOST_TTL_MS) {
      console.log('[ServiceWorker] Dropping stale pending ClickCap capture host registration.');
      await this.clearPendingPonsLinkCaptureHost();
      return;
    }

    this.state.pendingPonsLinkCaptureHost = saved;
    console.log('[ServiceWorker] Restored pending ClickCap host registration:', saved.requestId);
  }

  async persistPendingPonsLinkCaptureHost() {
    const host = this.state.pendingPonsLinkCaptureHost;
    if (!isValidPonsLinkHost(host)) {
      await storageManager.removeChromeStorage(STORAGE_KEYS.PENDING_PONS_LINK_CAPTURE_HOST);
      return;
    }

    await storageManager.saveChromeStorage(
      STORAGE_KEYS.PENDING_PONS_LINK_CAPTURE_HOST,
      host,
    );
  }

  async clearPendingPonsLinkCaptureHost() {
    this.state.pendingPonsLinkCaptureHost = null;
    await storageManager.removeChromeStorage(STORAGE_KEYS.PENDING_PONS_LINK_CAPTURE_HOST);
  }

  async handle(message, sender) {
    switch (message.type) {
      case MESSAGE_TYPES.CONTENT_SCRIPT_READY:
        return { success: true };
      case MESSAGE_TYPES.OFFSCREEN_READY:
        this.state.offscreenReady = true;
        return { success: true };
      case MESSAGE_TYPES.START_RECORDING:
        return this.startCmd(message.data);
      case MESSAGE_TYPES.START_RECORDING_FOR_PONS_LINK:
        return this.startCmd(message.data, { requirePonsLinkTarget: true, shareToPonsLink: true });
      case MESSAGE_TYPES.AREA_SELECTED:
        return this.areaSelected(message.data);
      case 'start-area-recording': // 새로 추가
        return this.startAreaRecording();
      case MESSAGE_TYPES.RECORDING_STATS:
        return this.forwardStats(message.data);
      case MESSAGE_TYPES.STOP_RECORDING:
        return this.stopCmd();
      case MESSAGE_TYPES.RECORDING_COMMAND:
        return this.recordingCommand(message.command);
      case MESSAGE_TYPES.UPDATE_PREFS:
        this.state.preferences = { ...this.state.preferences, ...(message.data || {}) };
        await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.state.preferences);

        // ✅ 녹화 세션 업데이트
        if (this.state.recordingSession && this.state.recordingSession.isActive) {
          this.state.recordingSession.preferences = { ...this.state.preferences };
        }

        if (this.state.isRecording && this.state.currentTabId) {
          await SafeChrome.sendMessage({ type: MESSAGE_TYPES.UPDATE_PREFS, target: 'offscreen', data: this.state.preferences });
          await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.UPDATE_PREFS, data: this.state.preferences });
          await SafeChrome.sendTabMessage(this.state.currentTabId, {
            type: MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM,
            data: { enabled: !!this.state.preferences.clickElementZoomEnabled }
          });
        }
        return { success: true };
      case MESSAGE_TYPES.ELEMENT_CLICKED_ZOOM:
        console.log('📥 [ServiceWorker] Received zoom request:', message.data);

        const zoomResult = await SafeChrome.sendMessage({
          type: MESSAGE_TYPES.ELEMENT_CLICKED_ZOOM,
          target: 'offscreen',
          data: message.data
        });

        console.log('📤 [ServiceWorker] Zoom forwarded to offscreen:', zoomResult);
        return zoomResult;
      case MESSAGE_TYPES.CLICKCAP_REGISTER_PONS_LINK:
        return this.registerPonsLinkCaptureHost({
          sender,
          requestId: message.requestId,
          roomHint: message.data?.roomHint,
        });
      case 'GET_RECORDING_SESSION': // ✅ 추가
        return {
          success: true,
          session: this.getPublicCaptureSession()
        };
      default:
        return { success: true };
    }
  }

  getPublicCaptureSession() {
    const active = this.state.activeCaptureSession;
    if (!active) {
      return {
        isActive: false,
        isRecording: this.state.isRecording,
        isPaused: this.state.isPaused,
      };
    }

    return {
      ...active,
      isActive: true,
      isRecording: this.state.isRecording,
      isPaused: this.state.isPaused,
      recordingSession: this.state.recordingSession,
    };
  }

  async ensureContentScript(tabId) {
    if (!(await tabExists(tabId))) return false;

    const ping = () => new Promise((res) => {
      const timeout = setTimeout(() => res(false), 1000);
      try {
        chrome.tabs.sendMessage(tabId, { type: 'ping' }, (r) => {
          clearTimeout(timeout);
          res(!!(r && r.success));
        });
      } catch {
        clearTimeout(timeout);
        res(false);
      }
    });

    const initialPing = await ping();
    if (initialPing) return true;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/content-script.js']
      });
      await new Promise(r => setTimeout(r, 500));
    } catch {
      return false;
    }

    for (let i = 0; i < 8; i++) {
      const ok = await ping();
      if (ok) return true;
      const delay = Math.min(100 * Math.pow(2, i), 2000);
      await new Promise(r => setTimeout(r, delay));
    }
    return false;
  }

  async registerPonsLinkCaptureHost({
    sender,
    requestId,
    roomHint,
  }) {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      return { success: false, error: 'No source tab for Pons link registration' };
    }

    this.state.pendingPonsLinkCaptureHost = {
      tabId,
      requestId,
      roomHint,
      requestedAt: Date.now(),
    };
    await this.persistPendingPonsLinkCaptureHost();

    return { success: true, requestId };
  }

  async notifyPonsLinkCaptureHost(streamId, payload = {}) {
    const hostRequest = this.state.pendingPonsLinkCaptureHost;
    if (!hostRequest?.tabId) return;

    const pendingAge = Date.now() - (hostRequest.requestedAt || 0);

    if (pendingAge > PENDING_PONS_LINK_CAPTURE_HOST_TTL_MS) {
      await this.clearPendingPonsLinkCaptureHost();
      return;
    }

    const notifyMessage = {
      type: MESSAGE_TYPES.CLICKCAP_STREAM_READY,
      data: {
        requestId: hostRequest.requestId,
        streamId,
        roomHint: hostRequest.roomHint,
        sourceTabId: this.state.currentTabId,
        cropArea: payload.cropArea,
        view: payload.view,
      },
    };
    await messageQueue.enqueue(hostRequest.tabId, notifyMessage);
    await this.clearPendingPonsLinkCaptureHost();
  }

  async ensureOffscreen() {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Screen recording'
      });
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async startCmd({ mode, preferences }, options = {}) {
    if (options.requirePonsLinkTarget && !isValidPonsLinkHost(this.state.pendingPonsLinkCaptureHost)) {
      return {
        success: false,
        error: 'No open Pons-Link room is connected. Open your Pons-Link room tab, then try Share Screen again.',
      };
    }

    if (this.state.isStarting) {
      return { success: false, error: 'Already starting' };
    }
    this.state.isStarting = true;

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Start recording timeout')), 10000);
    });

    try {
      const result = await Promise.race([
        this.startCmdInternal({ mode, preferences }, options),
        timeoutPromise
      ]);
      return result;
    } catch (error) {
      await this.clearPendingPonsLinkCaptureHost();
      this.state.ponsLinkShareSession = null;
      return { success: false, error: error.message };
    } finally {
      this.state.isStarting = false;
    }
  }

  async startCmdInternal({ mode, preferences }, options = {}) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    if (String(tab.url).startsWith('chrome://') ||
        String(tab.url).startsWith('chrome-extension://')) {
      throw new Error('Cannot record chrome:// or extension pages');
    }

    this.state.currentTabId = tab.id;
    this.state.preferences = { ...this.state.preferences, ...(preferences || {}) };
    await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.state.preferences);
    this.state.ponsLinkShareSession = options.shareToPonsLink
      ? {
          host: { ...this.state.pendingPonsLinkCaptureHost },
          sourceTabId: tab.id,
          startedAt: Date.now(),
        }
      : null;
    await this.persistActiveCaptureSession({
      type: options.shareToPonsLink ? 'pons-link' : 'recording',
      mode,
      status: mode === 'area' ? 'selecting' : (options.shareToPonsLink ? 'sharing' : 'recording'),
      sourceTabId: tab.id,
      startedAt: Date.now(),
      preferences: { ...this.state.preferences },
      ponsLinkShareSession: this.state.ponsLinkShareSession,
    });

    const contentScriptReady = await this.ensureContentScript(tab.id);
    if (!contentScriptReady) {
      throw new Error('Content script not ready after retries');
    }

    if (mode === 'area') {
      // 지정 영역 모드
      await SafeChrome.sendTabMessage(tab.id, { type: MESSAGE_TYPES.SHOW_AREA_SELECTOR });
      return { success: true };
    }

    // 전체 화면 녹화 모드
    console.log(' [ServiceWorker] Starting full screen recording');
    
    // view context 가져오기 (안전한 방식으로)
    let viewRes = null;
    try {
      viewRes = await Promise.race([
        new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_VIEW_CONTEXT' }, (r) => {
            if (chrome.runtime.lastError) {
              console.warn('[ServiceWorker] View context error:', chrome.runtime.lastError);
              resolve(null);
            } else {
              resolve(r);
            }
          });
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000))
      ]);
    } catch (e) {
      console.warn('[ServiceWorker] Failed to get view context:', e);
      viewRes = null;
    }

    // 기본 view 값 설정 (Service Worker에서는 window 접근 불가하므로 고정 값 사용)
    const view = viewRes?.data || {
      viewportWidth: 1920,
      viewportHeight: 1080,
      dpr: 1,
      scrollX: 0,
      scrollY: 0,
      vvScale: 1,
      vvOffsetLeft: 0,
      vvOffsetTop: 0,
      vvWidth: 1920,
      vvHeight: 1080
    };

    console.log(' [ServiceWorker] Full screen recording view:', view);

    if (options.shareToPonsLink) {
      return this.startPonsLinkShareCapture({ cropArea: null, view });
    }

    // cropArea: null로 전체 화면 녹화 시작
    await this.startCapture({ cropArea: null, view }, this.state.preferences);

    // 전체 화면 녹화에서는 녹화 영역 표시 안 함
    // Dock만 표시
    if (this.state.preferences.showDock) {
      await this.showDockWithRetry();
    }

    return { success: true };
  }

  async areaSelected({ cropArea, view }) {
    this.state.cropArea = cropArea;
    this.state.cropView = view;
    if (this.state.activeCaptureSession) {
      await this.persistActiveCaptureSession({
        ...this.state.activeCaptureSession,
        status: 'ready',
        cropArea,
        view,
      });
    }

    // 영역 선택 UI 숨기기
    await SafeChrome.sendTabMessage(this.state.currentTabId, {
      type: MESSAGE_TYPES.HIDE_AREA_SELECTOR
    });

    const prefs = (await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES))
      || this.state.preferences;

    // ✅ Content script가 준비될 때까지 대기
    let contentScriptReady = false;
    for (let i = 0; i < 10; i++) {
      const pingResult = await SafeChrome.sendTabMessage(this.state.currentTabId, {
        type: 'ping'
      });

      if (pingResult?.success) {
        contentScriptReady = true;
        console.log('✅ [ServiceWorker] Content script ready');
        break;
      }

      console.log(`⏳ [ServiceWorker] Waiting for content script (${i + 1}/10)...`);
      await new Promise(r => setTimeout(r, 200));
    }

    if (!contentScriptReady) {
      console.error('❌ [ServiceWorker] Content script not ready after 10 attempts');
      return { success: false, error: 'Content script not responding' };
    }

    // ✅ Crop 영역 설정 (즉시 설정하여 대기 모드에서도 클릭 감지 가능)
    const cropResult = await SafeChrome.sendTabMessage(this.state.currentTabId, {
      type: 'set-recording-crop',
      data: {
        ...cropArea,
        isSelecting: false,
        waitingMode: true  // ✅ 대기 모드 플래그 추가
      }
    });

    console.log('✅ [ServiceWorker] Crop area set result:', cropResult);

    // Dock 표시 (대기 모드)
    if (prefs.showDock) {
      await this.showDockWithRetry(true); // waitingMode = true
    }

    console.log('✅ [ServiceWorker] Area selected, waiting for user to start recording');

    return { success: true };
  }

  async startAreaRecording() {
    if (!this.state.cropArea) {
      return { success: false, error: 'No crop area selected' };
    }

    console.log(' [ServiceWorker] Starting area recording with crop:', this.state.cropArea);

    // view context 가져오기
    let viewRes = null;
    try {
      viewRes = await Promise.race([
        new Promise((resolve) => {
          chrome.tabs.sendMessage(this.state.currentTabId, { type: 'REQUEST_VIEW_CONTEXT' }, (r) => {
            if (chrome.runtime.lastError) {
              resolve(null);
            } else {
              resolve(r);
            }
          });
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000))
      ]);
    } catch (e) {
      console.warn('[ServiceWorker] Failed to get view context:', e);
    }

    const view = viewRes?.data || {
      viewportWidth: 1920,
      viewportHeight: 1080,
      dpr: 1,
      scrollX: 0,
      scrollY: 0,
      vvScale: 1,
      vvOffsetLeft: 0,
      vvOffsetTop: 0,
      vvWidth: 1920,
      vvHeight: 1080
    };

    if (this.state.ponsLinkShareSession) {
      await this.startPonsLinkShareCapture({ cropArea: this.state.cropArea, view });
    } else {
      await this.startCapture({ cropArea: this.state.cropArea, view }, this.state.preferences);
    }

  // ✅ Content script에 녹화 시작 알림
  await SafeChrome.sendTabMessage(this.state.currentTabId, {
    type: 'recording-started'
  });

  console.log('✅ [ServiceWorker] Area recording started');

  return { success: true };
  }

  async startPonsLinkShareCapture({ cropArea, view }) {
    const host = this.state.ponsLinkShareSession?.host || this.state.pendingPonsLinkCaptureHost;
    if (!isValidPonsLinkHost(host)) {
      throw new Error('No open Pons-Link room is connected.');
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: this.state.currentTabId,
      consumerTabId: host.tabId,
    });

    this.state.isRecording = true;
    this.state.isPaused = false;
    this.state.startedAt = Date.now();
    await this.persistActiveCaptureSession({
      ...(this.state.activeCaptureSession || {}),
      type: 'pons-link',
      status: 'sharing',
      mode: this.state.activeCaptureSession?.mode || 'area',
      sourceTabId: this.state.currentTabId,
      startedAt: this.state.activeCaptureSession?.startedAt || Date.now(),
      cropArea,
      view,
      ponsLinkShareSession: this.state.ponsLinkShareSession,
    });

    await this.notifyPonsLinkCaptureHost(streamId, { cropArea, view });

    console.log('✅ [ServiceWorker] Pons-Link share stream handed off:', {
      sourceTabId: this.state.currentTabId,
      consumerTabId: host.tabId,
      hasCrop: !!cropArea,
    });

    return { success: true, streamId };
  }

  async showDockWithRetry(waitingMode = false) {
    if (!this.state.currentTabId) {
      console.warn('[ServiceWorker] No currentTabId for showing dock');
      return;
    }
    
    console.log(' [ServiceWorker] Sending SHOW_DOCK to tab:', this.state.currentTabId, 'waitingMode:', waitingMode);
    
    for (let i = 0; i < 3; i++) {
      const result = await SafeChrome.sendTabMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.SHOW_DOCK,
        data: { waitingMode }
      });
      
      if (result?.success) {
        console.log(' [ServiceWorker] SHOW_DOCK sent successfully');
        return;
      }
      
      console.warn(` [ServiceWorker] SHOW_DOCK attempt ${i+1} failed, retrying...`);
      await new Promise(r => setTimeout(r, 300));
    }
    
    console.error(' [ServiceWorker] Failed to show dock after retries');
  }

  async waitOffscreenReady(timeoutMs) {
    const start = Date.now();
    while (!this.state.offscreenReady && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
    }
    return this.state.offscreenReady;
  }

  async startCapture(payload, preferences) {
    await this.ensureOffscreen();
    
    // 최대 2초 정도까지 OFFSCREEN_READY 기다리기
    const offscreenReady = await this.waitOffscreenReady(2000);
    if (!offscreenReady) {
      throw new Error('Offscreen document not ready');
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: this.state.currentTabId });

    const res = await SafeChrome.sendMessage({
      type: MESSAGE_TYPES.START_RECORDING,
      target: 'offscreen',
      data: {
        streamId,
        cropAreaCSS: payload.cropArea,
        view: payload.view,
        preferences
      }
    });

    if (!res?.success) {
      throw new Error(res?.error || 'Offscreen failed');
    }

    this.state.isRecording = true;
    this.state.isPaused = false;
    this.state.startedAt = Date.now();

    // ✅ 녹화 세션 저장
    this.state.recordingSession = {
      tabId: this.state.currentTabId,
      cropArea: payload.cropArea,
      startTime: Date.now(),
      isActive: true,
      preferences: { ...preferences }
    };
    await this.persistActiveCaptureSession({
      ...(this.state.activeCaptureSession || {}),
      type: 'recording',
      status: 'recording',
      mode: payload.cropArea ? 'area' : 'full-screen',
      sourceTabId: this.state.currentTabId,
      startedAt: this.state.startedAt,
      cropArea: payload.cropArea,
      view: payload.view,
      preferences: { ...preferences },
    });

    await this.notifyPonsLinkCaptureHost(streamId);

    console.log('✅ [ServiceWorker] Recording session saved:', this.state.recordingSession);

    return { streamId };
  }

  async forwardStats(data) {
    if (this.state.currentTabId) {
      // ✅ 탭이 존재하는지 먼저 확인
      try {
        const tab = await chrome.tabs.get(this.state.currentTabId);
        if (!tab?.id) {
          console.warn('[ServiceWorker] Tab does not exist, cannot forward stats');
          return { success: false };
        }
      } catch (e) {
        console.warn('[ServiceWorker] Tab check failed:', e);
        return { success: false };
      }

      // ✅ Stats 전송
      const result = await SafeChrome.sendTabMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.UPDATE_DOCK_STATS,
        data
      });

      if (!result.success) {
        console.warn('[ServiceWorker] Failed to forward stats:', result.error);
      }

      return result;
    }
    return { success: false };
  }

  async stopCmd() {
    console.log('🛑 [ServiceWorker] stopCmd called');
    const shareHost = this.state.ponsLinkShareSession?.host;
    if (isValidPonsLinkHost(shareHost)) {
      await messageQueue.enqueue(shareHost.tabId, {
        type: MESSAGE_TYPES.CLICKCAP_STREAM_STOPPED,
        data: {
          requestId: shareHost.requestId,
          roomHint: shareHost.roomHint,
          sourceTabId: this.state.currentTabId,
        },
      });
    }
    await this.clearPendingPonsLinkCaptureHost();
    this.state.ponsLinkShareSession = null;
    await this.clearActiveCaptureSession();
    
    // Offscreen에 중지 신호 전송
    await SafeChrome.sendMessage({
      type: MESSAGE_TYPES.STOP_RECORDING,
      target: 'offscreen'
    });
    
    // 상태 업데이트
    this.state.isRecording = false;
    this.state.isPaused = false;

    // ✅ 녹화 세션 종료
    if (this.state.recordingSession) {
      this.state.recordingSession.isActive = false;
      this.state.recordingSession = null; // ✅ 완전히 제거
      console.log('✅ [ServiceWorker] Recording session cleared');
    }
    
    // ✅ Content script에 HIDE_DOCK 전송
    if (this.state.currentTabId) {
      console.log('📤 [ServiceWorker] Sending HIDE_DOCK to tab:', this.state.currentTabId);

      await SafeChrome.sendTabMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.HIDE_DOCK
      });

      // ✅ 추가 대기 후 cleanup
      await new Promise(resolve => setTimeout(resolve, 200));

      await SafeChrome.sendTabMessage(this.state.currentTabId, {
        type: 'cleanup-recording-ui'
      });

      console.log('✅ [ServiceWorker] Cleanup messages sent');
    }
    
    return { success: true };
  }

  async recordingCommand(command) {
    switch (command) {
      case 'pause':
        if (this.state.isPaused) {
          await SafeChrome.sendMessage({
            type: MESSAGE_TYPES.RESUME_RECORDING,
            target: 'offscreen'
          });
          this.state.isPaused = false;
        } else {
          await SafeChrome.sendMessage({
            type: MESSAGE_TYPES.PAUSE_RECORDING,
            target: 'offscreen'
          });
          this.state.isPaused = true;
        }
        if (this.state.activeCaptureSession) {
          await this.persistActiveCaptureSession({
            ...this.state.activeCaptureSession,
            isPaused: this.state.isPaused,
          });
        }
        return { success: true };
        
      case 'stop':
        return this.stopCmd();
        
      case 'cancel':
        await SafeChrome.sendMessage({
          type: MESSAGE_TYPES.CANCEL_RECORDING,
          target: 'offscreen'
        });
        await this.clearPendingPonsLinkCaptureHost();
        this.state.ponsLinkShareSession = null;
        await this.clearActiveCaptureSession();
        
        this.state.isRecording = false;
        this.state.isPaused = false;
        
        if (this.state.currentTabId) {
          await SafeChrome.sendTabMessage(this.state.currentTabId, {
            type: MESSAGE_TYPES.HIDE_DOCK
          });
          
          // Cleanup 신호 전송
          await SafeChrome.sendTabMessage(this.state.currentTabId, {
            type: 'cleanup-recording-ui'
          });
        }
        
        return { success: true };
        
      default:
        return { success: false, error: 'Unknown command' };
    }
  }
}

new ServiceWorkerMain();
