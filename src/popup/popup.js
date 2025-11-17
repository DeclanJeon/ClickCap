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
      includeAudio: document.getElementById('includeAudio'),
      showDock: document.getElementById('showDock'),
      clickElementZoom: document.getElementById('clickElementZoom'),
      elementZoomScale: document.getElementById('elementZoomScale'),
      elementZoomDuration: document.getElementById('elementZoomDuration')
    };

    this.startBtn.addEventListener('click', () => this.start());
    this.stopBtn.addEventListener('click', () => this.stop());

    Object.values(this.controls).forEach((el) => {
      if (el) {
        el.addEventListener('change', () => this.onPrefChanged());
      }
    });

    this.init();
  }

  async init() {
    try {
      await storageManager.init();
      const saved = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
      if (saved) this.prefs = { ...this.prefs, ...saved };
      this.syncUI();
    } catch (e) {
      console.error('[Popup] Initialization error:', e);
    }
  }

  syncUI() {
    const p = this.prefs;
    this.controls.quality.value = p.quality || 'HIGH';
    this.controls.fps.value = String(p.fps || 30);
    this.controls.includeAudio.checked = !!p.includeAudio;
    this.controls.showDock.checked = p.showDock !== false;
    this.controls.clickElementZoom.checked = !!p.clickElementZoomEnabled;
    this.controls.elementZoomScale.value = String(p.elementZoomScale || 1.5);
    this.controls.elementZoomDuration.value = String(p.elementZoomDuration || 800);
  }

  async onPrefChanged() {
    this.prefs = {
      ...this.prefs,
      quality: this.controls.quality.value,
      fps: parseInt(this.controls.fps.value, 10),
      includeAudio: this.controls.includeAudio.checked,
      showDock: this.controls.showDock.checked,
      clickElementZoomEnabled: this.controls.clickElementZoom.checked,
      elementZoomScale: parseFloat(this.controls.elementZoomScale.value),
      elementZoomDuration: parseInt(this.controls.elementZoomDuration.value, 10)
    };

    await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.prefs);

    try {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.UPDATE_PREFS, data: this.prefs });
    } catch (e) {
      console.warn('[Popup] Failed to send prefs update:', e);
    }
  }

  async start() {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'full-screen';
    await this.onPrefChanged();

    this.startBtn.disabled = true;
    this.startBtn.textContent = '시작 중...';

    let currentTab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tabs[0];
      if (!currentTab) {
        throw new Error('활성 탭을 찾을 수 없습니다.');
      }
      if (currentTab.url.startsWith('chrome://') ||
          currentTab.url.startsWith('chrome-extension://') ||
          currentTab.url.startsWith('edge://')) {
        throw new Error('이 페이지는 녹화할 수 없습니다.');
      }
    } catch (e) {
      alert(`녹화 시작 실패:\n\n${e.message}`);
      this.startBtn.disabled = false;
      this.startBtn.textContent = '녹화 시작';
      return;
    }

    try {
      const res = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('녹화 시작 타임아웃 (10초)'));
        }, 10000);

        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.START_RECORDING,
          data: { mode, preferences: this.prefs }
        }, (r) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(r);
          }
        });
      });

      if (!res?.success) {
        throw new Error(res?.error || '알 수 없는 오류');
      }

      this.startBtn.classList.add('hidden');
      this.stopBtn.classList.remove('hidden');
    } catch (e) {
      alert(`녹화 시작 실패:\n\n${e.message}`);
    } finally {
      this.startBtn.disabled = false;
      this.startBtn.textContent = '녹화 시작';
    }
  }

  async stop() {
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.STOP_RECORDING }, (r) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(r);
          }
        });
      });

      if (!res?.success) {
        alert('녹화 종료 실패: ' + (res?.error || '알 수 없는 오류'));
      } else {
        alert('녹화가 종료되었습니다. 파일이 곧 다운로드됩니다.');
      }
    } catch (e) {
      alert('녹화 종료 실패: ' + e.message);
    } finally {
      this.startBtn.classList.remove('hidden');
      this.stopBtn.classList.add('hidden');
    }
  }
}

new PopupMain();
