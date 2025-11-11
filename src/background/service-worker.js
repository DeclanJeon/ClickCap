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
      cropArea: null,
      preferences: { ...DEFAULT_PREFERENCES },
      startedAt: 0
    };
    this.setup();
  }

  setup() {
    chrome.runtime.onInstalled.addListener(() => this.init());
    chrome.runtime.onStartup.addListener(() => this.init());

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handle(message, sender).then(sendResponse).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
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

      default:
        return { success: true };
    }
  }

  async ensureContentScript(tabId) {
    const ping = await SafeChrome.sendTabMessage(tabId, { type: 'ping' });
    if (ping?.success) return true;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content-script.js'] });
    await new Promise((r) => setTimeout(r, 200));
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
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async startCmd({ mode, preferences }) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };
    if (String(tab.url).startsWith('chrome://') || String(tab.url).startsWith('chrome-extension://')) {
      return { success: false, error: 'Cannot record chrome:// or extension pages' };
    }
    this.state.currentTabId = tab.id;
    this.state.preferences = { ...this.state.preferences, ...(preferences || {}) };
    await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.state.preferences);

    const ok = await this.ensureContentScript(tab.id);
    if (!ok) return { success: false, error: 'Content script not ready' };

    if (mode === 'area') {
      await SafeChrome.sendTabMessage(tab.id, { type: MESSAGE_TYPES.SHOW_AREA_SELECTOR });
    } else {
      await this.startCapture(null, this.state.preferences);
      if (this.state.preferences.showDock) await this.showDockWithRetry();
    }
    return { success: true };
  }

  async areaSelected({ cropArea }) {
    this.state.cropArea = cropArea;
    await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.HIDE_AREA_SELECTOR });
    const prefs = (await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES)) || this.state.preferences;
    await this.startCapture(cropArea, prefs);
    if (prefs.showDock) await this.showDockWithRetry();
    await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.SHOW_DOCK });
    return { success: true };
  }

  async showDockWithRetry() {
    if (!this.state.currentTabId) return;
    for (let i = 0; i < 8; i++) {
      const res = await SafeChrome.sendTabMessage(this.state.currentTabId, { type: MESSAGE_TYPES.SHOW_DOCK });
      if (res?.success) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async startCapture(cropArea, preferences) {
    await this.ensureOffscreen();
    await new Promise((r) => setTimeout(r, 100));
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: this.state.currentTabId });

    const res = await SafeChrome.sendMessage({
      type: MESSAGE_TYPES.START_RECORDING,
      target: 'offscreen',
      data: { streamId, cropArea, preferences }
    });
    if (!res?.success) throw new Error(res?.error || 'Offscreen failed');
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
