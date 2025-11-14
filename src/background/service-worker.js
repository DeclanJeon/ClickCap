import { MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';

class SafeChrome {
  static async sendMessage(message, retries = 3) {
    console.log('[SafeChrome] sendMessage:', message.type, 'target:', message.target);

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

        console.log('[SafeChrome] sendMessage success:', message.type);
        return res;
      } catch (e) {
        console.warn(`[SafeChrome] sendMessage attempt ${i + 1} failed, retrying...`, e.message);
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 200 * (i + 1))); // 지수적 백오프
        }
      }
    }

    console.error('[SafeChrome] sendMessage failed after retries:', message.type);
    return { success: false, error: 'Receiving end does not exist' };
  }

  // 새로운 메소드: offscreen 문서가 준비되었는지 확인
  static async ensureOffscreenReady() {
    try {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx.length === 0) {
        return false;
      }
      
      // offscreen가 준비되었는지 ping 테스트
      const pingRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'ping', target: 'offscreen' }, (response) => {
          resolve(response);
        });
      });
      
      return pingRes?.success || false;
    } catch (e) {
      console.warn('[SafeChrome] Offscreen not ready:', e.message);
      return false;
    }
  }

  static async sendTabMessage(tabId, message, retries = 3) {
    console.log('[SafeChrome] sendTabMessage:', message.type, 'to tab:', tabId);

    for (let i = 0; i < retries; i++) {
      try {
        const res = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(response || { success: true });
            }
          });
        });

        console.log('[SafeChrome] sendTabMessage success:', message.type);
        return res;
      } catch (e) {
        console.warn(`[SafeChrome] sendTabMessage attempt ${i + 1} failed, retrying...`, e.message);
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 200 * (i + 1)));
        }
      }
    }

    console.error('[SafeChrome] sendTabMessage failed after retries:', message.type);
    return { success: false, error: 'Receiving end does not exist' };
  }
}

// 메시지 큐 시스템 구현
class MessageQueue {
  constructor() {
    this.queues = new Map(); // tabId -> message[]
    this.processing = new Set(); // tabId -> boolean
  }

  async enqueue(tabId, message) {
    if (!this.queues.has(tabId)) {
      this.queues.set(tabId, []);
    }
    
    this.queues.get(tabId).push(message);
    
    // 이미 처리 중이 아니면 큐 처리 시작
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
        // 탭이 존재하는지 확인
        if (!(await tabExists(tabId))) {
          console.warn(`[MessageQueue] Tab ${tabId} no longer exists, discarding messages`);
          break;
        }
        
        // content script가 준비되었는지 확인
        const isReady = await this.pingContentScript(tabId);
        if (!isReady) {
          console.warn(`[MessageQueue] Content script not ready for tab ${tabId}, retrying later`);
          queue.unshift(message); // 메시지를 다시 큐에 넣음
          setTimeout(() => this.processQueue(tabId), 500);
          break;
        }
        
        // 메시지 전송
        await SafeChrome.sendTabMessage(tabId, message);
        console.log(`[MessageQueue] Successfully sent message to tab ${tabId}:`, message.type);
        
      } catch (error) {
        console.error(`[MessageQueue] Failed to send message to tab ${tabId}:`, error);
        
        // 마지막 메시지가 아니면 재시도
        if (queue.length > 0) {
          queue.unshift(message); // 실패한 메시지를 다시 큐에 넣음
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
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(response);
          }
        });
      });
      return response?.success === true;
    } catch (error) {
      return false;
    }
  }

  clear(tabId) {
    this.queues.delete(tabId);
    this.processing.delete(tabId);
  }
}

