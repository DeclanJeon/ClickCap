export class LaserPointer {
  constructor() {
    this.enabled = false;
    this.x = 0;
    this.y = 0;
  }
  setEnabled(v) { this.enabled = !!v; }
  move(x, y) { this.x = x; this.y = y; }
  draw(ctx) {
    if (!this.enabled) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.x, this.y, 18, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,0,0,0.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.x, this.y, 18, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,0,0,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.x, this.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,0,0,0.95)';
    ctx.fill();
    ctx.restore();
  }
}
