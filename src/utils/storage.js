import { STORAGE_KEYS } from './constants.js';

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

  async saveRecording(recordingData) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['recordings'], 'readwrite');
      const objectStore = transaction.objectStore('recordings');
      const request = objectStore.add(recordingData);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveChunk(recordingId, chunkData, sequence) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readwrite');
      const objectStore = transaction.objectStore('chunks');
      const request = objectStore.add({
        recordingId,
        data: chunkData,
        sequence,
        timestamp: Date.now()
      });

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

  async removeChromeStorage(key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove([key], resolve);
    });
  }
}

export const storageManager = new StorageManager();
