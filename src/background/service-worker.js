import { MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';

class SafeChrome {
  static sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(res || { success: true });
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  static sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { success: true });
          }
        });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
  }
}

class ServiceWorkerMain {
  constructor() {
    this.state = {
      currentTabId: null,
      isRecording: false,
      isPaused: false,
      cropArea: null
    };
    this.setup();
  }

  setup() {
    chrome.runtime.onInstalled.addListener(() => this.init());
    chrome.runtime.onStartup.addListener(() => this.init());

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handle(message, sender).then(sendResponse).catch((e) => {
        console.error('[SW] handle error', e);
        sendResponse({ success: false, error: e.message });
      });
      return true;
    });
  }

  async init() {
    await storageManager.init();
    console.log('[Service Worker] Initialization complete');
  }

  async handle(message, sender) {
    switch (message.type) {
      case MESSAGE_TYPES.CONTENT_SCRIPT_READY:
        // noop
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
      default:
        return { success: true };
    }
  }

  async ensureContentScript(tabId) {
    const ping = await SafeChrome.sendTabMessage(tabId, { type: 'ping' });
    if (ping?.success) return true;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content-script.js'] });
    await new Promise((r) => setTimeout(r, 300));
    const ping2 = await SafeChrome.sendTabMessage(tabId, { type: 'ping' });
    return ping2?.success;
  }

  async ensureOffscreen() {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Screen recording'
      });
    }
  }

  async startCmd({ mode, preferences }) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };
    if (String(tab.url).startsWith('chrome://') || String(tab.url).startsWith('chrome-extension://')) {
      return { success: false, error: 'Cannot record chrome:// or extension pages' };
    }

    this.state.currentTabId = tab.id;

    const ok = await this.ensureContentScript(tab.id);
    if (!ok) return { success: false, error: 'Content script not ready' };

    if (mode === 'area') {
      await SafeChrome.sendTabMessage(tab.id, { type: MESSAGE_TYPES.SHOW_AREA_SELECTOR });
    } else {
      await this.startCapture(null, preferences);
      await this.showDockWithRetry();
    }
    return { success: true };
  }

  async areaSelected({ cropArea }) {
    this.state.cropArea = cropArea;
    await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.HIDE_AREA_SELECTOR });
    const prefs = (await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES)) || DEFAULT_PREFERENCES;
    await this.startCapture(cropArea, prefs);
    await this.showDockWithRetry();
    return { success: true };
  }

  async showDockWithRetry() {
    if (!this.state.currentTabId) return;
    for (let i = 0; i < 5; i++) {
      const res = await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.SHOW_DOCK });
      if (res?.success) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async startCapture(cropArea, preferences) {
    await this.ensureOffscreen();
    await new Promise((r) => setTimeout(r, 200));
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: this.state.currentTabId });

    const res = await SafeChrome.sendMessage({
      type: MESSAGE_TYPES.START_RECORDING,
      target: 'offscreen',
      data: { streamId, cropArea, preferences }
    });

    if (!res?.success) throw new Error(res?.error || 'Offscreen failed');
    this.state.isRecording = true;
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
    if (this.state.currentTabId) {
      await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.HIDE_DOCK });
    }
    return { success: true };
  }

  async recordingCommand(command) {
    switch (command) {
      case 'pause':
        if (this.state.isPaused) {
          await SafeChrome.sendMessage({ type: 'resume-recording', target: 'offscreen' });
          this.state.isPaused = false;
        } else {
          await SafeChrome.sendMessage({ type: 'pause-recording', target: 'offscreen' });
          this.state.isPaused = true;
        }
        return { success: true };
      case 'stop':
        return this.stopCmd();
      default:
        return { success: false, error: 'Unknown command' };
    }
  }
}

new ServiceWorkerMain();
console.log('[Service Worker] Loaded and ready');
