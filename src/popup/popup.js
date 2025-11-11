import { MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';

class PopupMain {
  constructor() {
    this.prefs = { ...DEFAULT_PREFERENCES };
    this.startBtn = document.getElementById('startBtn');
    this.stopBtn = document.getElementById('stopBtn');

    this.startBtn.addEventListener('click', () => this.start());
    this.stopBtn.addEventListener('click', () => this.stop());

    this.init();
  }

  async init() {
    try {
      await storageManager.init();
      const saved = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
      if (saved) this.prefs = { ...this.prefs, ...saved };
    } catch (e) {
      console.warn('[Popup] init storage error:', e.message);
    }
  }

  async start() {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'full-screen';
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: MESSAGE_TYPES.START_RECORDING, data: { mode, preferences: this.prefs } },
          (r) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            resolve(r);
          }
        );
      });
      if (!res?.success) {
        alert('녹화 시작 실패: ' + (res?.error || 'unknown'));
      }
    } catch (e) {
      alert('녹화 시작 에러: ' + e.message);
    }
  }

  async stop() {
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.STOP_RECORDING }, (r) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(r);
        });
      });
      if (!res?.success) alert('녹화 중지 실패');
    } catch (e) {
      alert('녹화 중지 에러: ' + e.message);
    }
  }
}

new PopupMain();