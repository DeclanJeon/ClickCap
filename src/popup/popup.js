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
      showDock: document.getElementById('showDock'),
      gifFps: document.getElementById('gifFps'),
      gifQuality: document.getElementById('gifQuality'),
      gifDither: document.getElementById('gifDither'),
      clickElementZoom: document.getElementById('clickElementZoom'),
      elementZoomScale: document.getElementById('elementZoomScale'),
      elementZoomDuration: document.getElementById('elementZoomDuration')
    };
    
    this.webmOptions = document.getElementById('webmOptions');
    this.gifOptions = document.getElementById('gifOptions');
    
    this.startBtn.addEventListener('click', () => this.start());
    this.stopBtn.addEventListener('click', () => this.stop());
    
    // 포맷 변경 시 옵션 표시/숨김
    this.controls.format.addEventListener('change', () => {
      this.toggleFormatOptions();
      this.onPrefChanged();
    });
    
    // 모든 컨트롤에 이벤트 리스너 추가
    Object.values(this.controls).forEach((el) => {
      if (el && el !== this.controls.format) {
        el.addEventListener('change', () => this.onPrefChanged());
      }
    });
    
    // 인코딩 진행률 메시지 수신
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'gif-encoding-progress') {
        this.updateEncodingProgress(message.data.progress);
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
      this.toggleFormatOptions();
    } catch (e) {
      console.error('[Popup] Initialization error:', e);
    }
  }

  toggleFormatOptions() {
    const isGif = this.controls.format.value === 'GIF';
    
    // 옵션 섹션 표시/숨김
    if (isGif) {
      this.webmOptions.classList.add('hidden');
      this.gifOptions.classList.remove('hidden');
    } else {
      this.webmOptions.classList.remove('hidden');
      this.gifOptions.classList.add('hidden');
    }
    
    // GIF 선택 시 오디오 옵션 비활성화
    if (isGif) {
      this.controls.includeAudio.checked = false;
      this.controls.includeAudio.disabled = true;
      this.controls.includeAudio.parentElement.style.opacity = '0.5';
    } else {
      this.controls.includeAudio.disabled = false;
      this.controls.includeAudio.parentElement.style.opacity = '1';
    }
  }

  syncUI() {
    const p = this.prefs;
    this.controls.quality.value = p.quality || 'HIGH';
    this.controls.fps.value = String(p.fps || 30);
    this.controls.format.value = p.format || 'WEBM';
    this.controls.includeAudio.checked = !!p.includeAudio;
    this.controls.showCursor.checked = !!p.showCursor;
    this.controls.laserPointer.checked = !!p.laserPointerEnabled;
    this.controls.zoomHighlight.checked = !!p.zoomHighlightEnabled;
    this.controls.zoomDuration.value = String(p.zoomHighlightDurationSec || 3);
    this.controls.zoomScale.value = String(p.zoomHighlightScale || 1.2);
    this.controls.showDock.checked = p.showDock !== false;
    
    // 새로 추가: 클릭 요소 줌 효과 설정
    this.controls.clickElementZoom.checked = !!p.clickElementZoomEnabled;
    this.controls.elementZoomScale.value = String(p.elementZoomScale || 1.5);
    this.controls.elementZoomDuration.value = String(p.elementZoomDuration || 800);
    
    if (this.controls.gifFps) {
      this.controls.gifFps.value = String(p.gifFps || 10);
    }
    if (this.controls.gifQuality) {
      this.controls.gifQuality.value = String(p.gifQuality || 10);
    }
    if (this.controls.gifDither) {
      this.controls.gifDither.checked = !!p.gifDither;
    }
  }

  async onPrefChanged() {
    const isGif = this.controls.format.value === 'GIF';
    
    this.prefs = {
      ...this.prefs,
      quality: this.controls.quality.value,
      fps: parseInt(this.controls.fps.value, 10),
      format: this.controls.format.value,
      includeAudio: this.controls.includeAudio.checked && !isGif,
      showCursor: this.controls.showCursor.checked,
      laserPointerEnabled: this.controls.laserPointer.checked,
      zoomHighlightEnabled: this.controls.zoomHighlight.checked,
      zoomHighlightDurationSec: parseInt(this.controls.zoomDuration.value, 10),
      zoomHighlightScale: parseFloat(this.controls.zoomScale.value),
      showDock: this.controls.showDock.checked,
      gifFps: this.controls.gifFps ? parseInt(this.controls.gifFps.value, 10) : 10,
      gifQuality: this.controls.gifQuality ? parseInt(this.controls.gifQuality.value, 10) : 10,
      gifDither: this.controls.gifDither ? this.controls.gifDither.checked : false,
      
      // 새로 추가: 클릭 요소 줌 효과 설정
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
    
    // GIF 포맷 경고
    if (this.prefs.format === 'GIF') {
      const warnings = [
        '⚠️ GIF 포맷 주의사항:',
        '',
        '• 오디오가 녹음되지 않습니다',
        '• 256색으로 제한되어 화질이 저하됩니다',
        '• 최대 60초까지 녹화 가능합니다',
        '• 인코딩에 시간이 걸릴 수 있습니다',
        '',
        '계속 진행하시겠습니까?'
      ].join('\n');
      
      const confirmed = confirm(warnings);
      if (!confirmed) return;
    }
    
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ 
          type: MESSAGE_TYPES.START_RECORDING, 
          data: { mode, preferences: this.prefs } 
        }, (r) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(r);
          }
        });
      });
      
      if (!res?.success) {
        alert('녹화 시작 실패: ' + (res?.error || '알 수 없는 오류'));
      }
    } catch (e) {
      console.error('[Popup] Start recording error:', e);
      alert('녹화 시작 오류: ' + e.message);
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
      
      if (this.prefs.format === 'GIF') {
        alert(
          'GIF 인코딩 중입니다...\n\n' +
          '완료되면 자동으로 다운로드됩니다.\n' +
          '브라우저를 닫지 마세요.'
        );
      }
      
      if (!res?.success) {
        alert('녹화 중지 실패: ' + (res?.error || '알 수 없는 오류'));
      }
    } catch (e) {
      console.error('[Popup] Stop recording error:', e);
      alert('녹화 중지 오류: ' + e.message);
    }
  }

  updateEncodingProgress(progress) {
    // 향후 진행률 표시 UI 업데이트
    console.log('[Popup] GIF encoding progress:', progress + '%');
  }
}

new PopupMain();
