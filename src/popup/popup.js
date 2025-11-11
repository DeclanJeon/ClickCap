const MESSAGE_TYPES = {
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording'
};

const STORAGE_KEYS = {
  RECORDING_STATE: 'recordingState',
  USER_PREFERENCES: 'userPreferences'
};

const DEFAULT_PREFERENCES = {
  quality: 'HIGH',
  fps: 30,
  format: 'WEBM',
  includeAudio: true,
  laserPointerEnabled: false,
  clickZoomEnabled: true
};

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

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
        }

        if (!db.objectStoreNames.contains('chunks')) {
          const chunksStore = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
          chunksStore.createIndex('recordingId', 'recordingId', { unique: false });
        }
      };
    });
  }

  async getAllRecordings() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['recordings'], 'readonly');
      const objectStore = transaction.objectStore('recordings');
      const request = objectStore.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getRecording(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['recordings'], 'readonly');
      const objectStore = transaction.objectStore('recordings');
      const request = objectStore.get(id);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getChunks(recordingId) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readonly');
      const objectStore = transaction.objectStore('chunks');
      const index = objectStore.index('recordingId');
      const request = index.getAll(recordingId);

      request.onsuccess = () => {
        const chunks = request.result.sort((a, b) => a.sequence - b.sequence);
        resolve(chunks);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteRecording(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['recordings', 'chunks'], 'readwrite');
      const recordingsStore = transaction.objectStore('recordings');
      const chunksStore = transaction.objectStore('chunks');
      const chunksIndex = chunksStore.index('recordingId');

      chunksIndex.openCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      const request = recordingsStore.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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

class PopupManager {
  constructor() {
    this.isRecording = false;
    this.preferences = DEFAULT_PREFERENCES;
    
    this.elements = {
      status: document.getElementById('status'),
      statusText: document.querySelector('.status-text'),
      startBtn: document.getElementById('startBtn'),
      stopBtn: document.getElementById('stopBtn'),
      modeRadios: document.querySelectorAll('input[name="mode"]'),
      qualitySelect: document.getElementById('quality'),
      fpsSelect: document.getElementById('fps'),
      formatSelect: document.getElementById('format'),
      includeAudioCheckbox: document.getElementById('includeAudio'),
      laserPointerCheckbox: document.getElementById('laserPointer'),
      clickZoomCheckbox: document.getElementById('clickZoom'),
      recordingsSection: document.getElementById('recordingsSection'),
      recordingsList: document.getElementById('recordingsList')
    };

    this.init();
  }

  async init() {
    await storageManager.init();
    await this.loadPreferences();
    await this.loadRecordingState();
    await this.loadRecordings();
    this.attachEventListeners();
  }

  async loadPreferences() {
    const saved = await storageManager.getChromeStorage(STORAGE_KEYS.USER_PREFERENCES);
    if (saved) {
      this.preferences = { ...DEFAULT_PREFERENCES, ...saved };
      this.applyPreferencesToUI();
    }
  }

  applyPreferencesToUI() {
    this.elements.qualitySelect.value = this.preferences.quality;
    this.elements.fpsSelect.value = this.preferences.fps;
    this.elements.formatSelect.value = this.preferences.format;
    this.elements.includeAudioCheckbox.checked = this.preferences.includeAudio;
    this.elements.laserPointerCheckbox.checked = this.preferences.laserPointerEnabled;
    this.elements.clickZoomCheckbox.checked = this.preferences.clickZoomEnabled;
  }

  async loadRecordingState() {
    const state = await storageManager.getChromeStorage(STORAGE_KEYS.RECORDING_STATE);
    if (state && state.isRecording) {
      this.updateUIForRecording(true, state.isPaused);
    }
  }

  async loadRecordings() {
    const recordings = await storageManager.getAllRecordings();
    if (recordings && recordings.length > 0) {
      this.elements.recordingsSection.style.display = 'block';
      this.displayRecordings(recordings);
    }
  }

  displayRecordings(recordings) {
    this.elements.recordingsList.innerHTML = '';
    
    recordings.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5).forEach(recording => {
      const item = document.createElement('div');
      item.className = 'recording-item';
      
      const date = new Date(recording.timestamp);
      const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
      
      item.innerHTML = `
        <div class="recording-info">
          <div class="recording-name">Recording ${recording.id}</div>
          <div class="recording-meta">
            ${dateStr} • ${formatDuration(recording.duration)} • ${formatFileSize(recording.size)}
          </div>
        </div>
        <div class="recording-actions">
          <button data-id="${recording.id}" class="download-btn">Download</button>
          <button data-id="${recording.id}" class="delete-btn">Delete</button>
        </div>
      `;
      
      this.elements.recordingsList.appendChild(item);
    });

    document.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.downloadRecording(e.target.dataset.id));
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.deleteRecording(e.target.dataset.id));
    });
  }

  async downloadRecording(id) {
    const recording = await storageManager.getRecording(parseInt(id));
    if (!recording) return;

    const chunks = await storageManager.getChunks(recording.id);
    const blobs = chunks.map(chunk => chunk.data);
    const blob = new Blob(blobs, { type: recording.format });
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording_${recording.timestamp}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async deleteRecording(id) {
    if (confirm('Are you sure you want to delete this recording?')) {
      await storageManager.deleteRecording(parseInt(id));
      await this.loadRecordings();
    }
  }

  attachEventListeners() {
    this.elements.startBtn.addEventListener('click', () => this.startRecording());
    this.elements.stopBtn.addEventListener('click', () => this.stopRecording());

    this.elements.qualitySelect.addEventListener('change', () => this.savePreferences());
    this.elements.fpsSelect.addEventListener('change', () => this.savePreferences());
    this.elements.formatSelect.addEventListener('change', () => this.savePreferences());
    this.elements.includeAudioCheckbox.addEventListener('change', () => this.savePreferences());
    this.elements.laserPointerCheckbox.addEventListener('change', () => this.savePreferences());
    this.elements.clickZoomCheckbox.addEventListener('change', () => this.savePreferences());
  }

  async savePreferences() {
    this.preferences = {
      quality: this.elements.qualitySelect.value,
      fps: parseInt(this.elements.fpsSelect.value),
      format: this.elements.formatSelect.value,
      includeAudio: this.elements.includeAudioCheckbox.checked,
      laserPointerEnabled: this.elements.laserPointerCheckbox.checked,
      clickZoomEnabled: this.elements.clickZoomCheckbox.checked
    };

    await storageManager.saveChromeStorage(STORAGE_KEYS.USER_PREFERENCES, this.preferences);
  }

  async startRecording() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.START_RECORDING,
        data: {
          mode,
          preferences: this.preferences
        }
      });

      this.updateUIForRecording(true, false);
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to start recording. Please try again.');
    }
  }

  async stopRecording() {
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.STOP_RECORDING
      });

      this.updateUIForRecording(false, false);
      
      setTimeout(() => this.loadRecordings(), 1000);
    } catch (error) {
      console.error('Failed to stop recording:', error);
    }
  }

  updateUIForRecording(isRecording, isPaused) {
    this.isRecording = isRecording;

    if (isRecording) {
      this.elements.startBtn.style.display = 'none';
      this.elements.stopBtn.style.display = 'flex';
      this.elements.status.classList.add('recording');
      this.elements.statusText.textContent = isPaused ? 'Paused' : 'Recording';
      
      if (isPaused) {
        this.elements.status.classList.add('paused');
      } else {
        this.elements.status.classList.remove('paused');
      }
    } else {
      this.elements.startBtn.style.display = 'flex';
      this.elements.stopBtn.style.display = 'none';
      this.elements.status.classList.remove('recording', 'paused');
      this.elements.statusText.textContent = 'Ready';
    }
  }
}

new PopupManager();
