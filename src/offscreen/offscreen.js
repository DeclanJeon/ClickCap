import { MESSAGE_TYPES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';
import { generateFilename } from '../utils/video-utils.js';

const REC_MIME = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
  ? 'video/webm;codecs=vp8,opus'
  : 'video/webm';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function clampCrop(crop, srcW, srcH) {
  const x = clamp(crop?.x ?? 0, 0, srcW);
  const y = clamp(crop?.y ?? 0, 0, srcH);
  const w = clamp(crop?.width ?? srcW, 1, srcW - x);
  const h = clamp(crop?.height ?? srcH, 1, srcH - y);
  return { x, y, width: w, height: h };
}

class OffscreenRecorder {
  constructor() {
    this.mediaStream = null;        // 원본 tabCapture stream
    this.recorder = null;           // MediaRecorder
    this.chunks = [];               // Blob chunks
    this.totalSize = 0;
    this.currentRecordingId = null;

    this.canvas = null;             // HTMLCanvasElement (DOM에 존재)
    this.ctx = null;
    this.drawTimer = null;          // setInterval ID
    this.isRecording = false;

    this.video = null;              // <video> for drawing
    this.statsInterval = null;

    this.state = {
      fps: 30,
      quality: 'HIGH',
      includeAudio: true,
      cropArea: null
    };

    this.setupMessageHandlers();
    this.init();
  }

  async init() {
    try {
      await storageManager.init();
      console.log('[Offscreen] Initialized');
      await this.notifyReady();
    } catch (e) {
      console.error('[Offscreen] Init error:', e);
    }
  }

  async notifyReady() {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_READY }, () => resolve());
      });
    } catch {
      // noop
    }
  }

  setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.target !== 'offscreen') return;
      this.handleMessage(message)
        .then((res) => sendResponse(res || { success: true }))
        .catch((err) => {
          console.error('[Offscreen] Message error:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
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
      default:
        return { success: false, error: 'Unknown message' };
    }
  }

  // 안정적인 캔버스 확보
  prepareCanvas(width, height) {
    if (!this.canvas) {
      this.canvas = document.getElementById('rec-canvas');
    }
    // 내부 픽셀 해상도는 DPR 반영
    const dpr = self.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: false });
    if (!this.ctx) throw new Error('Failed to get 2D context');
    return { w, h, dpr };
  }

  async startRecording({ streamId, cropArea, preferences }) {
    try {
      console.log('[Offscreen] Start with pref:', preferences, 'crop:', cropArea);
      this.state.fps = preferences?.fps || 30;
      this.state.quality = preferences?.quality || 'HIGH';
      this.state.includeAudio = preferences?.includeAudio !== false;
      this.state.cropArea = cropArea || null;

      // 1) tab capture stream 가져오기
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: this.state.includeAudio
          ? {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId
              }
            }
          : false,
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });
      console.log('[Offscreen] Stream tracks:', {
        v: this.mediaStream.getVideoTracks().length,
        a: this.mediaStream.getAudioTracks().length
      });

      // 2) 비디오 요소 준비
      this.video = document.createElement('video');
      this.video.srcObject = this.mediaStream;
      this.video.muted = true;
      this.video.playsInline = true;

      await this.video.play();
      await this.waitForFirstFrame(this.video);
      console.log('[Offscreen] Video dims:', this.video.videoWidth, this.video.videoHeight);

      // 3) 크롭 클램프 + 캔버스 준비
      const srcW = this.video.videoWidth || 1;
      const srcH = this.video.videoHeight || 1;
      const crop = clampCrop(this.state.cropArea, srcW, srcH);
      const { dpr } = this.prepareCanvas(crop.width, crop.height);

      // 4) 캔버스 렌더 루프(setInterval) — rAF 스로틀 회피
      const fps = clamp(this.state.fps, 10, 60);
      const intervalMs = Math.max(15, Math.floor(1000 / fps));
      const sX = Math.round(crop.x * dpr);
      const sY = Math.round(crop.y * dpr);
      const sW = Math.round(crop.width * dpr);
      const sH = Math.round(crop.height * dpr);

      if (sW <= 0 || sH <= 0) {
        throw new Error('Invalid crop area after DPR scaling');
      }

      if (this.drawTimer) clearInterval(this.drawTimer);
      this.drawTimer = setInterval(() => {
        try {
          if (this.video.readyState >= this.video.HAVE_CURRENT_DATA) {
            this.ctx.drawImage(
              this.video,
              sX, sY, sW, sH,
              0, 0, this.canvas.width, this.canvas.height
            );
          }
        } catch (e) {
          console.warn('[Offscreen] draw loop error:', e.message);
        }
      }, intervalMs);
      console.log('[Offscreen] Draw loop started @', fps, 'fps, interval', intervalMs);

      // 5) captureStream + 오디오 트랙 추가
      const outStream = this.canvas.captureStream(fps);
      const aTrack = this.mediaStream.getAudioTracks()[0];
      if (aTrack) {
        try {
          outStream.addTrack(aTrack);
          console.log('[Offscreen] Audio track added to outStream');
        } catch (e) {
          console.warn('[Offscreen] addTrack audio failed:', e.message);
        }
      }
      console.log('[Offscreen] Out tracks:', {
        v: outStream.getVideoTracks().length,
        a: outStream.getAudioTracks().length
      });

      // 6) MediaRecorder 구성
      const vBps = this.qualityToBitrate(this.state.quality);
      const options = {
        mimeType: REC_MIME,
        videoBitsPerSecond: vBps,
        audioBitsPerSecond: 128000
      };
      this.recorder = new MediaRecorder(outStream, options);
      console.log('[Offscreen] MediaRecorder created:', options);

      this.chunks = [];
      this.totalSize = 0;
      this.currentRecordingId = `recording_${Date.now()}`;

      this.recorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          this.chunks.push(e.data);
          this.totalSize += e.data.size;
          try {
            await storageManager.saveChunk(this.currentRecordingId, e.data, this.chunks.length - 1);
          } catch (err) {
            console.warn('[Offscreen] saveChunk failed:', err.message);
          }
        }
      };

      this.recorder.onstop = async () => {
        console.log('[Offscreen] Recorder stopped. chunks:', this.chunks.length, 'size:', this.totalSize);
        this.stopStats();
        await this.finalize();
      };

      this.recorder.onerror = (e) => {
        console.error('[Offscreen] Recorder error:', e.error || e.name || e.message);
      };

      // timeslice — 1초마다 청크 생성(이게 안정적)
      this.recorder.start(1000);
      this.isRecording = true;
      console.log('[Offscreen] Recorder started with timeslice=1000');

      this.startStats();
      return { success: true };
    } catch (e) {
      console.error('[Offscreen] startRecording error:', e);
      await this.cleanup();
      return { success: false, error: e.message };
    }
  }

  qualityToBitrate(q) {
    switch (q) {
      case 'LOW': return 2_000_000;
      case 'MEDIUM': return 5_000_000;
      case 'ULTRA': return 15_000_000;
      case 'HIGH':
      default:
        return 8_000_000;
    }
  }

  async waitForFirstFrame(video) {
    const timeout = Date.now() + 10000;
    while (video.readyState < video.HAVE_CURRENT_DATA) {
      if (Date.now() > timeout) throw new Error('Timeout waiting for video first frame');
      await delay(50);
    }
  }

  startStats() {
    this.stopStats();
    this.statsInterval = setInterval(() => {
      try {
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.RECORDING_STATS,
          data: {
            duration: 0, // Offscreen은 세부 타임 안씀. SW가 표시만 함
            size: this.totalSize,
            isRecording: this.recorder && this.recorder.state === 'recording',
            isPaused: this.recorder && this.recorder.state === 'paused'
          }
        });
      } catch {
        // noop
      }
    }, 500);
  }

  stopStats() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  async stopRecording() {
    try {
      if (!this.recorder || this.recorder.state === 'inactive') {
        return { success: false, error: 'Not recording' };
      }
      this.isRecording = false;
      // 플러시
      try {
        this.recorder.requestData();
        await delay(150);
      } catch {}
      this.recorder.stop();
      return { success: true };
    } catch (e) {
      console.error('[Offscreen] stopRecording error:', e);
      return { success: false, error: e.message };
    }
  }

  pauseRecording() {
    try {
      if (this.recorder && this.recorder.state === 'recording') {
        this.recorder.pause();
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      console.error('[Offscreen] pauseRecording error:', e);
      return { success: false };
    }
  }

  resumeRecording() {
    try {
      if (this.recorder && this.recorder.state === 'paused') {
        this.recorder.resume();
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      console.error('[Offscreen] resumeRecording error:', e);
      return { success: false };
    }
  }

  async cancelRecording() {
    try {
      this.isRecording = false;
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
      this.stopStats();
      await this.cleanup();
      return { success: true };
    } catch (e) {
      console.error('[Offscreen] cancelRecording error:', e);
      return { success: false };
    }
  }

  async finalize() {
    try {
      if (!this.chunks.length || this.totalSize < 10) {
        console.error('[Offscreen] No valid chunks. size:', this.totalSize);
        await this.cleanup();
        return;
      }
      const blob = new Blob(this.chunks, { type: this.chunks[0].type || REC_MIME });
      console.log('[Offscreen] Blob created:', blob.size, 'type:', blob.type);

      // DB 메타 저장
      try {
        await storageManager.saveRecording({
          id: this.currentRecordingId,
          timestamp: Date.now(),
          duration: 0,
          size: this.totalSize,
          format: blob.type,
          filename: generateFilename('webm')
        });
      } catch (e) {
        console.warn('[Offscreen] saveRecording meta failed:', e.message);
      }

      // 다운로드
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = generateFilename('webm');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      await this.cleanup();
    } catch (e) {
      console.error('[Offscreen] finalize error:', e);
      await this.cleanup();
    }
  }

  async cleanup() {
    try {
      this.isRecording = false;
      if (this.drawTimer) {
        clearInterval(this.drawTimer);
        this.drawTimer = null;
      }
      if (this.recorder) {
        try {
          if (this.recorder.state !== 'inactive') this.recorder.stop();
        } catch {}
        this.recorder = null;
      }
      if (this.mediaStream) {
        try {
          this.mediaStream.getTracks().forEach((t) => t.stop());
        } catch {}
        this.mediaStream = null;
      }
      if (this.video) {
        try {
          this.video.pause();
          this.video.srcObject = null;
        } catch {}
        this.video = null;
      }
      this.stopStats();
      // 캔버스는 남겨도 되지만 초기화
      // this.canvas = null; // 계속 재사용
      this.chunks = [];
      this.totalSize = 0;
      this.currentRecordingId = null;
    } catch (e) {
      console.warn('[Offscreen] cleanup error:', e);
    }
  }
}

new OffscreenRecorder();
console.log('[Offscreen] Document ready');