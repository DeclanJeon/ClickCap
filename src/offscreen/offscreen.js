import { MESSAGE_TYPES, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { generateFilename } from '../utils/video-utils.js';

const REC_MIME = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
  ? 'video/webm;codecs=vp9,opus'
  : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
  ? 'video/webm;codecs=vp8,opus'
  : 'video/webm';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
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
    this.isStopping = false;
    this.currentCrop = null;
    this.frameCount = 0;
    this.calibrated = false;
    this.calibratedOffsetY = 0;

    // 기본 설정 (DEFAULT_PREFERENCES에서 가져옴)
    this.state = {
      fps: DEFAULT_PREFERENCES.fps || 30,
      quality: DEFAULT_PREFERENCES.quality || 'HIGH',
      includeAudio: DEFAULT_PREFERENCES.includeAudio !== false
    };

    // 줌 관련 상태 추가
    this.zoomState = {
      isZooming: false,
      targetArea: null,
      startTime: 0,
      duration: 800,
      scale: 1.5,
      easeProgress: 0
    };

    this.setupMessageHandlers();
    this.init();
  }

  async init() {
    try {
      console.log('✅ [Offscreen] Initialized with default settings:', this.state);
      await this.notifyReady();
    } catch (e) {
      console.error('[Offscreen] Init error:', e);
    }
  }

  async notifyReady() {
    for (let i = 0; i < 5; i++) {
      try {
        await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_READY }, r => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(r);
          });
        });
        console.log('✅ [Offscreen] Ready notification sent');
        break;
      } catch (e) {
        if (i < 4) await delay(200 * (i + 1));
      }
    }
  }

  setupMessageHandlers() {
    this.messageQueue = [];
    this.processingQueue = false;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.target !== 'offscreen') return;
      if (message.type === 'ping') {
        sendResponse({ success: true });
        return true;
      }
      this.messageQueue.push({ message, sendResponse });
      if (!this.processingQueue) this.processMessageQueue();
      return true;
    });
  }

  async processMessageQueue() {
    if (this.processingQueue || !this.messageQueue.length) return;
    this.processingQueue = true;
    while (this.messageQueue.length > 0) {
      const { message, sendResponse } = this.messageQueue.shift();
      try {
        const result = await this.handleMessage(message);
        sendResponse(result || { success: true });
        await delay(10);
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    }
    this.processingQueue = false;
  }

  async handleMessage(message) {
    switch (message.type) {
      case MESSAGE_TYPES.START_RECORDING: return this.startRecording(message.data);
      case MESSAGE_TYPES.STOP_RECORDING: return this.stopRecording();
      case MESSAGE_TYPES.PAUSE_RECORDING: return this.pauseRecording();
      case MESSAGE_TYPES.RESUME_RECORDING: return this.resumeRecording();
      case MESSAGE_TYPES.CANCEL_RECORDING: return this.cancelRecording();
      case MESSAGE_TYPES.UPDATE_PREFS: this.updatePrefs(message.data); return { success: true };
      case MESSAGE_TYPES.ELEMENT_CLICKED_ZOOM: return this.handleElementZoom(message.data);
      default: return { success: true };
    }
  }

  updatePrefs(prefs) {
    if (!prefs) return;
    
    const oldState = { ...this.state };
    
    if (typeof prefs.fps !== 'undefined') {
      this.state.fps = clamp(parseInt(prefs.fps, 10), 10, 60);
    }
    
    if (typeof prefs.quality !== 'undefined') {
      this.state.quality = prefs.quality;
    }
    
    if (typeof prefs.includeAudio !== 'undefined') {
      this.state.includeAudio = prefs.includeAudio;
    }
    
    console.log('🔧 [Offscreen] Preferences updated:', {
      old: oldState,
      new: this.state
    });
    
    this.updateZoomPreferences(prefs);
  }

  updateZoomPreferences(prefs) {
    if (!prefs) return;
    
    if (typeof prefs.elementZoomScale !== 'undefined') {
      this.zoomState.scale = parseFloat(prefs.elementZoomScale) || 1.5;
    }
    
    if (typeof prefs.elementZoomDuration !== 'undefined') {
      this.zoomState.duration = parseInt(prefs.elementZoomDuration, 10) || 800;
    }
  }

  handleElementZoom(data) {
    if (!data?.zoomArea) return { success: false };
    
    this.zoomState.isZooming = true;
    this.zoomState.targetArea = data.zoomArea;
    this.zoomState.startTime = data.timestamp || Date.now();
    this.zoomState.easeProgress = 0;
    
    console.log('🔍 [Zoom] Started:', {
      area: this.zoomState.targetArea,
      scale: this.zoomState.scale,
      duration: this.zoomState.duration
    });
    
    return { success: true };
  }

  async startRecording({ streamId, cropAreaCSS, view, preferences }) {
    try {
      // 설정 먼저 업데이트
      this.updatePrefs(preferences || {});
      
      console.log('🎬 [Offscreen] Starting recording with settings:', {
        fps: this.state.fps,
        quality: this.state.quality,
        bitrate: this.qualityToBitrate(this.state.quality),
        includeAudio: this.state.includeAudio
      });

      // 미디어 스트림 가져오기
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

      const vW = this.video.videoWidth;
      const vH = this.video.videoHeight;

      console.log('📹 [Offscreen] Video stream ready:', vW + 'x' + vH);

      let crop;
      if (cropAreaCSS && view) {
        const extraVertical = vH - view.viewportHeight;
        const approxTopOffset = extraVertical > 0 ? Math.round(extraVertical * 0.5) : 0;

        const RAW_MARGIN = {
          left: 3,
          right: 3,
          top: 3,
          bottom: 7
        };

        crop = {
          x: Math.round(cropAreaCSS.x) + RAW_MARGIN.left,
          y: Math.round(cropAreaCSS.y + approxTopOffset) + RAW_MARGIN.top,
          width: Math.round(cropAreaCSS.width) - (RAW_MARGIN.left + RAW_MARGIN.right),
          height: Math.round(cropAreaCSS.height) - (RAW_MARGIN.top + RAW_MARGIN.bottom)
        };

        crop.x = Math.max(0, Math.min(crop.x, vW - 1));
        crop.y = Math.max(0, Math.min(crop.y, vH - 1));
        crop.width = Math.max(10, Math.min(crop.width, vW - crop.x));
        crop.height = Math.max(10, Math.min(crop.height, vH - crop.y));
        
      } else {
        crop = { x: 0, y: 0, width: vW, height: vH };
      }

      this.currentCrop = crop;
      this.frameCount = 0;

      this.canvas = document.getElementById('rec-canvas');
      if (!this.canvas) {
        throw new Error('Canvas element not found');
      }
      
      this.canvas.width = crop.width;
      this.canvas.height = crop.height;
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      
      if (!this.ctx) {
        throw new Error('Failed to get canvas context');
      }

      console.log('🎨 [Offscreen] Canvas ready:', crop.width + 'x' + crop.height);

      // 녹화 시작
      await this.startVideoRecording();

      this.startedAt = Date.now();
      this.pausedAt = 0;
      this.accumulatedPause = 0;
      this.startStats();

      // FPS에 맞춰 프레임 렌더링
      const fps = this.state.fps;
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.renderFrame(), Math.floor(1000 / fps));

      console.log('✅ [Offscreen] Recording started with FPS:', fps);

      return { success: true };
      
    } catch (e) {
      console.error('[Offscreen] startRecording failed:', e);
      await this.cleanup();
      return { success: false, error: e.message };
    }
  }

  async startVideoRecording() {
    try {
      const fps = this.state.fps;
      const stream = this.canvas.captureStream(fps);
      
      console.log('🎥 [Offscreen] Canvas stream created with FPS:', fps);
      
      // 오디오 트랙 추가
      const audio = this.mediaStream.getAudioTracks()[0];
      if (audio && this.state.includeAudio) {
        try {
          stream.addTrack(audio);
          console.log('🔊 [Offscreen] Audio track added');
        } catch (e) {
          console.warn('⚠️ [Offscreen] Failed to add audio:', e);
        }
      }
      
      const bitrate = this.qualityToBitrate(this.state.quality);
      
      console.log('⚙️ [Offscreen] MediaRecorder settings:', {
        mimeType: REC_MIME,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 128000
      });
      
      this.recorder = new MediaRecorder(stream, {
        mimeType: REC_MIME,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 128000
      });

      this.chunks = [];
      this.totalSize = 0;
      this.currentRecordingId = `recording_${Date.now()}`;

      this.recorder.ondataavailable = e => {
        if (e.data?.size > 0) {
          this.chunks.push(e.data);
          this.totalSize += e.data.size;
        }
      };

      this.recorder.onstop = async () => {
        this.stopStats();
        await this.finalize();
      };

      this.recorder.onerror = (e) => {
        console.error('Recorder error:', e);
      };

      this.recorder.start(1000);
      
    } catch (e) {
      console.error('startVideoRecording failed:', e);
      throw e;
    }
  }

  renderFrame() {
    try {
      if (!this.video || !this.canvas || !this.currentCrop || !this.ctx) {
        return;
      }

      const c = this.currentCrop;

      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      // 줌 효과 적용
      if (this.zoomState.isZooming) {
        this.renderWithZoom(c);
      } else {
        // 일반 렌더링
        this.ctx.drawImage(
          this.video,
          c.x, c.y, c.width, c.height,
          0, 0, this.canvas.width, this.canvas.height
        );
      }

      this.frameCount++;
    } catch (e) {
      console.error('[renderFrame] Error:', e);
    }
  }

  renderWithZoom(cropArea) {
    const now = Date.now();
    const elapsed = now - this.zoomState.startTime;
    const progress = Math.min(elapsed / this.zoomState.duration, 1);
    
    // Ease-in-out 함수
    const easeInOutCubic = (t) => {
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };
    
    const easedProgress = easeInOutCubic(progress);
    
    // 줌 단계 계산 (0 → scale → 0)
    let currentScale;
    if (progress < 0.5) {
      // 줌 인 (0 → 1)
      currentScale = 1 + (this.zoomState.scale - 1) * (easedProgress * 2);
    } else {
      // 줌 아웃 (1 → 0)
      currentScale = 1 + (this.zoomState.scale - 1) * (2 - easedProgress * 2);
    }
    
    const zoomArea = this.zoomState.targetArea;
    
    // 줌 중심점 계산 (crop area 내의 상대 좌표)
    const zoomCenterX = zoomArea.x + zoomArea.width / 2;
    const zoomCenterY = zoomArea.y + zoomArea.height / 2;
    
    // 줌 적용된 영역 계산
    const scaledWidth = cropArea.width / currentScale;
    const scaledHeight = cropArea.height / currentScale;
    
    // 줌 중심을 기준으로 새로운 crop 영역 계산
    const zoomedX = cropArea.x + zoomCenterX - scaledWidth / 2;
    const zoomedY = cropArea.y + zoomCenterY - scaledHeight / 2;
    
    // 경계 체크 (최적화)
    const maxX = cropArea.x + cropArea.width - scaledWidth;
    const maxY = cropArea.y + cropArea.height - scaledHeight;
    const finalX = Math.max(cropArea.x, Math.min(zoomedX, maxX));
    const finalY = Math.max(cropArea.y, Math.min(zoomedY, maxY));
    
    // 성능 최적화: 이미지 품질 설정
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    
    // 줌 효과 렌더링
    this.ctx.drawImage(
      this.video,
      finalX, finalY, scaledWidth, scaledHeight,
      0, 0, this.canvas.width, this.canvas.height
    );
    
    // 줌 완료 체크
    if (progress >= 1) {
      this.zoomState.isZooming = false;
      console.log('✅ [Zoom] Completed');
    }
  }

  calibrateCropOffset() {
    try {
      const vW = this.video.videoWidth;
      const vH = this.video.videoHeight;

      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = vW;
      tmpCanvas.height = vH;
      const tmpCtx = tmpCanvas.getContext('2d');

      tmpCtx.drawImage(this.video, 0, 0, vW, vH);

      // 상단 0~400px 정도 안에서 "상당히 밝은/흰 영역"이 계속되는 구간을 찾는다
      const scanHeight = Math.min(400, vH);
      const threshold = 240; // 0~255
      let headerEndY = 0;

      for (let y = 0; y < scanHeight; y++) {
        const rowData = tmpCtx.getImageData(0, y, vW, 1).data;
        let brightPixels = 0;
        for (let i = 0; i < rowData.length; i += 4) {
          const r = rowData[i];
          const g = rowData[i + 1];
          const b = rowData[i + 2];
          const lum = (r + g + b) / 3;
          if (lum > threshold) brightPixels++;
        }
        const ratio = brightPixels / (rowData.length / 4);

        // 상단 UI는 거의 흰색/밝은 색 비율이 높고,
        // 영상 영역에 들어오면 비율이 확 떨어진다고 가정
        if (ratio < 0.7) {
          headerEndY = y;
          break;
        }
      }

      this.calibratedOffsetY = headerEndY;
      this.calibrated = true;

      console.log('📏 [Calibrate] headerEndY:', headerEndY);
      console.log('📏 [Calibrate] calibratedOffsetY set to:', this.calibratedOffsetY);

      tmpCanvas.remove();
    } catch (e) {
      console.warn('⚠️ [Calibrate] Failed, fall back to no offset:', e);
      this.calibratedOffsetY = 0;
      this.calibrated = true;
    }
  }


  qualityToBitrate(q) {
    const bitrateMap = {
      LOW: 2000000,      // 2 Mbps
      MEDIUM: 5000000,   // 5 Mbps
      HIGH: 8000000,     // 8 Mbps
      ULTRA: 15000000    // 15 Mbps
    };
    const bitrate = bitrateMap[q] || bitrateMap.HIGH;
    console.log(`📊 [Offscreen] Quality ${q} → Bitrate ${bitrate / 1000000} Mbps`);
    return bitrate;
  }

  async waitForFirstFrame(video) {
    const deadline = Date.now() + 10000;
    while (video.readyState < video.HAVE_CURRENT_DATA) {
      if (Date.now() > deadline) throw new Error('Timeout');
      await delay(50);
    }
  }

  startStats() {
    this.stopStats();
    
    this.statsInterval = setInterval(() => {
      let dur = 0;
      if (this.startedAt) {
        const now = Date.now();
        const pausedDelta = this.pausedAt ? now - this.pausedAt : 0;
        dur = now - this.startedAt - this.accumulatedPause - pausedDelta;
        if (dur < 0) dur = 0;
      }
      
      try {
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.RECORDING_STATS,
          data: {
            duration: dur,
            size: this.totalSize,
            isRecording: this.recorder?.state === 'recording',
            isPaused: this.pausedAt > 0
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('Failed to send stats:', chrome.runtime.lastError.message);
          }
        });
      } catch (e) {
        console.warn('Exception sending stats:', e);
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
    if (this.isStopping) return { success: true };
    this.isStopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stopStats();
    if (!this.recorder || this.recorder.state === 'inactive') {
      this.isStopping = false;
      return { success: false };
    }
    try { this.recorder.requestData(); await delay(120); } catch {}
    this.recorder.stop();
    return { success: true };
  }

  pauseRecording() {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.pausedAt = Date.now();
      return { success: true };
    }
    return { success: false };
  }

  resumeRecording() {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      if (this.pausedAt) {
        this.accumulatedPause += Date.now() - this.pausedAt;
        this.pausedAt = 0;
      }
      return { success: true };
    }
    return { success: false };
  }

  async cancelRecording() {
    if (this.recorder?.state !== 'inactive') this.recorder.stop();
    this.stopStats();
    await this.cleanup();
    return { success: true };
  }

  async finalize() {
    if (!this.chunks.length || this.totalSize < 10) {
      console.warn('⚠️ [Offscreen] No data to save');
      await this.cleanup();
      this.isStopping = false;
      
      try {
        chrome.runtime.sendMessage({ type: 'cleanup-recording-ui' });
      } catch {}
      
      return;
    }

    const blob = new Blob(this.chunks, { type: this.chunks[0].type || REC_MIME });
    
    console.log('💾 [Offscreen] Finalizing recording:', {
      size: (this.totalSize / 1024 / 1024).toFixed(2) + ' MB',
      chunks: this.chunks.length,
      type: blob.type
    });

    // Offscreen에서는 storage에 직접 접근하지 않음
    // Service Worker를 통해 처리됨

    // 파일 다운로드
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = generateFilename('webm');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // 완료 메시지 전송
    try {
      chrome.runtime.sendMessage({
        type: 'recording-finished',
        data: {
          format: 'WebM',
          size: this.totalSize,
          filename: generateFilename('webm')
        }
      });
    } catch (e) {
      console.warn('[Offscreen] Failed to send recording-finished:', e);
    }

    await this.cleanup();
    this.isStopping = false;
    
    console.log('✅ [Offscreen] Recording finalized successfully');
  }

  async cleanup() {
    console.log('🧹 [Offscreen] Cleanup started');
    
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
    this.currentCrop = null;
    this.frameCount = 0;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.accumulatedPause = 0;
    this.calibrated = false;
    this.calibratedOffsetY = 0;
    
    // 줌 상태 초기화
    this.zoomState.isZooming = false;
    this.zoomState.targetArea = null;
    this.zoomState.startTime = 0;
    this.zoomState.easeProgress = 0;
    
    console.log('✅ [Offscreen] Cleanup completed');
  }
}

new OffscreenRecorder();