// 전역 메시지 큐 인스턴스
const messageQueue = new MessageQueue();

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
      isStarting: false // 중복 호출 방지 플래그
    };
    this.setup();
  }

  setup() {
    chrome.runtime.onInstalled.addListener(() => this.init());
    chrome.runtime.onStartup.addListener(() => this.init());
    
    // 전역 에러 핸들러 설정
    this.setupGlobalErrorHandlers();
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handle(message, sender).then(sendResponse).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    });
    
    // 탭 상태 모니터링
    chrome.tabs.onRemoved.addListener((tabId) => {
      console.log(`[SW] Tab ${tabId} removed, clearing message queue`);
      messageQueue.clear(tabId);
    });
    
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete') {
        console.log(`[SW] Tab ${tabId} updated, processing message queue`);
        setTimeout(() => messageQueue.processQueue(tabId), 100);
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
      } else if (command === 'toggle-laser') {
        await SafeChrome.sendMessage({ type: MESSAGE_TYPES.TOGGLE_LASER, target: 'offscreen' });
      }
    });
  }

  setupGlobalErrorHandlers() {
    // chrome.tabs.sendMessage 전역 에러 핸들러
    const originalSendTabMessage = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = function(tabId, message, callback) {
      if (typeof callback === 'function') {
        const originalCallback = callback;
        callback = function(response) {
          if (chrome.runtime.lastError) {
            console.warn(`[SW] Suppressed tab message error:`, chrome.runtime.lastError.message);
            return;
          }
          originalCallback(response);
        };
      }
      return originalSendTabMessage.call(chrome.tabs, tabId, message, callback);
    };

    // chrome.runtime.sendMessage 전역 에러 핸들러
    const originalSendRuntimeMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, callback) {
      if (typeof callback === 'function') {
        const originalCallback = callback;
        callback = function(response) {
          if (chrome.runtime.lastError) {
            console.warn(`[SW] Suppressed runtime message error:`, chrome.runtime.lastError.message);
            return;
          }
          originalCallback(response);
        };
      }
      return originalSendRuntimeMessage.call(chrome.runtime, message, callback);
    };
  }

  async init() {
    await storageManager.init();
    const saved = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
    if (saved) this.state.preferences = { ...this.state.preferences, ...saved };
  }

  async handle(message) {
    switch (message.type) {
      case MESSAGE_TYPES.CONTENT_SCRIPT_READY:
        return { success: true };
      case MESSAGE_TYPES.START_RECORDING:
        return this.startCmd(message.data);
      case MESSAGE_TYPES.AREA_SELECTED:
        return this.areaSelected(message.data);
      case MESSAGE_TYPES.OFFSCREEN_READY:
        return { success: true };
      case MESSAGE_TYPES.RECORDING_STATS:
        return this.forwardStats(message.data);
      case MESSAGE_TYPES.STOP_RECORDING:
        return this.stopCmd();
      case MESSAGE_TYPES.RECORDING_COMMAND:
        return this.recordingCommand(message.command);
      case MESSAGE_TYPES.UPDATE_PREFS:
        this.state.preferences = { ...this.state.preferences, ...(message.data || {}) };
        await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.state.preferences);
        if (this.state.isRecording) {
          await SafeChrome.sendMessage({ type: MESSAGE_TYPES.UPDATE_PREFS, target: 'offscreen', data: this.state.preferences });
        }
        return { success: true };

      // ✅ 새로운 라우팅 추가
      case 'set-recording-crop':
        if (message.target === 'content') {
          // Offscreen에서 온 메시지를 ContentScript로 포워딩
          console.log('[ServiceWorker] Forwarding crop to ContentScript');
          return await SafeChrome.sendTabMessage(
            this.state.currentTabId,
            {
              type: 'set-recording-crop',
              data: message.data
            }
          );
        }
        return { success: true };

      // ✅ 기타 메시지도 라우팅
      case MESSAGE_TYPES.LASER_MOVED:
        return await SafeChrome.sendMessage({
          type: MESSAGE_TYPES.LASER_MOVED,
          target: 'offscreen',
          data: message.data
        });

      case MESSAGE_TYPES.VIEWPORT_INFO:
        try {
          await this.ensureOffscreen();
          // offscreen가 준비되었는지 확인
          const isReady = await SafeChrome.ensureOffscreenReady();
          if (!isReady) {
            console.warn('[SW] Offscreen not ready for VIEWPORT_INFO');
            return { success: false, error: 'Offscreen not ready' };
          }
        } catch (e) {
          console.warn('[SW] Failed to ensure offscreen for VIEWPORT_INFO:', e);
          return { success: false, error: 'Failed to ensure offscreen' };
        }
        return await SafeChrome.sendMessage({
          type: MESSAGE_TYPES.VIEWPORT_INFO,
          target: 'offscreen',
          data: message.data
        });

      case MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM:
        if (message.target === 'offscreen') {
          // offscreen가 준비되었는지 확인
          const isReady = await SafeChrome.ensureOffscreenReady();
          if (!isReady) {
            console.warn('[SW] Offscreen not ready for TOGGLE_ELEMENT_ZOOM');
            return { success: false, error: 'Offscreen not ready' };
          }
          
          return await SafeChrome.sendMessage({
            type: MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM,
            target: 'offscreen',
            data: message.data
          });
        } else if (message.target === 'content') {
          return await SafeChrome.sendTabMessage(
            this.state.currentTabId,
            {
              type: MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM,
              data: message.data
            }
          );
        }
        return { success: true };

      default:
        return { success: true };
    }
  }

  async ensureContentScript(tabId) {
    console.log('[SW] Ensuring ContentScript for tab:', tabId);

    if (!(await tabExists(tabId))) {
      console.error('[SW] Tab does not exist:', tabId);
      return false;
    }

    const ping = () => new Promise((res) => {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'ping' }, (r) => {
          res(!!(r && r.success));
        });
      } catch {
        res(false);
      }
    });

    // 초기 체크
    for (let i = 0; i < 5; i++) {
      const ok = await ping();
      if (ok) {
        console.log('[SW] ContentScript already ready');
        return true;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // ContentScript 주입
    try {
      console.log('[SW] Injecting ContentScript...');
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content-script.js'] });
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error('[SW] Failed to inject ContentScript:', e);
      return false;
    }

    // 주입 후 확인
    for (let i = 0; i < 10; i++) {
      const ok = await ping();
      if (ok) {
        console.log('[SW] ContentScript successfully injected and ready');
        return true;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    console.error('[SW] ensureContentScript failed after retries');
    return false;
  }

  async ensureOffscreen() {
    console.log('[SW] Ensuring Offscreen document...');
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length === 0) {
      console.log('[SW] Creating Offscreen document...');
      try {
        await chrome.offscreen.createDocument({
          url: 'src/offscreen/offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: 'Screen recording'
        });
        await new Promise((r) => setTimeout(r, 300));
        console.log('[SW] Offscreen document created successfully');
      } catch (e) {
        console.error('[SW] Failed to create Offscreen document:', e);
        throw e;
      }
    } else {
      console.log('[SW] Offscreen document already exists');
    }
  }

  async startCmd({ mode, preferences }) {
    console.log('[SW] startCmd called with mode:', mode);
    
    // 중복 호출 방지
    if (this.state.isStarting) {
      console.warn('[SW] startCmd already in progress, ignoring');
      return { success: false, error: 'Already starting' };
    }
    
    this.state.isStarting = true;
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        this.state.isStarting = false;
        return { success: false, error: 'No active tab' };
      }
      
      if (String(tab.url).startsWith('chrome://') || String(tab.url).startsWith('chrome-extension://')) {
        this.state.isStarting = false;
        return { success: false, error: 'Cannot record chrome:// or extension pages' };
      }

      this.state.currentTabId = tab.id;
      this.state.preferences = { ...this.state.preferences, ...(preferences || {}) };
      await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.state.preferences);

      // ContentScript 준비 보장 (강화된 버전)
      const contentScriptReady = await this.ensureContentScript(tab.id);
      if (!contentScriptReady) {
        console.error(`[SW] Failed to ensure content script for tab ${tab.id}`);
        this.state.isStarting = false;
        return { success: false, error: 'Content script not ready' };
      }

      if (mode === 'area') {
        console.log('[SW] Showing area selector');
        await SafeChrome.sendTabMessage(tab.id, { type: MESSAGE_TYPES.SHOW_AREA_SELECTOR });
        this.state.isStarting = false;
        return { success: true };
      }

      // full-screen: viewCtx 요청 후 0,0,w,h 보냄
      console.log('[SW] Requesting view context for full-screen mode');
      const viewRes = await new Promise((resolve) => {
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_VIEW_CONTEXT' }, (r) => {
            resolve(r);
          });
        } catch (e) {
          console.error('[SW] Failed to request view context:', e);
          resolve(null);
        }
      });

      const view = viewRes?.data || null;
      if (!view) {
        console.error('[SW] No view context received for full-screen mode');
      }

      console.log('[SW] Starting full-screen capture with view:', view);
      await this.startCapture({ cropArea: null, view }, this.state.preferences);
      if (this.state.preferences.showDock) await this.showDockWithRetry();
      
      this.state.isStarting = false;
      return { success: true };
      
    } catch (error) {
      console.error('[SW] Error in startCmd:', error);
      this.state.isStarting = false;
      return { success: false, error: error.message };
    }
  }

  async areaSelected({ cropArea, view }) {
    console.log('[SW] areaSelected called with:', { cropArea, view });

    this.state.cropArea = cropArea;

    // Step 1: AreaSelector 제거
    await SafeChrome.sendTabMessage(this.state.currentTabId, {
      type: MESSAGE_TYPES.HIDE_AREA_SELECTOR
    });

    console.log('[SW] Starting area capture with crop and view:', { cropArea, view });

    const prefs = (await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES))
      || this.state.preferences;

    // Step 2: ContentScript에 먼저 표시 (녹화 전) - 메시지 큐 사용
    await messageQueue.enqueue(this.state.currentTabId, {
      type: 'set-recording-crop',
      data: { ...cropArea, isSelecting:false }
    });

    // Step 3: 실제 녹화 시작
    await this.startCapture({ cropArea, view }, prefs);

    // Step 4: Dock 표시 (녹화 시작 후)
    if (prefs.showDock) {
      console.log('[SW] Showing dock after recording started');
      await this.showDockWithRetry();
    }

    // Step 5: 최종 확인
    console.log('[SW] areaSelected completed successfully');
    return { success: true };
  }

  async showDockWithRetry() {
    if (!this.state.currentTabId) {
      console.error('[SW] showDockWithRetry: no currentTabId');
      return;
    }

    console.log('[SW] showDockWithRetry: attempting to show dock');

    // 메시지 큐를 통한 안전한 전송
    await messageQueue.enqueue(this.state.currentTabId, {
      type: MESSAGE_TYPES.SHOW_DOCK
    });
    
    console.log('[SW] Dock message queued for delivery');
  }

  async startCapture(payload, preferences) {
    console.log('[SW] startCapture called with payload:', payload);
    await this.ensureOffscreen();
    await new Promise((r) => setTimeout(r, 100));

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: this.state.currentTabId });
    console.log('[SW] Got streamId:', streamId);

    // Offscreen에 CSS crop과 viewCtx 같이 보냄
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
      console.error('[SW] Offscreen failed:', res?.error);
      throw new Error(res?.error || 'Offscreen failed');
    }

    this.state.isRecording = true;
    this.state.isPaused = false;
    this.state.startedAt = Date.now();
    console.log('[SW] Recording started successfully');
  }

  async forwardStats(data) {
    if (this.state.currentTabId) {
      await SafeChrome.sendTabMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.UPDATE_DOCK_STATS,
        data
      });
    }
    return { success: true };
  }

  async stopCmd() {
    await SafeChrome.sendMessage({ type: MESSAGE_TYPES.STOP_RECORDING, target: 'offscreen' });
    this.state.isRecording = false;
    this.state.isPaused = false;
    if (this.state.currentTabId) {
      await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.HIDE_DOCK });
    }
    return { success: true };
  }

  async recordingCommand(command) {
    switch (command) {
      case 'pause':
        if (this.state.isPaused) {
          await SafeChrome.sendMessage({ type: MESSAGE_TYPES.RESUME_RECORDING, target: 'offscreen' });
          this.state.isPaused = false;
        } else {
          await SafeChrome.sendMessage({ type: MESSAGE_TYPES.PAUSE_RECORDING, target: 'offscreen' });
          this.state.isPaused = true;
        }
        return { success: true };
      case 'stop':
        return this.stopCmd();
      case 'cancel':
        await SafeChrome.sendMessage({ type: MESSAGE_TYPES.CANCEL_RECORDING, target: 'offscreen' });
        this.state.isRecording = false;
        this.state.isPaused = false;
        if (this.state.currentTabId) {
          await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.HIDE_DOCK });
        }
        return { success: true };
      default:
        return { success: false, error: 'Unknown command' };
    }
  }
}

new ServiceWorkerMain();
