import { MESSAGE_TYPES, STORAGE_KEYS, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';

class PopupMain {
  constructor() {
    this.prefs = { ...DEFAULT_PREFERENCES };
    this.activeTabId = null;
    this.activeTabUrl = '';
    this.startBtn = document.getElementById('startBtn');
    this.shareBtn = document.getElementById('shareBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.startBtn.disabled = true;
    this.shareBtn.disabled = true;
    this.statusBox = document.getElementById('statusBox');

    this.controls = {
      quality: document.getElementById('quality'),
      fps: document.getElementById('fps'),
      outputResolution: document.getElementById('outputResolution'),
      includeAudio: document.getElementById('includeAudio'),
      showDock: document.getElementById('showDock')
    };

    this.startBtn.addEventListener('click', () => this.start());
    this.shareBtn.addEventListener('click', () => this.shareToPonsLink());
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
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.activeTabId = activeTab?.id ?? null;
      this.activeTabUrl = activeTab?.url || '';
      const saved = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
      if (saved) this.prefs = { ...this.prefs, ...saved };
      this.syncUI();
      await this.syncSessionState();
    } catch (e) {
      console.error('[Popup] Initialization error:', e);
    } finally {
      this.startBtn.disabled = false;
      this.shareBtn.disabled = false;
    }
  }

  sendRuntimeMessage(message, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ClickCap service worker did not respond.'));
      }, timeoutMs);

      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  async syncSessionState() {
    try {
      const response = await this.sendRuntimeMessage({ type: 'GET_RECORDING_SESSION' }, 3000);
      this.applySessionState(response?.session);
    } catch (error) {
      const saved = await storageManager.getChromeStorage(STORAGE_KEYS.ACTIVE_CAPTURE_SESSION);
      this.applySessionState(saved ? { ...saved, isActive: true } : null);
    }
  }

  applySessionState(session) {
    if (!session?.isActive) {
      this.setIdleControls();
      return;
    }

    this.setActiveControls();
    this.stopBtn.classList.toggle('hidden', session.status === 'finalizing');
    const label = session.type === 'pons-link' ? 'PonsLink Cast' : 'Recording';
    const status = session.status === 'finalizing'
      ? `${label}: preparing the WebM download.`
      : session.status === 'selecting'
      ? `${label}: select an area in the current tab.`
      : session.status === 'ready'
        ? `${label}: area selected. Continue from the recording side panel.`
        : `${label}: active.`;
    this.showStatus(status, 'info');
  }

  setActiveControls() {
    this.startBtn.classList.add('hidden');
    this.shareBtn.classList.add('hidden');
    this.stopBtn.classList.remove('hidden');
  }

  setIdleControls() {
    this.startBtn.classList.remove('hidden');
    this.shareBtn.classList.remove('hidden');
    this.stopBtn.classList.add('hidden');
  }

  showStatus(message, type = 'info') {
    if (!this.statusBox) return;
    this.statusBox.textContent = message;
    this.statusBox.className = `status-box ${type}`;
  }

  clearStatus() {
    if (!this.statusBox) return;
    this.statusBox.textContent = '';
    this.statusBox.className = 'status-box hidden';
  }

  syncUI() {
    const p = this.prefs;
    this.controls.quality.value = p.quality || 'HIGH';
    this.controls.fps.value = String(p.fps || 30);
    this.controls.outputResolution.value = p.outputResolution || 'source';
    this.controls.includeAudio.checked = p.includeAudio !== false;
    this.controls.showDock.checked = p.showDock !== false;
  }

  async onPrefChanged() {
    this.prefs = {
      ...this.prefs,
      format: 'webm',
      quality: this.controls.quality.value,
      fps: parseInt(this.controls.fps.value, 10),
      outputResolution: this.controls.outputResolution.value,
      includeAudio: this.controls.includeAudio.checked,
      showDock: this.controls.showDock.checked
    };

    await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.prefs);

    try {
      await this.sendRuntimeMessage({ type: MESSAGE_TYPES.UPDATE_PREFS, data: this.prefs }, 1200);
    } catch (e) {
      console.warn('[Popup] Failed to send prefs update:', e);
    }
  }

  openSidePanelFromClick() {
    if (this.activeTabId === null || !chrome.sidePanel?.open) return Promise.resolve();
    return chrome.sidePanel.open({ tabId: this.activeTabId }).catch((error) => {
      console.warn('[Popup] Could not open recording controls:', error);
    });
  }

  async startForPonsLink() {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'full-screen';
    await this.onPrefChanged();

    this.shareBtn.disabled = true;
    this.shareBtn.textContent = 'CONNECTING...';
    this.clearStatus();

    try {
      const res = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('PonsLink Cast connection timed out. Keep a PonsLink room tab open and try again.'));
        }, 15000);

        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.START_RECORDING_FOR_PONS_LINK,
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
        throw new Error(res?.error || 'PonsLink Cast could not start.');
      }

      this.setActiveControls();
      this.showStatus(mode === 'area'
        ? 'PonsLink Cast is waiting for area selection.'
        : 'PonsLink Cast is active.',
      'info');
    } catch (e) {
      this.showStatus(e.message, 'error');
    } finally {
      this.shareBtn.disabled = false;
      this.shareBtn.textContent = 'PONSLINK CAST';
    }
  }

  async start() {
    if (!this.activeTabId || this.activeTabUrl.startsWith('chrome://') ||
        this.activeTabUrl.startsWith('chrome-extension://') || this.activeTabUrl.startsWith('edge://')) {
      this.showStatus('This page cannot be recorded. Choose a regular web page and try again.', 'error');
      return;
    }

    const sidePanelOpening = this.openSidePanelFromClick();
    const preferencesSaving = this.onPrefChanged();
    const startRequest = this.sendRuntimeMessage({
      type: MESSAGE_TYPES.START_RECORDING,
      data: {
        mode: document.querySelector('input[name="mode"]:checked')?.value || 'full-screen',
        preferences: this.prefs
      }
    }, 10000);

    this.startBtn.disabled = true;
    this.startBtn.textContent = '시작 중...';

    try {
      const [, , response] = await Promise.all([
        preferencesSaving,
        sidePanelOpening,
        startRequest
      ]);
      if (!response?.success) {
        throw new Error(response?.error || '녹화 시작 실패');
      }
      this.setActiveControls();
      this.showStatus('Recording controls are open in the side panel.', 'info');
    } catch (error) {
      this.showStatus(`Recording failed: ${error.message}`, 'error');
    } finally {
      this.startBtn.disabled = false;
      this.startBtn.textContent = '녹화 시작';
    }
  }

  async shareToPonsLink() {
    await this.startForPonsLink();
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
        this.showStatus('Stop failed: ' + (res?.error || 'Unknown error'), 'error');
      } else {
        this.showStatus('Recording completed. WebM download will start.', 'info');
      }
    } catch (e) {
      this.showStatus('Stop failed: ' + e.message, 'error');
    } finally {
      this.setIdleControls();
    }
  }
}

new PopupMain();
