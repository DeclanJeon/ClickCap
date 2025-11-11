const MESSAGE_TYPES = {
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  PAUSE_RECORDING: 'pause-recording',
  RESUME_RECORDING: 'resume-recording',
  CANCEL_RECORDING: 'cancel-recording',
  RECORDING_STATS: 'recording-stats',
  MOUSE_MOVE: 'mouse-move',
  MOUSE_CLICK: 'mouse-click',
  TOGGLE_LASER: 'toggle-laser'
};

const VIDEO_QUALITY = {
  LOW: { bitrate: 2000000 },
  MEDIUM: { bitrate: 5000000 },
  HIGH: { bitrate: 8000000 },
  ULTRA: { bitrate: 15000000 }
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
        }

        if (!db.objectStoreNames.contains('chunks')) {
          const chunksStore = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
          chunksStore.createIndex('recordingId', 'recordingId', { unique: false });
        }
      };
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
}

const storageManager = new StorageManager();

function getMimeType(format) {
  const mimeTypes = {
    WEBM: 'video/webm;codecs=vp9,opus',
    MP4: 'video/mp4',
    GIF: 'image/gif'
  };
  return mimeTypes[format] || mimeTypes.WEBM;
}

function estimateBitrate(quality) {
  return VIDEO_QUALITY[quality]?.bitrate || VIDEO_QUALITY.HIGH.bitrate;
}

async function cropVideoStream(originalStream, cropArea, fps = 30) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.srcObject = originalStream;
    video.muted = true;
    
    video.onloadedmetadata = () => {
      video.play();
      
      const canvas = document.createElement('canvas');
      canvas.width = cropArea.width;
      canvas.height = cropArea.height;
      const ctx = canvas.getContext('2d');

      let animationId;
      const drawFrame = () => {
        ctx.drawImage(
          video,
          cropArea.x,
          cropArea.y,
          cropArea.width,
          cropArea.height,
          0,
          0,
          cropArea.width,
          cropArea.height
        );
        animationId = requestAnimationFrame(drawFrame);
      };
      drawFrame();

      const croppedVideoStream = canvas.captureStream(fps);
      
      const audioTrack = originalStream.getAudioTracks()[0];
      if (audioTrack) {
        croppedVideoStream.addTrack(audioTrack);
      }

      resolve({
        stream: croppedVideoStream,
        cleanup: () => {
          cancelAnimationFrame(animationId);
          video.srcObject = null;
          video.remove();
          canvas.remove();
        }
      });
    };

    video.onerror = (error) => reject(error);
  });
}

class LaserPointer {
  constructor(canvas, videoStream, cropArea) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.videoStream = videoStream;
    this.cropArea = cropArea;
    
    this.video = document.createElement('video');
    this.video.srcObject = videoStream;
    this.video.muted = true;
    this.video.play();

    this.mouseX = 0;
    this.mouseY = 0;
    this.isEnabled = true;
    this.zoomAnimations = [];
    this.clickZoomEnabled = true;

