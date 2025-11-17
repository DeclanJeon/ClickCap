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
        await SafeChrome.sendTabMessage(tabId, message);
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
      offscreenReady: false
    };
    this.setup();
    this.setupKeepAlive();
  }

  setup() {
    chrome.runtime.onInstalled.addListener(() => {
      this.init();
    });
    chrome.runtime.onStartup.addListener(() => this.init());

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handle(message).then(sendResponse).catch((e) => {
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
      }
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === 'complete') {
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
  }

  async handle(message) {
    switch (message.type) {
      case MESSAGE_TYPES.CONTENT_SCRIPT_READY:
        return { success: true };
      case MESSAGE_TYPES.OFFSCREEN_READY:
        this.state.offscreenReady = true;
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
        if (this.state.isRecording && this.state.currentTabId) {
          await SafeChrome.sendMessage({ type: MESSAGE_TYPES.UPDATE_PREFS, target: 'offscreen', data: this.state.preferences });
          await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.UPDATE_PREFS, data: this.state.preferences });
          await SafeChrome.sendTabMessage(this.state.currentTabId, {
            type: MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM,
            data: { enabled: !!this.state.preferences.clickElementZoomEnabled }
          });
        }
        return { success: true };
      default:
        return { success: true };
    }
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

  async startCmd({ mode, preferences }) {
    if (this.state.isStarting) {
      return { success: false, error: 'Already starting' };
    }
    this.state.isStarting = true;

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Start recording timeout')), 10000);
    });

    try {
      const result = await Promise.race([
        this.startCmdInternal({ mode, preferences }),
        timeoutPromise
      ]);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      this.state.isStarting = false;
    }
  }

  async startCmdInternal({ mode, preferences }) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    if (String(tab.url).startsWith('chrome://') ||
        String(tab.url).startsWith('chrome-extension://')) {
      throw new Error('Cannot record chrome:// or extension pages');
    }

    this.state.currentTabId = tab.id;
    this.state.preferences = { ...this.state.preferences, ...(preferences || {}) };
    await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.state.preferences);

    const contentScriptReady = await this.ensureContentScript(tab.id);
    if (!contentScriptReady) {
      throw new Error('Content script not ready after retries');
    }

    if (mode === 'area') {
      await SafeChrome.sendTabMessage(tab.id, { type: MESSAGE_TYPES.SHOW_AREA_SELECTOR });
      return { success: true };
    }

    const viewRes = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_VIEW_CONTEXT' }, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });

    const view = viewRes?.data || null;
    await this.startCapture({ cropArea: null, view }, this.state.preferences);

    if (view?.viewportWidth && view?.viewportHeight && this.state.currentTabId) {
      await messageQueue.enqueue(this.state.currentTabId, {
        type: 'set-recording-crop',
        data: { x: 0, y: 0, width: view.viewportWidth, height: view.viewportHeight, isSelecting: false }
      });
    }

    if (this.state.preferences.showDock) {
      await this.showDockWithRetry();
    }

    return { success: true };
  }

  async areaSelected({ cropArea, view }) {
    this.state.cropArea = cropArea;

    await SafeChrome.sendTabMessage(this.state.currentTabId, {
      type: MESSAGE_TYPES.HIDE_AREA_SELECTOR
    });

    const prefs = (await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES))
      || this.state.preferences;

    await messageQueue.enqueue(this.state.currentTabId, {
      type: 'set-recording-crop',
      data: { ...cropArea, isSelecting: false }
    });

    await this.startCapture({ cropArea, view }, prefs);

    if (prefs.showDock) {
      await this.showDockWithRetry();
    }

    return { success: true };
  }

  async showDockWithRetry() {
    if (!this.state.currentTabId) return;
    await messageQueue.enqueue(this.state.currentTabId, { type: MESSAGE_TYPES.SHOW_DOCK });
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
