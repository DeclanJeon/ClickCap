import { MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';

class PopupMain {
  constructor() {
    this.prefs = { ...DEFAULT_PREFERENCES };
    this.startBtn = document.getElementById('startBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.controls = {
      quality: document.getElementById('quality'),
      fps: document.getElementById('fps'),
      format: document.getElementById('format'),
      includeAudio: document.getElementById('includeAudio'),
      showCursor: document.getElementById('showCursor'),
      laserPointer: document.getElementById('laserPointer'),
      zoomHighlight: document.getElementById('zoomHighlight'),
      zoomDuration: document.getElementById('zoomDuration'),
      zoomScale: document.getElementById('zoomScale'),
      showDock: document.getElementById('showDock')
    };
    this.startBtn.addEventListener('click', () => this.start());
    this.stopBtn.addEventListener('click', () => this.stop());
    Object.values(this.controls).forEach((el) => {
      el.addEventListener('change', () => this.onPrefChanged());
    });
    this.init();
  }

  async init() {
    try {
      await storageManager.init();
      const saved = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
      if (saved) this.prefs = { ...this.prefs, ...saved };
      this.syncUI();
    } catch {}
  }

  syncUI() {
    const p = this.prefs;
    this.controls.quality.value = p.quality;
    this.controls.fps.value = String(p.fps);
    this.controls.format.value = p.format;
    this.controls.includeAudio.checked = !!p.includeAudio;
    this.controls.showCursor.checked = !!p.showCursor;
    this.controls.laserPointer.checked = !!p.laserPointerEnabled;
    this.controls.zoomHighlight.checked = !!p.zoomHighlightEnabled;
    this.controls.zoomDuration.value = String(p.zoomHighlightDurationSec || 3);
    this.controls.zoomScale.value = String(p.zoomHighlightScale || 1.2);
    this.controls.showDock.checked = !!p.showDock;
  }

  async onPrefChanged() {
    this.prefs = {
      ...this.prefs,
      quality: this.controls.quality.value,
      fps: parseInt(this.controls.fps.value, 10),
      format: this.controls.format.value,
      includeAudio: this.controls.includeAudio.checked,
      showCursor: this.controls.showCursor.checked,
      laserPointerEnabled: this.controls.laserPointer.checked,
      zoomHighlightEnabled: this.controls.zoomHighlight.checked,
      zoomHighlightDurationSec: parseInt(this.controls.zoomDuration.value, 10),
      zoomHighlightScale: parseFloat(this.controls.zoomScale.value),
      showDock: this.controls.showDock.checked
    };
    await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.prefs);
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.UPDATE_PREFS, data: this.prefs });
  }

  async start() {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'full-screen';
    await this.onPrefChanged();
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.START_RECORDING, data: { mode, preferences: this.prefs } }, (r) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(r);
        });
      });
      if (!res?.success) alert('시작 실패: ' + (res?.error || 'unknown'));
    } catch (e) {
      alert('시작 실패: ' + e.message);
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
      if (!res?.success) alert('정지 실패');
    } catch (e) {
      alert('정지 실패: ' + e.message);
    }
  }
}

new PopupMain();
