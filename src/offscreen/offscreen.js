import { MESSAGE_TYPES, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';
import { generateFilename } from '../utils/video-utils.js';
import { LaserPointer } from './laser-pointer.js';

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
    this.state = {
      fps: 30,
      quality: 'HIGH',
      includeAudio: true,
      cropArea: null,
      showCursor: true,
      laserPointerEnabled: false,
      zoomHighlightEnabled: false,
      zoomHighlightDurationSec: 3,
      zoomHighlightScale: 1.2
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
      await this.notifyReady();
    } catch {}
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
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: this.state.includeAudio ? {
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
      console.log('[Offscreen] Viewport (from content):', view.viewportWidth, 'x', view.viewportHeight);

      // ✅ Step 2: 비디오 스트림에서 실제 콘텐츠 시작 위치 자동 감지
      const contentOffset = await this.detectContentOffset(this.video, videoWidth, videoHeight);

      console.log('[Offscreen] Detected content offset:', contentOffset);

      // ✅ Step 3: CSS 좌표를 비디오 좌표로 변환 (오프셋 적용)
      let videoCrop;

      if (cropAreaCSS) {
        videoCrop = {
          x: cropAreaCSS.x,
          y: cropAreaCSS.y + contentOffset.top,  // ✅ 오프셋 적용!
          width: cropAreaCSS.width,
          height: cropAreaCSS.height
        };

        console.log('[Offscreen] CSS crop (user selection):', cropAreaCSS);
        console.log('[Offscreen] Video crop (with offset):', videoCrop);
      } else {
        // 전체 화면 녹화 - 콘텐츠 영역만
        videoCrop = {
          x: 0,
          y: contentOffset.top,
          width: videoWidth,
          height: videoHeight - contentOffset.top - contentOffset.bottom
        };
      }

      // Step 4: 범위 검증
      videoCrop.x = Math.max(0, Math.min(videoCrop.x, videoWidth - 1));
      videoCrop.y = Math.max(0, Math.min(videoCrop.y, videoHeight - 1));
      videoCrop.width = Math.max(1, Math.min(videoCrop.width, videoWidth - videoCrop.x));
      videoCrop.height = Math.max(1, Math.min(videoCrop.height, videoHeight - videoCrop.y));

      console.log('[Offscreen] Final video crop:', videoCrop);

      // 검증
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

      // Step 6: MediaRecorder 설정
      const targetFPS = clamp(this.state.fps, 10, 60);
      const intervalMs = Math.max(15, Math.floor(1000 / targetFPS));
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
      this.startedAt = Date.now();
      this.accumulatedPause = 0;
      this.pausedAt = 0;
      this.startStats();

      // Step 7: 프레임 렌더링 시작
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.renderFrame(), intervalMs);

      console.log('[Offscreen] Recording started successfully');
      console.log('[Offscreen] ========== 녹화 시작 완료 ==========');
      
      return { success: true };

    } catch (e) {
      console.error('[Offscreen] Error:', e);
      await this.cleanup();
      return { success: false, error: e.message };
    }
  }

  // ✅ 비디오 스트림에서 실제 콘텐츠 영역 자동 감지
  async detectContentOffset(video, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    ctx.drawImage(video, 0, 0);

    // 상단에서 밝기가 급격히 변하는 지점 찾기 (헤더 끝 = 콘텐츠 시작)
    let topOffset = 0;
    let previousBrightness = this.getRowBrightness(ctx, 0, width);

    for (let y = 1; y < Math.min(200, height); y++) {
      const currentBrightness = this.getRowBrightness(ctx, y, width);
      const diff = Math.abs(currentBrightness - previousBrightness);

      // 밝기 차이가 50 이상이면 경계로 판단
      if (diff > 50) {
        topOffset = y;
        console.log(`[detectContentOffset] Found edge at y=${y}, brightness change: ${previousBrightness.toFixed(1)} → ${currentBrightness.toFixed(1)}`);
        break;
      }

      previousBrightness = currentBrightness;
    }

    // 하단 오프셋 (보통 0)
    const bottomOffset = 0;

    canvas.remove();

    return { top: topOffset, bottom: bottomOffset };
  }

  // 특정 행의 평균 밝기 계산
  getRowBrightness(ctx, y, width) {
    const imageData = ctx.getImageData(0, y, width, 1);
    const data = imageData.data;
    let sum = 0;

    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }

    return sum / (data.length / 4);
  }

  // renderFrame은 그대로 유지
  renderFrame() {
    try {
      if (!this.video || !this.canvas || !this.currentCrop || !this.ctx) return;

      const crop = this.currentCrop;

      if (!this.frameDebugLogged) {
        console.log('[renderFrame] 첫 프레임 렌더링');
        console.log('  - Video:', this.video.videoWidth, 'x', this.video.videoHeight);
        console.log('  - Canvas:', this.canvas.width, 'x', this.canvas.height);
        console.log('  - Crop:', crop);
        console.log('  - Drawing: video[', crop.x, ',', crop.y, ',', crop.width, ',', crop.height, '] → canvas[0, 0,', this.canvas.width, ',', this.canvas.height, ']');
        this.frameDebugLogged = true;
      }

      // ✅ 비디오의 크롭 영역을 Canvas 전체에 그리기
      this.ctx.drawImage(
        this.video,
        crop.x,              // 소스 X
        crop.y,              // 소스 Y
        crop.width,          // 소스 Width
        crop.height,         // 소스 Height
        0,                   // 대상 X
        0,                   // 대상 Y
        this.canvas.width,   // 대상 Width
        this.canvas.height   // 대상 Height
      );

      // 추가 기능
      if (this.zoomAnim) this.drawZoom();
      if (this.state.showCursor) this.drawCursor();
      if (this.state.laserPointerEnabled) this.laser.draw(this.ctx);

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

  renderFrame() {
    try {
      if (!this.video || !this.canvas || !this.currentCrop || !this.ctx) return;

      const crop = this.currentCrop;

      if (!this.frameDebugLogged) {
        console.log('[renderFrame] 첫 프레임 렌더링');
        console.log('  - Video:', this.video.videoWidth, 'x', this.video.videoHeight);
        console.log('  - Canvas:', this.canvas.width, 'x', this.canvas.height);
        console.log('  - Crop:', crop);
        console.log('  - Drawing: video[', crop.x, ',', crop.y, ',', crop.width, ',', crop.height, '] → canvas[0, 0,', this.canvas.width, ',', this.canvas.height, ']');
        this.frameDebugLogged = true;
      }

      // ✅ 핵심: 비디오의 크롭 영역을 Canvas 전체에 그리기
      this.ctx.drawImage(
        this.video,
        crop.x,              // 소스 X (비디오 픽셀)
        crop.y,              // 소스 Y (비디오 픽셀)
        crop.width,          // 소스 Width (비디오 픽셀)
        crop.height,         // 소스 Height (비디오 픽셀)
        0,                   // 대상 X (Canvas 픽셀)
        0,                   // 대상 Y (Canvas 픽셀)
        this.canvas.width,   // 대상 Width (Canvas 픽셀)
        this.canvas.height   // 대상 Height (Canvas 픽셀)
      );

      // 추가 기능
      if (this.zoomAnim) this.drawZoom();
      if (this.state.showCursor) this.drawCursor();
      if (this.state.laserPointerEnabled) this.laser.draw(this.ctx);

    } catch (e) {
      console.error('[renderFrame] Error:', e);
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
      try {
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.RECORDING_STATS,
          data: {
            duration,
            size: this.totalSize,
            isRecording: this.recorder && this.recorder.state === 'recording',
            isPaused: this.recorder && this.recorder.state === 'paused'
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
      if (!this.recorder || this.recorder.state === 'inactive') {
        return { success: false, error: 'Not recording' };
      }
      try {
        this.recorder.requestData();
        await delay(120);
      } catch {}
      this.recorder.stop();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  pauseRecording() {
    try {
      if (this.recorder && this.recorder.state === 'recording') {
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
      if (this.recorder && this.recorder.state === 'paused') {
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
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      this.stopStats();
      await this.cleanup();
      return { success: true };
    } catch (e) {
      console.error('[cancelRecording] Error:', e);
      return { success: false, error: e.message };
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
      this.totalSize = 0;
      this.currentRecordingId = null;
      this.zoomAnim = null;
      this.startedAt = 0;
      this.pausedAt = 0;
      this.accumulatedPause = 0;
      this.frameDebugLogged = false;
    } catch (e) {
      console.error('[cleanup] Error:', e);
    }
  }
}

new OffscreenRecorder();
