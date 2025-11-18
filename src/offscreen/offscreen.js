import { MESSAGE_TYPES, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { generateFilename } from '../utils/video-utils.js';

const REC_MIME = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') 
  ? 'video/webm;codecs=vp9,opus' 
  : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
  ? 'video/webm;codecs=vp8,opus'
  : 'video/webm';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ============ 새로 추가: CSS → Video 좌표 변환 함수 ============
function buildCssToVideoTransform(videoWidth, videoHeight, view) {
  if (!view) {
    return {
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0
    };
  }

  const {
    viewportWidth,
    viewportHeight,
    dpr,
    scrollX,
    scrollY,
    vvScale,
    vvOffsetLeft,
    vvOffsetTop,
    vvWidth,
    vvHeight
  } = view;

  // 1) DPR 기반 스케일 추정
  const scaleX = videoWidth / (viewportWidth * dpr);
  const scaleYBase = videoHeight / (viewportHeight * dpr);

  // 2) visualViewport 반영
  const effectiveScaleX = scaleX * (vvScale || 1);
  const effectiveScaleY = scaleYBase * (vvScale || 1);

  // 3) 상단 UI 높이 추정
  const visibleCssHeight = vvHeight || viewportHeight;
  const visibleVideoHeight = visibleCssHeight * dpr * (vvScale || 1);
  const extraVertical = Math.max(0, videoHeight - visibleVideoHeight);
  const topUiPx = extraVertical * 0.5;

  // 4) 스크롤 오프셋 반영
  const offsetX = (scrollX + (vvOffsetLeft || 0)) * effectiveScaleX;
  const offsetY = topUiPx + (scrollY + (vvOffsetTop || 0)) * effectiveScaleY;

  return {
    scaleX: effectiveScaleX,
    scaleY: effectiveScaleY,
    offsetX,
    offsetY
  };
}
// ============================================================

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

    // 추가: 좌표 변환 정보 저장
    this.cropVideo = null;
    this.cropAreaCSS = null;
    this.viewContext = null;
    this.cssToVideoTransform = null;

    // GIF 관련
    this.gifEncoder = null;
    this.gifFrames = [];
    this.isGifMode = false;
    this.isEncodingGif = false;
    this.gifEncodingProgress = 0;

    // 줌 상태
    this.zoomState = {
      isZooming: false,
      targetArea: null,
      startTime: 0,
      holdDuration: 800,   // elementZoomDuration을 여기 저장
      inDuration: 200,
      outDuration: 200,
      scale: 1.5
    };

    // 설정
    this.state = {
      format: DEFAULT_PREFERENCES.format || 'webm',
      fps: DEFAULT_PREFERENCES.fps || 30,
      quality: DEFAULT_PREFERENCES.quality || 'HIGH',
      gifQuality: DEFAULT_PREFERENCES.gifQuality || 10,
      gifMaxWidth: DEFAULT_PREFERENCES.gifMaxWidth || 480,
      includeAudio: DEFAULT_PREFERENCES.includeAudio !== false,
      clickElementZoomEnabled: DEFAULT_PREFERENCES.clickElementZoomEnabled !== false,
      elementZoomScale: DEFAULT_PREFERENCES.elementZoomScale || 1.5,
      elementZoomDuration: DEFAULT_PREFERENCES.elementZoomDuration || 800
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
        console.error('[Offscreen] Message handling error:', e);
        sendResponse({ success: false, error: e.message });
      }
    }
    this.processingQueue = false;
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
      case MESSAGE_TYPES.UPDATE_PREFS: 
        this.updatePrefs(message.data); 
        return { success: true };
      case MESSAGE_TYPES.ELEMENT_CLICKED_ZOOM:
        return this.handleElementZoom(message.data);
      default: 
        return { success: true };
    }
  }

  updatePrefs(prefs) {
    if (!prefs) return;
    
    const oldState = { ...this.state };
    
    if (typeof prefs.format !== 'undefined') {
      this.state.format = prefs.format;
    }
    
    if (typeof prefs.fps !== 'undefined') {
      this.state.fps = clamp(parseInt(prefs.fps, 10), 10, 60);
    }
    
    if (typeof prefs.quality !== 'undefined') {
      this.state.quality = prefs.quality;
    }
    
    if (typeof prefs.gifQuality !== 'undefined') {
      this.state.gifQuality = clamp(parseInt(prefs.gifQuality, 10), 1, 30);
    }
    
    if (typeof prefs.gifMaxWidth !== 'undefined') {
      this.state.gifMaxWidth = clamp(parseInt(prefs.gifMaxWidth, 10), 320, 800);
    }
    
    if (typeof prefs.includeAudio !== 'undefined') {
      this.state.includeAudio = prefs.includeAudio;
    }

    if (typeof prefs.clickElementZoomEnabled !== 'undefined') {
      this.state.clickElementZoomEnabled = prefs.clickElementZoomEnabled;
    }

    if (typeof prefs.elementZoomScale !== 'undefined') {
      this.state.elementZoomScale = parseFloat(prefs.elementZoomScale) || 1.5;
      this.zoomState.scale = this.state.elementZoomScale;
    }

    if (typeof prefs.elementZoomDuration !== 'undefined') {
      this.state.elementZoomDuration = parseInt(prefs.elementZoomDuration, 10) || 800;
      this.zoomState.holdDuration = this.state.elementZoomDuration;
    }
    
    console.log('🔧 [Offscreen] Preferences updated:', {
      old: oldState,
      new: this.state
    });
  }

  handleElementZoom(data) {
  console.log('📥 [Offscreen] Zoom request received:', data);

  if (!data?.zoomArea) {
    console.warn('⚠️ [Offscreen] No zoom area provided');
    return { success: false, error: 'No zoom area' };
  }

  if (!this.state.clickElementZoomEnabled) {
    console.warn('⚠️ [Offscreen] Zoom disabled in preferences');
    return { success: false, error: 'Zoom disabled' };
  }

  // ✅ currentCrop 체크 제거 (줌은 crop과 독립적으로 작동해야 함)
  console.log('🔍 [Offscreen] Current state:', {
    hasCurrentCrop: !!this.currentCrop,
    isRecording: !!this.recorder,
    zoomEnabled: this.state.clickElementZoomEnabled,
    hasTransform: !!this.cssToVideoTransform
  });

  // ✅ Zoom state 업데이트
  this.zoomState.isZooming = true;
  this.zoomState.targetArea = data.zoomArea;
  this.zoomState.startTime = data.timestamp || Date.now();
  this.zoomState.scale = this.state.elementZoomScale || 1.5;
  this.zoomState.holdDuration = this.state.elementZoomDuration || 800;
  this.zoomState.inDuration = 200;
  this.zoomState.outDuration = 200;

  return { success: true };
}

  async startRecording({ streamId, cropAreaCSS, view, preferences }) {
    try {
      // 설정 먼저 업데이트
      this.updatePrefs(preferences || {});
      
      this.isGifMode = this.state.format === 'gif';
      this.isEncodingGif = false;
      this.gifEncodingProgress = 0;
      
      console.log('🎬 [Offscreen] Starting recording with settings:', {
        format: this.state.format,
        fps: this.state.fps,
        quality: this.state.quality,
        gifQuality: this.state.gifQuality,
        gifMaxWidth: this.state.gifMaxWidth,
        bitrate: this.isGifMode ? 'N/A' : this.qualityToBitrate(this.state.quality),
        includeAudio: this.state.includeAudio,
        clickZoom: this.state.clickElementZoomEnabled
      });

      // 미디어 스트림 가져오기
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: (this.state.includeAudio && !this.isGifMode) ? {
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

      // Crop 영역 계산
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

      // Canvas 설정
      this.canvas = document.getElementById('rec-canvas');
      if (!this.canvas) {
        throw new Error('Canvas element not found');
      }
      
      // GIF 모드일 경우 크기 조정
      if (this.isGifMode) {
        const aspectRatio = crop.height / crop.width;
        const gifWidth = Math.min(crop.width, this.state.gifMaxWidth);
        const gifHeight = Math.round(gifWidth * aspectRatio);
        
        this.canvas.width = gifWidth;
        this.canvas.height = gifHeight;
        
        console.log('🎨 [Offscreen] GIF Canvas size:', gifWidth + 'x' + gifHeight);
      } else {
        this.canvas.width = crop.width;
        this.canvas.height = crop.height;
        
        console.log('🎨 [Offscreen] Canvas ready:', crop.width + 'x' + crop.height);
      }
      
      // willReadFrequently 속성 추가 (GIF 모드에서 성능 개선)
      this.ctx = this.canvas.getContext('2d', { 
        alpha: false,
        willReadFrequently: this.isGifMode 
      });
      
      if (!this.ctx) {
        throw new Error('Failed to get canvas context');
      }

      // 녹화 시작
      if (this.isGifMode) {
        await this.initializeGifEncoder();
      } else {
        await this.startVideoRecording();
      }

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
      console.error('❌ [Offscreen] startRecording failed:', e);
      await this.cleanup();
      return { success: false, error: e.message };
    }
  }

  async initializeGifEncoder() {
    try {
      console.log('🎨 [Offscreen] Initializing GIF encoder...');
      
      if (typeof GIF === 'undefined') {
        throw new Error('GIF.js library not loaded');
      }
      
      this.gifEncoder = new GIF({
        workers: 2,
        quality: this.state.gifQuality,
        width: this.canvas.width,
        height: this.canvas.height,
        workerScript: chrome.runtime.getURL('src/vendor/gif.worker.js'),
        transparent: null,
        background: '#ffffff'
      });

      this.gifFrames = [];
      this.currentRecordingId = `recording_${Date.now()}`;

      this.gifEncoder.on('finished', (blob) => {
        console.log('✅ [Offscreen] GIF encoding finished');
        this.isEncodingGif = false;
        this.handleGifFinished(blob);
      });

      this.gifEncoder.on('progress', (progress) => {
        this.gifEncodingProgress = progress;
        console.log(`📊 [Offscreen] GIF encoding progress: ${(progress * 100).toFixed(1)}%`);
        
        // 진행률을 content script로 전송
        try {
          chrome.runtime.sendMessage({
            type: 'gif-encoding-progress',
            data: {
              progress: progress,
              percentage: Math.round(progress * 100)
            }
          }, () => {
            if (chrome.runtime.lastError) {
              // Silently ignore
            }
          });
        } catch (e) {
          // Silently ignore
        }
      });

      console.log('✅ [Offscreen] GIF encoder initialized');
      
    } catch (e) {
      console.error('❌ [Offscreen] initializeGifEncoder failed:', e);
      throw e;
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
        console.error('❌ [Offscreen] Recorder error:', e);
      };

      this.recorder.start(1000);
      console.log('✅ [Offscreen] MediaRecorder started');
      
    } catch (e) {
      console.error('❌ [Offscreen] startVideoRecording failed:', e);
      throw e;
    }
  }

  renderFrame() {
    try {
      if (!this.video || !this.canvas || !this.ctx) {
        return;
      }

      // ✅ currentCrop이 없으면 전체 비디오 렌더링
      const crop = this.currentCrop || {
        x: 0,
        y: 0,
        width: this.video.videoWidth,
        height: this.video.videoHeight
      };

      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      // ✅ 줌 상태 로그 (처음 몇 프레임만)
      if (this.frameCount < 5 || this.zoomState.isZooming) {
        console.log('🎞️ [Offscreen] Frame render:', {
          frameCount: this.frameCount,
          isZooming: this.zoomState.isZooming,
          zoomEnabled: this.state.clickElementZoomEnabled,
          hasCrop: !!this.currentCrop,
          canvasSize: { w: this.canvas.width, h: this.canvas.height },
          cropSize: { x: crop.x, y: crop.y, w: crop.width, h: crop.height }
        });
      }

      if (this.zoomState.isZooming && this.state.clickElementZoomEnabled) {
        this.renderWithZoom(crop);
      } else {
        // 일반 렌더링
        this.ctx.drawImage(
          this.video,
          crop.x, crop.y, crop.width, crop.height,
          0, 0, this.canvas.width, this.canvas.height
        );
      }

      // GIF 모드일 경우 프레임 캡처
      if (this.isGifMode && this.gifEncoder && !this.pausedAt) {
        const delay = Math.round(1000 / this.state.fps);
        this.gifEncoder.addFrame(this.ctx, { copy: true, delay });
        this.frameCount++;
        
        // 최대 프레임 수 제한 (메모리 보호)
        const maxFrames = this.state.fps * 60; // 최대 60초
        if (this.frameCount >= maxFrames) {
          console.warn('⚠️ [Offscreen] Max frames reached, stopping recording');
          this.stopRecording();
        }
      } else if (!this.isGifMode) {
        this.frameCount++;
      }

    } catch (e) {
      console.error('[Offscreen] renderFrame error:', e);
    }
  }

  renderWithZoom(cropArea) {
  const now = Date.now();
  const elapsed = now - this.zoomState.startTime;

  const { inDuration, holdDuration, outDuration, scale } = this.zoomState;
  const totalDuration = inDuration + holdDuration + outDuration;

  if (elapsed >= totalDuration) {
    this.zoomState.isZooming = false;
    // 마지막 프레임은 원래 상태(1.0배)로 렌더링하도록 호출한 쪽에서 처리
    return this.ctx.drawImage(
      this.video,
      cropArea.x, cropArea.y, cropArea.width, cropArea.height,
      0, 0, this.canvas.width, this.canvas.height
    );
  }

  let currentScale;

  if (elapsed < inDuration) {
    // 확대 구간: 0 → inDuration
    const t = elapsed / inDuration; // 0~1
    const eased = t * t * (3 - 2 * t); // smoothstep
    currentScale = 1 + (scale - 1) * eased;
  } else if (elapsed < inDuration + holdDuration) {
    // 고정 구간: scale 유지
    currentScale = scale;
  } else {
    // 축소 구간: inDuration+holdDuration → totalDuration
    const t = (elapsed - inDuration - holdDuration) / outDuration; // 0~1
    const eased = t * t * (3 - 2 * t);
    currentScale = scale - (scale - 1) * eased;
  }

  // cropArea 기준에서 targetArea 중심으로 줌
  const zoomArea = this.zoomState.targetArea;
  const zoomCenterX = zoomArea.x + zoomArea.width / 2;
  const zoomCenterY = zoomArea.y + zoomArea.height / 2;

  const scaledWidth = cropArea.width / currentScale;
  const scaledHeight = cropArea.height / currentScale;

  const zoomedX = cropArea.x + zoomCenterX - scaledWidth / 2;
  const zoomedY = cropArea.y + zoomCenterY - scaledHeight / 2;

  const finalX = Math.max(cropArea.x, Math.min(zoomedX, cropArea.x + cropArea.width - scaledWidth));
  const finalY = Math.max(cropArea.y, Math.min(zoomedY, cropArea.y + cropArea.height - scaledHeight));

  this.ctx.drawImage(
    this.video,
    finalX, finalY, scaledWidth, scaledHeight,
    0, 0, this.canvas.width, this.canvas.height
  );
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
      if (Date.now() > deadline) throw new Error('Timeout waiting for video');
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
      
      // GIF 모드일 경우 예상 크기 계산
      let size = this.totalSize;
      if (this.isGifMode) {
        // 프레임당 대략적인 크기 추정
        size = this.frameCount * 50000;
      }
      
      try {
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.RECORDING_STATS,
          data: {
            duration: dur,
            size: size,
            isRecording: this.isGifMode ? !this.isEncodingGif : (this.recorder?.state === 'recording'),
            isPaused: this.pausedAt > 0,
            isEncodingGif: this.isEncodingGif,
            gifEncodingProgress: this.gifEncodingProgress
          }
        }, () => {
          if (chrome.runtime.lastError) {
            // Silently ignore
          }
        });
      } catch (e) {
        console.warn('[Offscreen] Exception sending stats:', e);
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
    
    console.log('🛑 [Offscreen] Stopping recording...');
    
    if (this.timer) { 
      clearInterval(this.timer); 
      this.timer = null; 
    }
    
    this.stopStats();
    
    if (this.isGifMode) {
      if (this.gifEncoder && this.frameCount > 0) {
        console.log('🎨 [Offscreen] Starting GIF encoding with', this.frameCount, 'frames');
        this.isEncodingGif = true;
        this.gifEncoder.render();
      } else {
        this.isStopping = false;
        await this.cleanup();
        return { success: false, error: 'No frames captured' };
      }
    } else {
      if (!this.recorder || this.recorder.state === 'inactive') {
        this.isStopping = false;
        return { success: false };
      }
      
      try { 
        this.recorder.requestData(); 
        await delay(120); 
      } catch {}
      
      this.recorder.stop();
    }
    
    return { success: true };
  }

  pauseRecording() {
    if (this.isGifMode) {
      // GIF는 일시정지 지원 안함
      return { success: false, error: 'Pause not supported for GIF' };
    }
    
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.pausedAt = Date.now();
      console.log('⏸️ [Offscreen] Recording paused');
      return { success: true };
    }
    return { success: false };
  }

  resumeRecording() {
    if (this.isGifMode) {
      return { success: false, error: 'Resume not supported for GIF' };
    }
    
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      if (this.pausedAt) {
        this.accumulatedPause += Date.now() - this.pausedAt;
        this.pausedAt = 0;
      }
      console.log('▶️ [Offscreen] Recording resumed');
      return { success: true };
    }
    return { success: false };
  }

  async cancelRecording() {
    console.log('❌ [Offscreen] Recording cancelled');
    
    if (this.isGifMode) {
      if (this.gifEncoder) {
        try {
          this.gifEncoder.abort();
        } catch (e) {
          console.warn('[Offscreen] GIF encoder abort failed:', e);
        }
        this.gifEncoder = null;
      }
    } else {
      if (this.recorder?.state !== 'inactive') {
        try {
          this.recorder.stop();
        } catch (e) {
          console.warn('[Offscreen] Recorder stop failed:', e);
        }
      }
    }
    
    this.stopStats();
    await this.cleanup();
    return { success: true };
  }

  async handleGifFinished(blob) {
    console.log('💾 [Offscreen] GIF ready:', {
      size: (blob.size / 1024 / 1024).toFixed(2) + ' MB',
      frames: this.frameCount
    });

    this.totalSize = blob.size;

    // 파일 다운로드
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = generateFilename('gif');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // 완료 메시지 전송
    try {
      chrome.runtime.sendMessage({
        type: 'recording-finished',
        data: { 
          format: 'GIF', 
          size: this.totalSize, 
          filename: generateFilename('gif') 
        }
      });
    } catch (e) {
      console.warn('[Offscreen] Failed to send recording-finished:', e);
    }

    await this.cleanup();
    this.isStopping = false;
    
    console.log('✅ [Offscreen] GIF recording finalized successfully');
  }

  async finalize() {
    if (this.isGifMode) {
      // GIF는 handleGifFinished에서 처리
      return;
    }
    
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
    
    if (this.gifEncoder) {
      try {
        this.gifEncoder = null;
      } catch (e) {
        console.warn('[Offscreen] GIF encoder cleanup failed:', e);
      }
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
    this.gifFrames = [];
    this.totalSize = 0;
    this.currentRecordingId = null;
    this.currentCrop = null;
    this.frameCount = 0;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.accumulatedPause = 0;
    this.isGifMode = false;
    this.isEncodingGif = false;
    this.gifEncodingProgress = 0;
    this.zoomState.isZooming = false;
    
    console.log('✅ [Offscreen] Cleanup completed');
  }
}

const offscreenRecorder = new OffscreenRecorder();

// ✅ 강제로 줌 테스트 (3초 후)
setTimeout(() => {
  console.log('🧪 [Offscreen] Testing zoom after 3 seconds...');
  console.log('🧪 Current state:', {
    hasVideo: !!offscreenRecorder.video,
    videoSize: offscreenRecorder.video ? {
      w: offscreenRecorder.video.videoWidth,
      h: offscreenRecorder.video.videoHeight
    } : null,
    isRecording: !!offscreenRecorder.recorder,
    zoomEnabled: offscreenRecorder.state.clickElementZoomEnabled,
    hasCrop: !!offscreenRecorder.currentCrop
  });

  if (offscreenRecorder.video) {
    const testZoomArea = {
      x: 100,
      y: 100,
      width: 200,
      height: 200,
      scale: 1.5
    };

    console.log('🧪 Sending test zoom:', testZoomArea);

    const result = offscreenRecorder.handleElementZoom({
      zoomArea: testZoomArea,
      timestamp: Date.now()
    });

    console.log('🧪 Test zoom result:', result);
  } else {
    console.log('🧪 No video ready for test');
  }
}, 3000);
