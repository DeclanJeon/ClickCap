export class GifEncoderManager {
  constructor() {
    this.encoder = null;
    this.isEncoding = false;
    this.frameCount = 0;
    this.maxFrames = 300;
    this.options = {
      quality: 10,
      workers: 2,
      workerScript: null,
      dither: false,
      width: 0,
      height: 0
    };
    this.onProgress = null;
    this.onFinished = null;
    this.onError = null;
    this.startTime = 0;
    this.lastFrameTime = 0;
    this.targetFrameInterval = 100; // 10fps default
  }

  async loadLibrary() {
    if (typeof GIF !== 'undefined') {
      return true;
    }
    throw new Error('GIF library not found. Ensure src/vendor/gif.js is included via offscreen.html');
  }

  async initialize(options) {
    await this.loadLibrary();

    this.options = {
      quality: this.validateQuality(options.quality),
      workers: Math.min(options.workers || 2, navigator.hardwareConcurrency || 2),
      dither: options.dither || false,
      width: this.validateDimension(options.width),
      height: this.validateDimension(options.height)
    };

    const maxDimension = 800;
    if (this.options.width > maxDimension || this.options.height > maxDimension) {
      const scale = maxDimension / Math.max(this.options.width, this.options.height);
      this.options.width = Math.floor(this.options.width * scale);
      this.options.height = Math.floor(this.options.height * scale);
    }

    const fps = Math.min(options.fps || 10, 15);
    this.targetFrameInterval = 1000 / fps;
    this.maxFrames = Math.min(fps * 60, 600);

    this.encoder = new GIF({
      workers: this.options.workers,
      quality: this.options.quality,
      width: this.options.width,
      height: this.options.height,
      workerScript: chrome.runtime.getURL('src/vendor/gif.worker.js'),
      transparent: null,
      dither: this.options.dither ? 'FloydSteinberg' : false,
      background: '#ffffff'
    });

    this.encoder.on('finished', (blob) => {
      this.isEncoding = false;
      if (this.onFinished) this.onFinished(blob);
    });

    this.encoder.on('progress', (progress) => {
      if (this.onProgress) this.onProgress(progress);
    });

    this.encoder.on('abort', () => {
      this.isEncoding = false;
      if (this.onError) this.onError(new Error('Encoding aborted'));
    });

    this.frameCount = 0;
    this.startTime = Date.now();
    this.lastFrameTime = 0;
    return true;
  }

  addFrame(canvas) {
    if (!this.encoder || this.isEncoding) return false;
    if (this.frameCount >= this.maxFrames) return false;

    const now = Date.now();
    if (this.lastFrameTime > 0 && (now - this.lastFrameTime) < this.targetFrameInterval) {
      return false;
    }

    try {
      let frameCanvas = canvas;
      if (canvas.width !== this.options.width || canvas.height !== this.options.height) {
        frameCanvas = this.resizeCanvas(canvas, this.options.width, this.options.height);
      }

      const delay = Math.round(this.targetFrameInterval);
      this.encoder.addFrame(frameCanvas, { copy: true, delay });

      this.frameCount++;
      this.lastFrameTime = now;

      if (frameCanvas !== canvas) {
        frameCanvas.remove();
      }
      return true;
    } catch {
      return false;
    }
  }

  resizeCanvas(sourceCanvas, targetWidth, targetHeight) {
    const resizedCanvas = document.createElement('canvas');
    resizedCanvas.width = targetWidth;
    resizedCanvas.height = targetHeight;
    const ctx = resizedCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
    return resizedCanvas;
  }

  render() {
    if (!this.encoder) throw new Error('Encoder not initialized');
    if (this.frameCount === 0) throw new Error('No frames to encode');
    if (this.isEncoding) return;
    this.isEncoding = true;
    this.encoder.render();
  }

  abort() {
    if (this.encoder && this.isEncoding && typeof this.encoder.abort === 'function') {
      this.encoder.abort();
      this.isEncoding = false;
    }
  }

  destroy() {
    this.abort();
    this.encoder = null;
    this.frameCount = 0;
    this.onProgress = null;
    this.onFinished = null;
    this.onError = null;
  }

  getStatus() {
    return {
      isInitialized: !!this.encoder,
      isEncoding: this.isEncoding,
      frameCount: this.frameCount,
      maxFrames: this.maxFrames,
      duration: this.startTime ? Date.now() - this.startTime : 0,
      estimatedSize: this.frameCount * 50000
    };
  }

  validateQuality(quality) {
    const q = parseInt(quality, 10);
    if (isNaN(q) || q < 1 || q > 30) return 10;
    return q;
  }

  validateDimension(dimension) {
    const d = parseInt(dimension, 10);
    if (isNaN(d) || d < 1 || d > 4096) throw new Error(`Invalid dimension: ${dimension}`);
    return d;
  }
}