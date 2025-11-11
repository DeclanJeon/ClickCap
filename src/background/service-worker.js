const MESSAGE_TYPES = {
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  PAUSE_RECORDING: 'pause-recording',
  RESUME_RECORDING: 'resume-recording',
  CANCEL_RECORDING: 'cancel-recording',
  AREA_SELECTED: 'area-selected',
  RECORDING_STATS: 'recording-stats',
  RECORDING_COMMAND: 'recording-command',
  MOUSE_MOVE: 'mouse-move',
  MOUSE_CLICK: 'mouse-click',
  TOGGLE_LASER: 'toggle-laser',
  SHOW_AREA_SELECTOR: 'show-area-selector',
  HIDE_AREA_SELECTOR: 'hide-area-selector',
  SHOW_DOCK: 'show-dock',
  HIDE_DOCK: 'hide-dock',
  UPDATE_DOCK_STATS: 'update-dock-stats',
  RECORDING_STATE_CHANGED: 'recording-state-changed'
};

const STORAGE_KEYS = {
  RECORDING_STATE: 'recordingState',
  USER_PREFERENCES: 'userPreferences',
  RECORDING_DATA: 'recordingData'
};

const DEFAULT_PREFERENCES = {
  quality: 'HIGH',
  fps: 30,
  format: 'WEBM',
  includeAudio: true,
  laserPointerEnabled: false,
  clickZoomEnabled: true
};

class StorageManager {
  constructor() {
    this.dbName = 'ScreenRecorderDB';
    this.dbVersion = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains('recordings')) {
          const objectStore = db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
          objectStore.createIndex('timestamp', 'timestamp', { unique: false });
          objectStore.createIndex('filename', 'filename', { unique: false });
        }

        if (!db.objectStoreNames.contains('chunks')) {
          const chunksStore = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
          chunksStore.createIndex('recordingId', 'recordingId', { unique: false });
          chunksStore.createIndex('sequence', 'sequence', { unique: false });
        }
      };
    });
  }

  async saveChromeStorage(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  async getChromeStorage(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key]);
      });
    });
  }
}

const storageManager = new StorageManager();

class MessageHandler {
  constructor() {
    this.listeners = new Map();
  }

  on(messageType, callback) {
    if (!this.listeners.has(messageType)) {
      this.listeners.set(messageType, []);
    }
    this.listeners.get(messageType).push(callback);
  }

  async handle(message, sender, sendResponse) {
    const callbacks = this.listeners.get(message.type);
    if (callbacks && callbacks.length > 0) {
      for (const callback of callbacks) {
        try {
          const result = await callback(message, sender);
          if (result !== undefined) {
            sendResponse(result);
            return true;
          }
        } catch (error) {
          console.error(`Error handling message ${message.type}:`, error);
          sendResponse({ error: error.message });
          return true;
        }
      }
    }
    return false;
  }
}

class RecordingManager {
  constructor() {
    this.state = {
      isRecording: false,
      isPaused: false,
      recordingMode: null,
      cropArea: null,
      streamId: null,
      startTime: null,
      currentTabId: null,
      currentRecordingId: null
    };
    
    this.messageHandler = new MessageHandler();
    this.setupMessageHandlers();
    this.setupCommandHandlers();
    this.init();
  }

  async init() {
    await storageManager.init();
    await this.loadState();
    
    const preferences = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
    if (!preferences) {
      await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, DEFAULT_PREFERENCES);
    }

