import { MESSAGE_TYPES, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';
import { generateFilename } from '../utils/video-utils.js';
import { LaserPointer } from './laser-pointer.js';
import { GifEncoderManager } from './gif-encoder.js';

const REC_MIME = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

class OffscreenRecorder {
  constructor() {
    this.mediaStream = null;
    this.recorder = null;
    this.chunks = [];
    this.totalSize = 0;
    this.currentRecordingId = null;
    this.canvas = null;
    this.ctx = null;
    this.timer = null;
    this.video = null;
    this.statsInterval = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.accumulatedPause = 0;
    
    // GIF Recording specific
    this.gifEncoder = null;
    this.isGifRecording = false;
    
    this.state = {
      fps: 30,
      quality: 'HIGH',
      includeAudio: true,
      cropArea: null,
      showCursor: true,
      laserPointerEnabled: false,
      zoomHighlightEnabled: false,
      zoomHighlightDurationSec: 3,
      zoomHighlightScale: 1.2,
      format: 'WEBM', // NEW: 녹화 포맷 설정
      gifFps: 10,        // NEW: GIF 전용 FPS
      gifDither: false   // NEW: GIF 디더링 옵션
    };
    
    this.laser = new LaserPointer();
    this.cursorPos = { x: 0, y: 0 };
    this.zoomAnim = null;
    this.viewport = { w: 0, h: 0, dpr: 1 };
    this.scaleX = 1;
    this.scaleY = 1;
    this.currentCrop = null;
    this.frameDebugLogged = false;
    
    this.setupMessageHandlers();
    this.init();
  }

  async init() {
    try {
      await storageManager.init();
      
      // GIF 라이브러리 미리 로드 시도
      try {
        const gifManager = new GifEncoderManager();
        await gifManager.loadLibrary();
        console.log('[Offscreen] GIF.js preloaded successfully');
      } catch (e) {
        console.warn('[Offscreen] Failed to preload GIF.js:', e.message);
      }
      
      await this.notifyReady();
    } catch (e) {
      console.error('[Offscreen] Initialization error:', e);
    }
  }

  async notifyReady() {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_READY }, () => resolve());
      });
    } catch {}
  }

  setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.target !== 'offscreen') return;
      this.handleMessage(message).then((res) => sendResponse(res || { success: true })).catch((err) => {
        console.error('[Offscreen] Message handling error:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true;
    });
  }

  async handleMessage(message) {
    switch (message.type) {
      case MESSAGE_TYPES.START_RECORDING: return this.startRecording(message.data);
      case MESSAGE_TYPES.STOP_RECORDING: return this.stopRecording();
      case MESSAGE_TYPES.PAUSE_RECORDING: return this.pauseRecording();
      case MESSAGE_TYPES.RESUME_RECORDING: return this.resumeRecording();
      case MESSAGE_TYPES.CANCEL_RECORDING: return this.cancelRecording();
      case MESSAGE_TYPES.UPDATE_PREFS: this.updatePrefs(message.data); return { success: true };
      case MESSAGE_TYPES.TOGGLE_LASER:
        this.state.laserPointerEnabled = !this.state.laserPointerEnabled;
        this.laser.setEnabled(this.state.laserPointerEnabled);
        return { success: true };
      case MESSAGE_TYPES.LASER_MOVED:
        this.cursorPos = { x: message.data.x, y: message.data.y };
        this.laser.move(this.cursorPos.x, this.cursorPos.y);
        return { success: true };
      case MESSAGE_TYPES.TOGGLE_CURSOR:
        this.state.showCursor = !this.state.showCursor;
        return { success: true };
      case MESSAGE_TYPES.TOGGLE_ZOOM_HIGHLIGHT:
        this.state.zoomHighlightEnabled = !this.state.zoomHighlightEnabled;
        chrome.runtime.sendMessage({ type: 'zoom-highlight-toggle', data: { enabled: this.state.zoomHighlightEnabled } });
        return { success: true };
      case MESSAGE_TYPES.ZOOM_HIGHLIGHT_AREA:
        if (this.state.zoomHighlightEnabled) this.triggerZoomAnimation(message.data);
        return { success: true };
      case MESSAGE_TYPES.VIEWPORT_INFO:
        this.viewport = {
          w: message.data.viewportWidth || 0,
          h: message.data.viewportHeight || 0,
          dpr: message.data.dpr || 1
        };
        this.recalcScales();
        return { success: true };
      default:
        return { success: true };
    }
  }

  updatePrefs(prefs) {
    const merged = { ...DEFAULT_PREFERENCES, ...prefs };
    this.state.fps = merged.fps || 30;
    this.state.quality = merged.quality || 'HIGH';
    this.state.includeAudio = merged.includeAudio !== false;
    this.state.showCursor = merged.showCursor !== false;
    this.state.laserPointerEnabled = !!merged.laserPointerEnabled;
    this.state.zoomHighlightEnabled = !!merged.zoomHighlightEnabled;
    this.state.zoomHighlightDurationSec = merged.zoomHighlightDurationSec || 3;
    this.state.zoomHighlightScale = merged.zoomHighlightScale || 1.2;
    this.state.format = merged.format || 'WEBM'; // NEW: 포맷 설정
    this.state.gifFps = merged.gifFps || 10;
    this.state.gifDither = !!merged.gifDither;
    this.laser.setEnabled(this.state.laserPointerEnabled);
  }

  recalcScales() {
    if (!this.video) return;
    const vW = this.video.videoWidth || 1;
    const vH = this.video.videoHeight || 1;
    if (this.viewport.w > 0 && this.viewport.h > 0) {
      this.scaleX = vW / this.viewport.w;
      this.scaleY = vH / this.viewport.h;
    } else {
      const dpr = self.devicePixelRatio || 1;
      this.scaleX = dpr;
      this.scaleY = dpr;
    }
  }

  async startRecording({ streamId, cropAreaCSS, view, preferences }) {
    try {
      console.log('[Offscreen] ========== 녹화 시작 ==========');
      
      this.updatePrefs(preferences || {});

      if (!view && cropAreaCSS) {
        console.error('[Offscreen] View context is missing');
        return { success: false, error: 'View context is missing' };
      }

      // Step 1: 미디어 스트림 획득
      const needAudio = this.state.includeAudio && this.state.format !== 'GIF';
      
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: needAudio ? {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
        } : false,
        video: {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
        }
      });

      this.video = document.createElement('video');
      this.video.srcObject = this.mediaStream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      await this.waitForFirstFrame(this.video);

      const videoWidth = this.video.videoWidth;
      const videoHeight = this.video.videoHeight;

      console.log('[Offscreen] Video stream:', videoWidth, 'x', videoHeight);
      console.log('[Offscreen] Recording format:', this.state.format);

      // Step 2: 콘텐츠 오프셋 감지
      const contentOffset = await this.detectContentOffset(this.video, videoWidth, videoHeight);
      console.log('[Offscreen] Detected content offset:', contentOffset);

      // Step 3: Crop 영역 계산
      let videoCrop;
      if (cropAreaCSS) {
        videoCrop = {
          x: cropAreaCSS.x,
          y: cropAreaCSS.y + contentOffset.top,
          width: cropAreaCSS.width,
          height: cropAreaCSS.height
        };
      } else {
        videoCrop = {
          x: 0,
          y: contentOffset.top,
          width: videoWidth,
          height: videoHeight - contentOffset.top - contentOffset.bottom
        };
      }

      // Step 4: 경계 검증
      videoCrop.x = Math.max(0, Math.min(videoCrop.x, videoWidth - 1));
      videoCrop.y = Math.max(0, Math.min(videoCrop.y, videoHeight - 1));
      videoCrop.width = Math.max(1, Math.min(videoCrop.width, videoWidth - videoCrop.x));
      videoCrop.height = Math.max(1, Math.min(videoCrop.height, videoHeight - videoCrop.y));

      console.log('[Offscreen] Final video crop:', videoCrop);

      const isValid = (videoCrop.x + videoCrop.width <= videoWidth) && 
                      (videoCrop.y + videoCrop.height <= videoHeight);

      if (!isValid) {
        console.error('[Offscreen] Crop exceeds video bounds!');
        return { success: false, error: 'Crop area exceeds video bounds' };
      }

      this.currentCrop = videoCrop;

      // Step 5: Canvas 설정
      this.canvas = document.getElementById('rec-canvas');
      if (!this.canvas) throw new Error('Canvas not found');

      this.canvas.width = videoCrop.width;
      this.canvas.height = videoCrop.height;
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: false });

      console.log('[Offscreen] Canvas:', this.canvas.width, 'x', this.canvas.height);

      // Step 6: 포맷별 녹화 시작
      if (this.state.format === 'GIF') {
        await this.startGifRecording();
      } else {
        await this.startVideoRecording();
      }

      this.startedAt = Date.now();
      this.accumulatedPause = 0;
      this.pausedAt = 0;
      this.startStats();

      // Step 7: 프레임 렌더링 시작
      const targetFPS = this.state.format === 'GIF' ? 
        this.state.gifFps : 
        clamp(this.state.fps, 10, 60);
      const intervalMs = Math.max(15, Math.floor(1000 / targetFPS));

      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.renderFrame(), intervalMs);

      console.log('[Offscreen] Recording started successfully');
      console.log('[Offscreen] Target FPS:', targetFPS, 'Interval:', intervalMs + 'ms');
      console.log('[Offscreen] ========== 녹화 준비 완료 ==========');
      
      return { success: true };

    } catch (e) {
      console.error('[Offscreen] Error:', e);
      await this.cleanup();
      return { success: false, error: e.message };
    }
  }

  // GIF 녹화 시작
  async startGifRecording() {
    console.log('[Offscreen] Starting GIF recording...');
    
    try {
      this.gifEncoder = new GifEncoderManager();
      
      // 이벤트 핸들러 설정
      this.gifEncoder.onProgress = (progress) => {
        console.log('[Offscreen] GIF encoding progress:', Math.round(progress * 100) + '%');
        // UI 업데이트를 위해 메시지 전송
        try {
          chrome.runtime.sendMessage({
            type: 'GIF_ENCODING_PROGRESS',
            data: { progress: Math.round(progress * 100) }
          });
        } catch {}
      };

      this.gifEncoder.onFinished = async (blob) => {
        console.log('[Offscreen] GIF encoding completed, size:', blob.size);
        await this.finalizeGif(blob);
      };

      this.gifEncoder.onError = (error) => {
        console.error('[Offscreen] GIF encoding error:', error);
        alert('GIF 인코딩 중 오류가 발생했습니다: ' + error.message);
        this.cleanup();
      };

      // 인코더 초기화
      await this.gifEncoder.initialize({
        quality: this.getGifQuality(),
        workers: 2,
        dither: this.state.gifDither,
        width: this.canvas.width,
        height: this.canvas.height,
        fps: this.state.gifFps
      });

      this.isGifRecording = true;
      this.currentRecordingId = `recording_${Date.now()}`;

      console.log('[Offscreen] GIF encoder initialized:', this.gifEncoder.getStatus());

    } catch (error) {
      console.error('[Offscreen] Failed to start GIF recording:', error);
      throw new Error('GIF 녹화를 시작할 수 없습니다: ' + error.message);
    }
  }

  // 비디오 녹화 시작 (기존 WebM)
  async startVideoRecording() {
    const targetFPS = clamp(this.state.fps, 10, 60);
    const canvasStream = this.canvas.captureStream(targetFPS);

    const aTrack = this.mediaStream.getAudioTracks()[0];
    if (aTrack) {
      try {
        canvasStream.addTrack(aTrack);
        console.log('[Offscreen] Audio track added');
      } catch (e) {
        console.warn('[Offscreen] Failed to add audio:', e);
      }
    }

    const options = {
      mimeType: REC_MIME,
      videoBitsPerSecond: this.qualityToBitrate(this.state.quality),
      audioBitsPerSecond: 128000
    };

    this.recorder = new MediaRecorder(canvasStream, options);
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
          console.warn('[Offscreen] Failed to save chunk:', err);
        }
      }
    };

    this.recorder.onstop = async () => {
      this.stopStats();
      await this.finalize();
    };

    this.recorder.start(1000);
  }

  getGifQuality() {
    switch (this.state.quality) {
      case 'LOW': return 20;
      case 'MEDIUM': return 10;
      case 'HIGH': return 5;
      case 'ULTRA': return 1;
      default: return 10;
    }
  }

  async detectContentOffset(video, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    ctx.drawImage(video, 0, 0);

    let topOffset = 0;
    let previousBrightness = this.getRowBrightness(ctx, 0, width);

    for (let y = 1; y < Math.min(200, height); y++) {
      const currentBrightness = this.getRowBrightness(ctx, y, width);
      const diff = Math.abs(currentBrightness - previousBrightness);

      if (diff > 50) {
        topOffset = y;
        break;
      }

      previousBrightness = currentBrightness;
    }

    const bottomOffset = 0;
    canvas.remove();

    return { top: topOffset, bottom: bottomOffset };
  }

  getRowBrightness(ctx, y, width) {
    const imageData = ctx.getImageData(0, y, width, 1);
    const data = imageData.data;
    let sum = 0;

    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }

    return sum / (data.length / 4);
  }

  renderFrame() {
    try {
      if (!this.video || !this.canvas || !this.currentCrop || !this.ctx) return;

      const crop = this.currentCrop;

      if (!this.frameDebugLogged) {
        console.log('[renderFrame] 프레임 렌더링 시작');
        console.log('  - Video:', this.video.videoWidth, 'x', this.video.videoHeight);
        console.log('  - Canvas:', this.canvas.width, 'x', this.canvas.height);
        console.log('  - Crop:', crop);
        console.log('  - Format:', this.state.format);
        this.frameDebugLogged = true;
      }

      // Canvas에 비디오 프레임 그리기
      this.ctx.drawImage(
        this.video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );

      // 오버레이 그리기
      if (this.zoomAnim) this.drawZoom();
      if (this.state.showCursor) this.drawCursor();
      if (this.state.laserPointerEnabled) this.laser.draw(this.ctx);

      // GIF 녹화 중이면 프레임 추가
      if (this.isGifRecording && this.gifEncoder && !this.pausedAt) {
        const added = this.gifEncoder.addFrame(this.canvas);
        
        // 최대 프레임 도달 시 자동 중지
        if (!added && this.gifEncoder.frameCount >= this.gifEncoder.maxFrames) {
          console.warn('[Offscreen] Maximum GIF frame count reached, stopping...');
          this.stopRecording();
        }
      }

    } catch (e) {
      console.error('[renderFrame] Error:', e);
    }
  }

  qualityToBitrate(q) {
    switch (q) {
      case 'LOW': return 2000000;
      case 'MEDIUM': return 5000000;
      case 'ULTRA': return 15000000;
      case 'HIGH':
      default: return 8000000;
    }
  }

  async waitForFirstFrame(video) {
    const deadline = Date.now() + 10000;
    while (video.readyState < video.HAVE_CURRENT_DATA) {
      if (Date.now() > deadline) throw new Error('Timeout waiting for first frame');
      await delay(50);
    }
  }

  drawCursor() {
    const x = this.cursorPos.x;
    const y = this.cursorPos.y;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(x, y, 6, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(255,255,255,0.95)';
    this.ctx.fill();
    this.ctx.beginPath();
    this.ctx.arc(x, y, 8, 0, Math.PI * 2);
    this.ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
    this.ctx.restore();
  }

  triggerZoomAnimation(area) {
    const dur = Math.max(1, this.state.zoomHighlightDurationSec) * 1000;
    const scale = Math.max(1.0, this.state.zoomHighlightScale);
    const now = Date.now();
    this.zoomAnim = { area, scale, dur, start: now };
    setTimeout(() => {
      if (this.zoomAnim && Date.now() - this.zoomAnim.start >= dur) this.zoomAnim = null;
    }, dur + 50);
  }

  drawZoom() {
    if (!this.zoomAnim || !this.currentCrop) return;
    const crop = this.currentCrop;
    const { area, scale, start, dur } = this.zoomAnim;
    const t = Date.now() - start;
    if (t > dur) {
      this.zoomAnim = null;
      return;
    }
    const sx = clamp(area.x - crop.x, 0, crop.width);
    const sy = clamp(area.y - crop.y, 0, crop.height);
    const sw = clamp(area.width, 1, crop.width - sx);
    const sh = clamp(area.height, 1, crop.height - sy);
    const cx = sx + sw / 2;
    const cy = sy + sh / 2;
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = clamp(cx - dw / 2, 0, crop.width - dw);
    const dy = clamp(cy - dh / 2, 0, crop.height - dh);

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(dx, dy, dw, dh);
    this.ctx.clip();
    this.ctx.drawImage(this.canvas,
      Math.round(sx * this.scaleX),
      Math.round(sy * this.scaleY),
      Math.round(sw * this.scaleX),
      Math.round(sh * this.scaleY),
      dx, dy, dw, dh
    );
    this.ctx.restore();

    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(255,255,0,0.8)';
    this.ctx.lineWidth = 3;
    this.ctx.strokeRect(dx, dy, dw, dh);
    this.ctx.restore();
  }

  startStats() {
    this.stopStats();
    this.statsInterval = setInterval(() => {
      let duration = 0;
      if (this.startedAt) {
        const now = Date.now();
        const pausedDelta = this.pausedAt ? now - this.pausedAt : 0;
        duration = now - this.startedAt - this.accumulatedPause - pausedDelta;
        if (duration < 0) duration = 0;
      }
      
      let size = this.totalSize;
      if (this.isGifRecording && this.gifEncoder) {
        const status = this.gifEncoder.getStatus();
        size = status.estimatedSize;
      }
      
      try {
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.RECORDING_STATS,
          data: {
            duration,
            size,
            isRecording: this.isGifRecording || (this.recorder && this.recorder.state === 'recording'),
            isPaused: this.pausedAt > 0,
            frameCount: this.isGifRecording && this.gifEncoder ? this.gifEncoder.frameCount : 0
          }
        });
      } catch {}
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
      if (this.isGifRecording) {
        if (!this.gifEncoder) {
          return { success: false, error: 'Not recording' };
        }
        
        const status = this.gifEncoder.getStatus();
        console.log('[Offscreen] Stopping GIF recording:', status);
        
        if (status.frameCount === 0) {
          throw new Error('No frames recorded');
        }
        
        // 인코딩 시작
        this.gifEncoder.render();
        
        return { success: true };
      } else {
        if (!this.recorder || this.recorder.state === 'inactive') {
          return { success: false, error: 'Not recording' };
        }
        try {
          this.recorder.requestData();
          await delay(120);
        } catch {}
        this.recorder.stop();
        return { success: true };
      }
    } catch (e) {
      console.error('[Offscreen] Stop recording error:', e);
      return { success: false, error: e.message };
    }
  }

  pauseRecording() {
    try {
      if (this.isGifRecording) {
        this.pausedAt = Date.now();
        console.log('[Offscreen] GIF recording paused');
        return { success: true };
      } else if (this.recorder && this.recorder.state === 'recording') {
        this.recorder.pause();
        this.pausedAt = Date.now();
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      console.error('[pauseRecording] Error:', e);
      return { success: false, error: e.message };
    }
  }

  resumeRecording() {
    try {
      if (this.isGifRecording) {
        if (this.pausedAt) {
          this.accumulatedPause += Date.now() - this.pausedAt;
          this.pausedAt = 0;
          console.log('[Offscreen] GIF recording resumed');
        }
        return { success: true };
      } else if (this.recorder && this.recorder.state === 'paused') {
        this.recorder.resume();
        if (this.pausedAt) {
          this.accumulatedPause += Date.now() - this.pausedAt;
          this.pausedAt = 0;
        }
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      console.error('[resumeRecording] Error:', e);
      return { success: false, error: e.message };
    }
  }

  async cancelRecording() {
    try {
      if (this.isGifRecording) {
        if (this.gifEncoder) {
          this.gifEncoder.abort();
          this.gifEncoder.destroy();
          this.gifEncoder = null;
        }
        this.isGifRecording = false;
        console.log('[Offscreen] GIF recording cancelled');
      } else if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
      this.stopStats();
      await this.cleanup();
      return { success: true };
    } catch (e) {
      console.error('[cancelRecording] Error:', e);
      return { success: false, error: e.message };
    }
  }

  async finalizeGif(blob) {
    try {
      console.log('[Offscreen] Finalizing GIF, size:', blob.size);
      
      // 파일 저장
      try {
        await storageManager.saveRecording({
          id: this.currentRecordingId,
          timestamp: Date.now(),
          duration: Date.now() - this.startedAt,
          size: blob.size,
          format: 'image/gif',
          filename: generateFilename('gif')
        });
      } catch (e) {
        console.warn('[Offscreen] Failed to save recording metadata:', e);
      }

      // 다운로드
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = generateFilename('gif');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      console.log('[Offscreen] GIF download initiated');
      
      await this.cleanup();
    } catch (e) {
      console.error('[finalizeGif] Error:', e);
      await this.cleanup();
    }
  }

  async finalize() {
    try {
      if (!this.chunks.length || this.totalSize < 10) {
        await this.cleanup();
        return;
      }

      const blob = new Blob(this.chunks, { type: this.chunks[0].type || REC_MIME });

      try {
        await storageManager.saveRecording({
          id: this.currentRecordingId,
          timestamp: Date.now(),
          duration: 0,
          size: this.totalSize,
          format: blob.type,
          filename: generateFilename('webm')
        });
      } catch {}

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
      console.error('[finalize] Error:', e);
      await this.cleanup();
    }
  }

  async cleanup() {
    try {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this.recorder) {
        try {
          if (this.recorder.state !== 'inactive') this.recorder.stop();
        } catch {}
        this.recorder = null;
      }
      if (this.gifEncoder) {
        this.gifEncoder.destroy();
        this.gifEncoder = null;
      }
      if (this.mediaStream) {
        try {
          this.mediaStream.getTracks().forEach(t => t.stop());
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
      this.chunks = [];
      this.isGifRecording = false;
      this.totalSize = 0;
      this.currentRecordingId = null;
      this.zoomAnim = null;
      this.startedAt = 0;
      this.pausedAt = 0;
      this.accumulatedPause = 0;
      this.frameDebugLogged = false;
      
      console.log('[Offscreen] Cleanup completed');
    } catch (e) {
      console.error('[cleanup] Error:', e);
    }
  }
}

new OffscreenRecorder();