    this.video.onloadedmetadata = () => {
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
      this.startRendering();
    };
  }

  updatePosition({ x, y }) {
    this.mouseX = x;
    this.mouseY = y;
  }

  triggerZoom({ x, y }) {
    if (!this.clickZoomEnabled) return;

    this.zoomAnimations.push({
      x,
      y,
      progress: 0,
      startTime: Date.now()
    });
  }

  startRendering() {
    const render = () => {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      
      this.ctx.drawImage(this.video, 0, 0);

      if (this.isEnabled) {
        this.drawLaserPointer();
      }

      this.drawZoomAnimations();

      this.animationFrame = requestAnimationFrame(render);
    };

    render();
  }

  drawLaserPointer() {
    this.ctx.save();
    
    this.ctx.beginPath();
    this.ctx.arc(this.mouseX, this.mouseY, 20, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
    this.ctx.fill();
    
    this.ctx.beginPath();
    this.ctx.arc(this.mouseX, this.mouseY, 20, 0, Math.PI * 2);
    this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.arc(this.mouseX, this.mouseY, 5, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(255, 0, 0, 0.9)';
    this.ctx.fill();

    this.ctx.restore();
  }

  drawZoomAnimations() {
    const now = Date.now();
    
    this.zoomAnimations = this.zoomAnimations.filter(animation => {
      const elapsed = now - animation.startTime;
      const duration = 1000;
      
      if (elapsed >= duration) {
        return false;
      }

      animation.progress = elapsed / duration;
      
      const scale = 1 + (0.5 * Math.sin(animation.progress * Math.PI));
      const opacity = 1 - animation.progress;

      this.ctx.save();
      this.ctx.translate(animation.x, animation.y);
      
      const size = 100 * scale;
      
      this.ctx.strokeStyle = `rgba(255, 255, 0, ${opacity * 0.8})`;
      this.ctx.lineWidth = 3;
      this.ctx.strokeRect(-size, -size, size * 2, size * 2);

      this.ctx.fillStyle = `rgba(255, 255, 0, ${opacity * 0.1})`;
      this.ctx.fillRect(-size, -size, size * 2, size * 2);

      this.ctx.restore();

      return true;
    });
  }

  getOutputStream() {
    return this.canvas.captureStream(30);
  }

  setEnabled(enabled) {
    this.isEnabled = enabled;
  }

  setClickZoomEnabled(enabled) {
    this.clickZoomEnabled = enabled;
  }

  destroy() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
  }
}

class OffscreenRecorder {
  constructor() {
    this.recorder = null;
    this.mediaStream = null;
    this.chunks = [];
    this.startTime = null;
    this.pausedTime = 0;
    this.lastPauseStart = null;
    this.totalSize = 0;
    this.statsInterval = null;
    this.cropCleanup = null;
    this.laserPointer = null;
    this.canvas = document.getElementById('canvas');
    this.currentRecordingId = null;
    this.chunkSequence = 0;

    this.setupMessageHandlers();
    storageManager.init();
  }

  setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.target === 'offscreen') {
        this.handleMessage(message).then(sendResponse);
        return true;
      }
    });
  }

  async handleMessage(message) {
    switch (message.type) {
      case MESSAGE_TYPES.START_RECORDING:
        return this.startRecording(message.data);
      case MESSAGE_TYPES.STOP_RECORDING:
        return this.stopRecording();
      case MESSAGE_TYPES.PAUSE_RECORDING:
        return this.pauseRecording();
      case MESSAGE_TYPES.RESUME_RECORDING:
        return this.resumeRecording();
      case MESSAGE_TYPES.CANCEL_RECORDING:
        return this.cancelRecording();
      case MESSAGE_TYPES.MOUSE_MOVE:
        if (this.laserPointer) {
          this.laserPointer.updatePosition(message.data);
        }
        return { success: true };
      case MESSAGE_TYPES.MOUSE_CLICK:
        if (this.laserPointer) {
          this.laserPointer.triggerZoom(message.data);
        }
        return { success: true };
      case MESSAGE_TYPES.TOGGLE_LASER:
        return this.toggleLaser(message.data);
      default:
        return { success: false, error: 'Unknown message type' };
    }
  }

  async startRecording({ streamId, cropArea, preferences }) {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: preferences.includeAudio ? {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        } : false,
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });

      let recordingStream = this.mediaStream;

      if (cropArea) {
        const cropResult = await cropVideoStream(this.mediaStream, cropArea, preferences.fps);
        recordingStream = cropResult.stream;
        this.cropCleanup = cropResult.cleanup;
      }

      if (preferences.laserPointerEnabled) {
        this.laserPointer = new LaserPointer(this.canvas, recordingStream, cropArea);
        recordingStream = this.laserPointer.getOutputStream();
      }

      const mimeType = getMimeType(preferences.format);
      const videoBitsPerSecond = estimateBitrate(preferences.quality);

      this.recorder = new MediaRecorder(recordingStream, {
        mimeType,
        videoBitsPerSecond,
        audioBitsPerSecond: 128000
      });

      this.chunks = [];
      this.totalSize = 0;
      this.chunkSequence = 0;
      this.startTime = Date.now();
      this.pausedTime = 0;

      this.currentRecordingId = `recording_${this.startTime}`;

      this.recorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
          this.totalSize += event.data.size;

          await storageManager.saveChunk(
            this.currentRecordingId,
            event.data,
            this.chunkSequence++
          );
        }
      };

      this.recorder.onstop = async () => {
        await this.finalizeRecording();
      };

      this.recorder.start(1000);

      this.startStatsReporting();

      const output = new AudioContext();
      const source = output.createMediaStreamSource(this.mediaStream);
      source.connect(output.destination);

      window.location.hash = 'recording';

      return { success: true };
    } catch (error) {
      console.error('Failed to start recording:', error);
      return { success: false, error: error.message };
    }
  }

  async stopRecording() {
    if (!this.recorder || this.recorder.state === 'inactive') {
      return { success: false, error: 'No active recording' };
    }

    this.recorder.stop();
    this.stopStatsReporting();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
    }

    if (this.cropCleanup) {
      this.cropCleanup();
    }

    if (this.laserPointer) {
      this.laserPointer.destroy();
      this.laserPointer = null;
    }

    window.location.hash = '';

    return { success: true };
  }

  pauseRecording() {
    if (this.recorder && this.recorder.state === 'recording') {
      this.recorder.pause();
      this.lastPauseStart = Date.now();
      return { success: true };
    }
    return { success: false };
  }

  resumeRecording() {
    if (this.recorder && this.recorder.state === 'paused') {
      this.recorder.resume();
      if (this.lastPauseStart) {
        this.pausedTime += Date.now() - this.lastPauseStart;
        this.lastPauseStart = null;
      }
      return { success: true };
    }
    return { success: false };
  }

  async cancelRecording() {
    if (this.recorder) {
      this.recorder.stop();
      this.stopStatsReporting();

      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => track.stop());
      }

      if (this.cropCleanup) {
        this.cropCleanup();
      }

      if (this.laserPointer) {
        this.laserPointer.destroy();
        this.laserPointer = null;
      }

      this.chunks = [];
      this.totalSize = 0;

      if (this.currentRecordingId) {
        const chunks = await storageManager.getChunks(this.currentRecordingId);
        for (const chunk of chunks) {
          // Delete chunks logic would go here
        }
      }

      window.location.hash = '';

      return { success: true };
    }
    return { success: false };
  }

  toggleLaser({ enabled }) {
    if (enabled && !this.laserPointer && this.recorder) {
      this.laserPointer = new LaserPointer(this.canvas, this.mediaStream, null);
    } else if (!enabled && this.laserPointer) {
      this.laserPointer.destroy();
      this.laserPointer = null;
    }
    return { success: true };
  }

  startStatsReporting() {
    this.statsInterval = setInterval(() => {
      const currentTime = Date.now();
      const duration = currentTime - this.startTime - this.pausedTime;

      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.RECORDING_STATS,
        data: {
          duration,
          size: this.totalSize,
          isRecording: this.recorder && this.recorder.state === 'recording',
          isPaused: this.recorder && this.recorder.state === 'paused'
        }
      }).catch(() => {});
    }, 100);
  }

  stopStatsReporting() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  async finalizeRecording() {
    const blob = new Blob(this.chunks, { type: this.chunks[0].type });
    
    await storageManager.saveRecording({
      id: this.currentRecordingId,
      timestamp: this.startTime,
      duration: Date.now() - this.startTime - this.pausedTime,
      size: this.totalSize,
      format: this.chunks[0].type
    });

    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');

    this.chunks = [];
    this.totalSize = 0;
    this.currentRecordingId = null;
    this.chunkSequence = 0;
  }
}

new OffscreenRecorder();
