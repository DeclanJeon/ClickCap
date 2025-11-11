export class LaserPointer {
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
