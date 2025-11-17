import { MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';

class PopupMain {
  constructor() {
    this.prefs = { ...DEFAULT_PREFERENCES };
    this.startBtn = document.getElementById('startBtn');
    this.stopBtn = document.getElementById('stopBtn');

    this.controls = {
      format: document.getElementById('format'),
      quality: document.getElementById('quality'),
      fps: document.getElementById('fps'),
      gifQuality: document.getElementById('gifQuality'),
      gifMaxWidth: document.getElementById('gifMaxWidth'),
      includeAudio: document.getElementById('includeAudio'),
      showDock: document.getElementById('showDock')
    };

    this.groups = {
      quality: document.getElementById('qualityGroup'),
      audio: document.getElementById('audioGroup'),
      gifQuality: document.getElementById('gifQualityGroup'),
      gifSize: document.getElementById('gifSizeGroup')
    };

    this.startBtn.addEventListener('click', () => this.start());
    this.stopBtn.addEventListener('click', () => this.stop());

    // 포맷 변경 시 UI 업데이트
    this.controls.format.addEventListener('change', () => this.updateUIForFormat());

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
    this.controls.format.value = p.format || 'webm';
    this.controls.quality.value = p.quality || 'HIGH';
    this.controls.fps.value = String(p.fps || 30);
    this.controls.gifQuality.value = String(p.gifQuality || 10);
    this.controls.gifMaxWidth.value = String(p.gifMaxWidth || 480);
    this.controls.includeAudio.checked = p.includeAudio !== false;
    this.controls.showDock.checked = p.showDock !== false;
    this.updateUIForFormat();
  }

  updateUIForFormat() {
    const format = this.controls.format.value;
    const isGif = format === 'gif';

    if (isGif) {
      // GIF 모드
      this.groups.quality.style.display = 'none';
      this.groups.audio.style.display = 'none';
      this.groups.gifQuality.style.display = 'block';
      this.groups.gifSize.style.display = 'block';
      
      // GIF는 낮은 FPS 권장
      if (parseInt(this.controls.fps.value) > 15) {
        this.controls.fps.value = '10';
      }
    } else {
      // WebM 모드
      this.groups.quality.style.display = 'block';
      this.groups.audio.style.display = 'block';
      this.groups.gifQuality.style.display = 'none';
      this.groups.gifSize.style.display = 'none';
    }

    this.onPrefChanged();
  }

  async onPrefChanged() {
    this.prefs = {
      ...this.prefs,
      format: this.controls.format.value,
      quality: this.controls.quality.value,
      fps: parseInt(this.controls.fps.value, 10),
      gifQuality: parseInt(this.controls.gifQuality.value, 10),
      gifMaxWidth: parseInt(this.controls.gifMaxWidth.value, 10),
      includeAudio: this.controls.includeAudio.checked,
      showDock: this.controls.showDock.checked
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
          reject(new Error('녹화 시작 시간 초과 (10초)'));
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
        throw new Error(res?.error || '녹화 시작 실패');
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
        alert('녹화 중지 실패: ' + (res?.error || '알 수 없는 오류'));
      } else {
        const format = this.prefs.format === 'gif' ? 'GIF' : 'WebM';
        alert(`녹화가 완료되었습니다. ${format} 파일이 다운로드됩니다.`);
      }
    } catch (e) {
      alert('녹화 중지 실패: ' + e.message);
    } finally {
      this.startBtn.classList.remove('hidden');
      this.stopBtn.classList.add('hidden');
    }
  }
}

new PopupMain();
