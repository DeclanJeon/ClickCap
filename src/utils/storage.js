import { STORAGE_KEYS, CHUNK_SIZE_LIMIT } from './constants.js';

class StorageManager {
  constructor() {
    this.dbName = 'ScreenRecorderDB';
    this.dbVersion = 2;
    this.db = null;
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('[Storage] IndexedDB open error:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[Storage] IndexedDB initialized successfully');
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log('[Storage] Database upgrade needed, version:', this.dbVersion);

        if (!db.objectStoreNames.contains('recordings')) {
          const recordingsStore = db.createObjectStore('recordings', { keyPath: 'id' });
          recordingsStore.createIndex('timestamp', 'timestamp', { unique: false });
          recordingsStore.createIndex('filename', 'filename', { unique: false });
          console.log('[Storage] Created recordings store');
        }

        if (!db.objectStoreNames.contains('chunks')) {
          const chunksStore = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
          chunksStore.createIndex('recordingId', 'recordingId', { unique: false });
          chunksStore.createIndex('sequence', 'sequence', { unique: false });
          console.log('[Storage] Created chunks store');
        }

        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
          console.log('[Storage] Created metadata store');
        }
      };
    });

    return this.initPromise;
  }

  async saveRecording(recordingData) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['recordings'], 'readwrite');
        const objectStore = transaction.objectStore('recordings');

        const dataToSave = {
          ...recordingData,
          savedAt: Date.now(),
          status: 'completed'
        };

        const request = objectStore.add(dataToSave);

        request.onsuccess = () => {
          console.log('[Storage] Recording saved with ID:', request.result);
          resolve(request.result);
        };

        request.onerror = () => {
          console.error('[Storage] Failed to save recording:', request.error);
          reject(request.error);
        };

        transaction.onerror = () => {
          console.error('[Storage] Transaction error:', transaction.error);
          reject(transaction.error);
        };
      } catch (error) {
        console.error('[Storage] Error in saveRecording:', error);
        reject(error);
      }
    });
  }

  async saveChunk(recordingId, chunkData, sequence) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['chunks'], 'readwrite');
        const objectStore = transaction.objectStore('chunks');

        const chunkSize = chunkData.size || chunkData.byteLength || 0;

        if (chunkSize > CHUNK_SIZE_LIMIT) {
          console.warn('[Storage] Chunk size exceeds limit:', chunkSize);
        }

        const request = objectStore.add({
          recordingId,
          data: chunkData,
          sequence,
          size: chunkSize,
          timestamp: Date.now()
        });

        request.onsuccess = () => {
          resolve(request.result);
        };

        request.onerror = () => {
          console.error('[Storage] Failed to save chunk:', request.error);
          reject(request.error);
        };
      } catch (error) {
        console.error('[Storage] Error in saveChunk:', error);
        reject(error);
      }
    });
  }

  async getRecording(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['recordings'], 'readonly');
        const objectStore = transaction.objectStore('recordings');
        const request = objectStore.get(id);

        request.onsuccess = () => {
          resolve(request.result);
        };

        request.onerror = () => {
          reject(request.error);
        };
      } catch (error) {
        console.error('[Storage] Error in getRecording:', error);
        reject(error);
      }
    });
  }

  async getChunks(recordingId) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['chunks'], 'readonly');
        const objectStore = transaction.objectStore('chunks');
        const index = objectStore.index('recordingId');
        const request = index.getAll(recordingId);

        request.onsuccess = () => {
          const chunks = request.result.sort((a, b) => a.sequence - b.sequence);
          resolve(chunks);
        };

        request.onerror = () => {
          reject(request.error);
        };
      } catch (error) {
        console.error('[Storage] Error in getChunks:', error);
        reject(error);
      }
    });
  }

  async getAllRecordings() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['recordings'], 'readonly');
        const objectStore = transaction.objectStore('recordings');
        const request = objectStore.getAll();

        request.onsuccess = () => {
          const recordings = request.result.sort((a, b) => b.timestamp - a.timestamp);
          resolve(recordings);
        };

        request.onerror = () => {
          reject(request.error);
        };
      } catch (error) {
        console.error('[Storage] Error in getAllRecordings:', error);
        reject(error);
      }
    });
  }

  async deleteRecording(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['recordings', 'chunks'], 'readwrite');
        const recordingsStore = transaction.objectStore('recordings');
        const chunksStore = transaction.objectStore('chunks');
        const chunksIndex = chunksStore.index('recordingId');

        const deleteChunksRequest = chunksIndex.openCursor(IDBKeyRange.only(id));

        deleteChunksRequest.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        const deleteRecordingRequest = recordingsStore.delete(id);

        transaction.oncomplete = () => {
          console.log('[Storage] Recording deleted:', id);
          resolve();
        };

        transaction.onerror = () => {
          console.error('[Storage] Transaction error:', transaction.error);
          reject(transaction.error);
        };
      } catch (error) {
        console.error('[Storage] Error in deleteRecording:', error);
        reject(error);
      }
    });
  }

  async saveChromeStorage(key, value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            console.error('[Storage] Chrome storage error:', chrome.runtime.lastError);
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      } catch (error) {
        console.error('[Storage] Error in saveChromeStorage:', error);
        reject(error);
      }
    });
  }

  async getChromeStorage(key) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime.lastError) {
            console.error('[Storage] Chrome storage error:', chrome.runtime.lastError);
            reject(chrome.runtime.lastError);
          } else {
            resolve(result[key]);
          }
        });
      } catch (error) {
        console.error('[Storage] Error in getChromeStorage:', error);
        reject(error);
      }
    });
  }

  async removeChromeStorage(key) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.remove([key], () => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async getMetadata(key) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['metadata'], 'readonly');
        const objectStore = transaction.objectStore('metadata');
        const request = objectStore.get(key);

        request.onsuccess = () => {
          resolve(request.result?.value);
        };

        request.onerror = () => {
          reject(request.error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async setMetadata(key, value) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['metadata'], 'readwrite');
        const objectStore = transaction.objectStore('metadata');
        const request = objectStore.put({ key, value, timestamp: Date.now() });

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => {
          reject(request.error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }
}

export const storageManager = new StorageManager();
