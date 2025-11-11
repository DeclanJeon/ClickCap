import { MESSAGE_TYPES, DEFAULT_PREFERENCES } from '../utils/constants.js';
import { storageManager } from '../utils/storage.js';
import { generateFilename } from '../utils/video-utils.js';
import { LaserPointer } from './laser-pointer.js';

const REC_MIME = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function clampCrop(crop, srcW, srcH) {
  if (!crop) return { x: 0, y: 0, width: srcW, height: srcH };
  const x = clamp(Math.round(crop.x), 0, srcW - 1);
  const y = clamp(Math.round(crop.y), 0, srcH - 1);
  const w = clamp(Math.round(crop.width), 1, srcW - x);
  const h = clamp(Math.round(crop.height), 1, srcH - y);
  return { x, y, width: w, height: h };
}

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
    try { await new Promise((resolve) => { chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_READY }, () => resolve()); }); } catch {}
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
      case MESSAGE_TYPES.TOGGLE_LASER: this.state.laserPointerEnabled = !this.state.laserPointerEnabled; this.laser.setEnabled(this.state.laserPointerEnabled); return { success: true };
      case MESSAGE_TYPES.LASER_MOVED: this.cursorPos = { x: message.data.x, y: message.data.y }; this.laser.move(this.cursorPos.x, this.cursorPos.y); return { success: true };
      case MESSAGE_TYPES.TOGGLE_CURSOR: this.state.showCursor = !this.state.showCursor; return { success: true };
      case MESSAGE_TYPES.TOGGLE_ZOOM_HIGHLIGHT: this.state.zoomHighlightEnabled = !this.state.zoomHighlightEnabled; chrome.runtime.sendMessage({ type: 'zoom-highlight-toggle', data: { enabled: this.state.zoomHighlightEnabled } }); return { success: true };
      case MESSAGE_TYPES.ZOOM_HIGHLIGHT_AREA: if (this.state.zoomHighlightEnabled) this.triggerZoomAnimation(message.data); return { success: true };
      default: return { success: true };
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

  async startRecording({ streamId, cropArea, preferences }) {
    try {
      this.updatePrefs(preferences || {});
      this.state.cropArea = cropArea || null;

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: this.state.includeAudio ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } : false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
      });

      this.video = document.createElement('video');
      this.video.srcObject = this.mediaStream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      await this.waitForFirstFrame(this.video);

      const srcW = this.video.videoWidth || 1;
      const srcH = this.video.videoHeight || 1;
      const crop = clampCrop(this.state.cropArea, srcW, srcH);

      this.canvas = document.getElementById('rec-canvas');
      const dpr = self.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(crop.width * dpr));
      this.canvas.height = Math.max(1, Math.round(crop.height * dpr));
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: false });

      chrome.runtime.sendMessage({ type: 'set-recording-crop' , data: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } });

      const fps = clamp(this.state.fps, 10, 60);
      const intervalMs = Math.max(15, Math.floor(1000 / fps));

      const options = { mimeType: REC_MIME, videoBitsPerSecond: this.qualityToBitrate(this.state.quality), audioBitsPerSecond: 128000 };
      const outStream = this.canvas.captureStream(fps);
      const aTrack = this.mediaStream.getAudioTracks()[0];
      if (aTrack) { try { outStream.addTrack(aTrack); } catch {} }

      this.recorder = new MediaRecorder(outStream, options);
      this.chunks = [];
      this.totalSize = 0;
      this.currentRecordingId = `recording_${Date.now()}`;
      this.recorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          this.chunks.push(e.data);
          this.totalSize += e.data.size;
          try { await storageManager.saveChunk(this.currentRecordingId, e.data, this.chunks.length - 1); } catch {}
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
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.renderFrame(crop, dpr), intervalMs);
      return { success: true };
    } catch (e) {
      await this.cleanup();
      return { success: false, error: e.message };
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

  renderFrame(crop, dpr) {
    try {
      if (!this.video || !this.ctx) return;
      const sX = Math.round(crop.x * dpr);
      const sY = Math.round(crop.y * dpr);
      const sW = Math.round(crop.width * dpr);
      const sH = Math.round(crop.height * dpr);
      this.ctx.drawImage(this.video, sX, sY, sW, sH, 0, 0, this.canvas.width, this.canvas.height);

      if (this.zoomAnim) this.drawZoom(crop);
      if (this.state.showCursor) this.drawCursor();
      if (this.state.laserPointerEnabled) this.laser.draw(this.ctx);
    } catch {}
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
    setTimeout(() => { if (this.zoomAnim && Date.now() - this.zoomAnim.start >= dur) this.zoomAnim = null; }, dur + 50);
  }

  drawZoom(crop) {
    if (!this.zoomAnim) return;
    const { area, scale, start, dur } = this.zoomAnim;
    const t = Date.now() - start;
    if (t > dur) { this.zoomAnim = null; return; }
    const progress = Math.min(1, t / dur);
    const ease = 1;
    const sx = clamp(area.x - crop.x, 0, crop.width);
    const sy = clamp(area.y - crop.y, 0, crop.height);
    const sw = clamp(area.width, 1, crop.width - sx);
    const sh = clamp(area.height, 1, crop.height - sy);
    const cx = sx + sw / 2;
    const cy = sy + sh / 2;
    const curScale = scale;
    const dw = sw * curScale;
    const dh = sh * curScale;
    const dx = clamp(cx - dw / 2, 0, crop.width - dw);
    const dy = clamp(cy - dh / 2, 0, crop.height - dh);
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(dx, dy, dw, dh);
    this.ctx.clip();
    this.ctx.drawImage(this.canvas, sx, sy, sw, sh, dx, dy, dw, dh);
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
    if (this.statsInterval) { clearInterval(this.statsInterval); this.statsInterval = null; }
  }

  async stopRecording() {
    try {
      if (!this.recorder || this.recorder.state === 'inactive') return { success: false, error: 'Not recording' };
      try { this.recorder.requestData(); await delay(120); } catch {}
      this.recorder.stop();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  }

  pauseRecording() {
    try {
      if (this.recorder && this.recorder.state === 'recording') {
        this.recorder.pause();
        this.pausedAt = Date.now();
        return { success: true };
      }
      return { success: false };
    } catch { return { success: false }; }
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
    } catch { return { success: false }; }
  }

  async cancelRecording() {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      this.stopStats();
      await this.cleanup();
      return { success: true };
    } catch { return { success: false }; }
  }

  async finalize() {
    try {
      if (!this.chunks.length || this.totalSize < 10) { await this.cleanup(); return; }
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
    } catch { await this.cleanup(); }
  }

  async cleanup() {
    try {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.recorder) { try { if (this.recorder.state !== 'inactive') this.recorder.stop(); } catch {} this.recorder = null; }
      if (this.mediaStream) { try { this.mediaStream.getTracks().forEach(t => t.stop()); } catch {} this.mediaStream = null; }
      if (this.video) { try { this.video.pause(); this.video.srcObject = null; } catch {} this.video = null; }
      this.stopStats();
      this.chunks = [];
      this.totalSize = 0;
      this.currentRecordingId = null;
      this.zoomAnim = null;
      this.startedAt = 0;
      this.pausedAt = 0;
      this.accumulatedPause = 0;
    } catch {}
  }
}

new OffscreenRecorder();