    if (this.state.isRecording) {
      await this.recoverRecording();
    }
  }

  setupMessageHandlers() {
    this.messageHandler.on(MESSAGE_TYPES.START_RECORDING, this.handleStartRecording.bind(this));
    this.messageHandler.on(MESSAGE_TYPES.STOP_RECORDING, this.handleStopRecording.bind(this));
    this.messageHandler.on(MESSAGE_TYPES.PAUSE_RECORDING, this.handlePauseRecording.bind(this));
    this.messageHandler.on(MESSAGE_TYPES.RESUME_RECORDING, this.handleResumeRecording.bind(this));
    this.messageHandler.on(MESSAGE_TYPES.CANCEL_RECORDING, this.handleCancelRecording.bind(this));
    this.messageHandler.on(MESSAGE_TYPES.AREA_SELECTED, this.handleAreaSelected.bind(this));
    this.messageHandler.on(MESSAGE_TYPES.RECORDING_COMMAND, this.handleRecordingCommand.bind(this));

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.messageHandler.handle(message, sender, sendResponse);
      return true;
    });
  }

  setupCommandHandlers() {
    chrome.commands.onCommand.addListener((command) => {
      switch (command) {
        case 'toggle-recording':
          this.toggleRecording();
          break;
        case 'pause-recording':
          this.togglePause();
          break;
        case 'toggle-laser':
          this.toggleLaser();
          break;
      }
    });
  }

  async handleStartRecording(message) {
    const { mode, preferences } = message.data;
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.state.currentTabId = tab.id;
    this.state.recordingMode = mode;

    if (mode === 'area') {
      await chrome.tabs.sendMessage(tab.id, {
        type: MESSAGE_TYPES.SHOW_AREA_SELECTOR
      });
    } else {
      await this.startCapture(null, preferences);
    }

    return { success: true };
  }

  async handleAreaSelected(message) {
    const { cropArea } = message.data;
    this.state.cropArea = cropArea;

    await chrome.tabs.sendMessage(this.state.currentTabId, {
      type: MESSAGE_TYPES.HIDE_AREA_SELECTOR
    });

    const preferences = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
    await this.startCapture(cropArea, preferences);

    return { success: true };
  }

  async startCapture(cropArea, preferences) {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: this.state.currentTabId
      });

      this.state.streamId = streamId;
      this.state.startTime = Date.now();
      this.state.isRecording = true;
      this.state.isPaused = false;

      await this.ensureOffscreenDocument();

      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.START_RECORDING,
        target: 'offscreen',
        data: {
          streamId,
          cropArea,
          preferences
        }
      });

      await chrome.tabs.sendMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.SHOW_DOCK
      });

      await chrome.action.setIcon({ path: '/icons/recording.png' });

      await this.saveState();

      return { success: true };
    } catch (error) {
      console.error('Failed to start capture:', error);
      this.state.isRecording = false;
      return { success: false, error: error.message };
    }
  }

  async handleStopRecording() {
    if (!this.state.isRecording) {
      return { success: false, error: 'Not recording' };
    }

    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.STOP_RECORDING,
        target: 'offscreen'
      });

      this.state.isRecording = false;
      this.state.isPaused = false;
      this.state.streamId = null;

      if (this.state.currentTabId) {
        await chrome.tabs.sendMessage(this.state.currentTabId, {
          type: MESSAGE_TYPES.HIDE_DOCK
        }).catch(() => {});
      }

      await chrome.action.setIcon({ path: '/icons/not-recording.png' });

      await this.saveState();

      return { success: true };
    } catch (error) {
      console.error('Failed to stop recording:', error);
      return { success: false, error: error.message };
    }
  }

  async handlePauseRecording() {
    if (!this.state.isRecording || this.state.isPaused) {
      return { success: false };
    }

    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.PAUSE_RECORDING,
      target: 'offscreen'
    });

    this.state.isPaused = true;
    await this.saveState();

    return { success: true };
  }

  async handleResumeRecording() {
    if (!this.state.isRecording || !this.state.isPaused) {
      return { success: false };
    }

    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.RESUME_RECORDING,
      target: 'offscreen'
    });

    this.state.isPaused = false;
    await this.saveState();

    return { success: true };
  }

  async handleCancelRecording() {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CANCEL_RECORDING,
      target: 'offscreen'
    });

    this.state.isRecording = false;
    this.state.isPaused = false;
    this.state.streamId = null;

    if (this.state.currentTabId) {
      await chrome.tabs.sendMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.HIDE_DOCK
      }).catch(() => {});
    }

    await chrome.action.setIcon({ path: '/icons/not-recording.png' });
    await this.saveState();

    return { success: true };
  }

  async handleRecordingCommand(message) {
    const { command } = message;

    switch (command) {
      case 'pause':
        return this.state.isPaused ? this.handleResumeRecording() : this.handlePauseRecording();
      case 'stop':
        return this.handleStopRecording();
      case 'cancel':
        return this.handleCancelRecording();
      default:
        return { success: false, error: 'Unknown command' };
    }
  }

  async toggleRecording() {
    if (this.state.isRecording) {
      await this.handleStopRecording();
    } else {
      const preferences = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
      await this.handleStartRecording({
        data: {
          mode: 'full-screen',
          preferences
        }
      });
    }
  }

  async togglePause() {
    if (this.state.isPaused) {
      await this.handleResumeRecording();
    } else {
      await this.handlePauseRecording();
    }
  }

  async toggleLaser() {
    if (this.state.currentTabId) {
      await chrome.tabs.sendMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.TOGGLE_LASER
      }).catch(() => {});
    }
  }

  async ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Recording from chrome.tabCapture API'
      });
    }
  }

  async recoverRecording() {
    console.log('Recovering recording session...');
    await this.ensureOffscreenDocument();
    
    if (this.state.currentTabId) {
      await chrome.tabs.sendMessage(this.state.currentTabId, {
        type: MESSAGE_TYPES.SHOW_DOCK
      }).catch(() => {});
    }
  }

  async saveState() {
    await storageManager.saveChromeStorage(STORAGE_KEYS.RECORDING_STATE, this.state);
  }

  async loadState() {
    const savedState = await storageManager.getChromeStorage(STORAGE_KEYS.RECORDING_STATE);
    if (savedState) {
      this.state = { ...this.state, ...savedState };
    }
  }
}

const recordingManager = new RecordingManager();
