import { DEFAULT_PREFERENCES, MESSAGE_TYPES, STORAGE_KEYS } from '../utils/constants.js';

class RecordingPanel {
  constructor() {
    this.statusLight = document.getElementById('statusLight');
    this.statusTitle = document.getElementById('statusTitle');
    this.statusMessage = document.getElementById('statusMessage');
    this.recordingStats = document.getElementById('recordingStats');
    this.startFullButton = document.getElementById('startFullBtn');
    this.selectAreaButton = document.getElementById('selectAreaBtn');
    this.startAreaButton = document.getElementById('startAreaBtn');
    this.pauseButton = document.getElementById('pauseBtn');
    this.stopButton = document.getElementById('stopBtn');
    this.actionError = document.getElementById('actionError');
    this.isRefreshing = false;
    this.preferences = { ...DEFAULT_PREFERENCES };
    this.startFullButton.disabled = true;
    this.selectAreaButton.disabled = true;
    void this.loadPreferences();
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEYS.USER_PREFERENCES]) {
        this.preferences = {
          ...DEFAULT_PREFERENCES,
          ...(changes[STORAGE_KEYS.USER_PREFERENCES].newValue || {})
        };
      }
    });

    this.startFullButton.addEventListener('click', () => this.startRecording('full-screen'));
    this.selectAreaButton.addEventListener('click', () => this.startRecording('area'));
    this.startAreaButton.addEventListener('click', () => this.sendCommand({ type: 'start-area-recording' }));
    this.pauseButton.addEventListener('click', () => this.sendCommand({
      type: MESSAGE_TYPES.RECORDING_COMMAND,
      command: 'pause'
    }));
    this.stopButton.addEventListener('click', () => this.sendCommand({
      type: MESSAGE_TYPES.RECORDING_COMMAND,
      command: 'stop'
    }));
    chrome.runtime.onMessage.addListener(() => void this.refresh());
    window.setInterval(() => void this.refresh(), 700);
    void this.refresh();
  }

  async sendCommand(message) {
    this.actionError.classList.add('hidden');
    const buttons = [this.startFullButton, this.selectAreaButton, this.startAreaButton, this.pauseButton, this.stopButton];
    buttons.forEach((button) => { button.disabled = true; });

    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.success) {
        throw new Error(response?.error || 'The recording command failed.');
      }
      await this.refresh();
    } catch (error) {
      this.actionError.textContent = error.message || 'The recording command failed.';
      this.actionError.classList.remove('hidden');
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async loadPreferences() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEYS.USER_PREFERENCES]);
      this.preferences = {
        ...DEFAULT_PREFERENCES,
        ...(stored[STORAGE_KEYS.USER_PREFERENCES] || {})
      };
    } catch (error) {
      console.warn('[SidePanel] Could not load preferences:', error);
    } finally {
      this.startFullButton.disabled = false;
      this.selectAreaButton.disabled = false;
    }
  }

  async startRecording(mode) {
    this.actionError.classList.add('hidden');
    const buttons = [this.startFullButton, this.selectAreaButton];
    buttons.forEach((button) => { button.disabled = true; });
    const startRequest = chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.START_RECORDING,
      data: { mode, preferences: this.preferences }
    });

    try {
      const response = await startRequest;
      if (!response?.success) {
        throw new Error(response?.error || 'Could not start recording.');
      }
      await this.refresh();
    } catch (error) {
      this.actionError.textContent = error.message || 'Could not start recording.';
      this.actionError.classList.remove('hidden');
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async refresh() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_SESSION' });
      this.render(response?.session);
    } catch (error) {
      this.statusTitle.textContent = 'Controls unavailable';
      this.statusMessage.textContent = error.message || 'Could not read the recording session.';
    } finally {
      this.isRefreshing = false;
    }
  }

  render(session) {
    const isActive = session?.isActive === true;
    const isReadyToRecord = isActive && session.status === 'ready';
    const isSelecting = isActive && session.status === 'selecting';
    const isFinalizing = isActive && session.status === 'finalizing';
    const isRecording = isActive && session.isRecording === true;
    const isPaused = session?.isPaused === true;

    this.startFullButton.classList.toggle('hidden', isActive);
    this.selectAreaButton.classList.toggle('hidden', isActive);
    this.startAreaButton.classList.toggle('hidden', !isReadyToRecord);
    this.pauseButton.classList.toggle('hidden', !isRecording);
    this.stopButton.classList.toggle('hidden', !isActive || isFinalizing);
    this.recordingStats.classList.toggle('hidden', !isRecording);
    this.statusLight.classList.toggle('recording', isRecording && !isPaused);
    this.statusLight.classList.toggle('paused', isPaused);

    if (!isActive) {
      this.statusTitle.textContent = 'No active recording';
      this.statusMessage.textContent = 'Choose full tab or area capture to begin.';
      this.recordingStats.textContent = '';
      return;
    }

    if (isSelecting) {
      this.statusTitle.textContent = 'Choose an area';
      this.statusMessage.textContent = 'Drag over the page to select the region to record.';
      return;
    }

    if (isReadyToRecord) {
      this.statusTitle.textContent = 'Area selected';
      this.statusMessage.textContent = 'Start recording when the page is ready.';
      return;
    }

    if (isFinalizing) {
      this.statusTitle.textContent = 'Preparing download';
      this.statusMessage.textContent = 'The WebM file will download when it is ready.';
      return;
    }

    this.statusTitle.textContent = isPaused ? 'Recording paused' : 'Recording';
    this.statusMessage.textContent = isPaused
      ? 'Resume when you are ready to continue.'
      : 'The page controls are hidden from the recording.';
    this.pauseButton.textContent = isPaused ? 'Resume' : 'Pause';
    this.recordingStats.textContent = session.mode === 'area' ? 'Area capture' : 'Full tab capture';
  }
}

new RecordingPanel();
