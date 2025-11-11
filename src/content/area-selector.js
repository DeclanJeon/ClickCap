export class AreaSelector {
  constructor(onAreaSelected) {
    this.onAreaSelected = onAreaSelected;
    this.isSelecting = false;
    this.startX = 0;
    this.startY = 0;
    this.currentX = 0;
    this.currentY = 0;

    this.createElements();
    this.attachEventListeners();
  }

  createElements() {
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-area-selector';
    this.host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483647;';
    
    this.shadowRoot = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      .overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.5);
        cursor: crosshair;
        z-index: 2147483647;
      }

      .selection-box {
        position: absolute;
        border: 3px solid #ff0000;
        background: rgba(255, 0, 0, 0.1);
        pointer-events: none;
        display: none;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
      }

      .instructions {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 24px 32px;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 16px;
        text-align: center;
        pointer-events: none;
        z-index: 2147483648;
      }

      .instructions h3 {
        margin-bottom: 12px;
        font-size: 20px;
        font-weight: 600;
      }

      .instructions p {
        margin: 8px 0;
        opacity: 0.9;
      }

      .coordinates {
        position: absolute;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 12px;
        pointer-events: none;
        display: none;
      }
    `;

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';

    this.selectionBox = document.createElement('div');
    this.selectionBox.className = 'selection-box';

    this.instructions = document.createElement('div');
    this.instructions.className = 'instructions';
    this.instructions.innerHTML = `
      <h3>Select Recording Area</h3>
      <p>Click and drag to select the area you want to record</p>
      <p>Press <strong>ESC</strong> to cancel</p>
    `;

    this.coordinates = document.createElement('div');
    this.coordinates.className = 'coordinates';

    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(this.overlay);
    this.overlay.appendChild(this.selectionBox);
    this.overlay.appendChild(this.instructions);
    this.overlay.appendChild(this.coordinates);
  }

  attachEventListeners() {
    this.overlay.addEventListener('mousedown', this.handleMouseDown.bind(this));
    this.overlay.addEventListener('mousemove', this.handleMouseMove.bind(this));
    this.overlay.addEventListener('mouseup', this.handleMouseUp.bind(this));
    
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  handleMouseDown(e) {
    this.isSelecting = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.currentX = e.clientX;
    this.currentY = e.clientY;

    this.selectionBox.style.left = `${this.startX}px`;
    this.selectionBox.style.top = `${this.startY}px`;
    this.selectionBox.style.width = '0';
    this.selectionBox.style.height = '0';
    this.selectionBox.style.display = 'block';

    this.instructions.style.display = 'none';
  }

  handleMouseMove(e) {
    if (!this.isSelecting) return;

    this.currentX = e.clientX;
    this.currentY = e.clientY;

    const left = Math.min(this.startX, this.currentX);
    const top = Math.min(this.startY, this.currentY);
    const width = Math.abs(this.currentX - this.startX);
    const height = Math.abs(this.currentY - this.startY);

    this.selectionBox.style.left = `${left}px`;
    this.selectionBox.style.top = `${top}px`;
    this.selectionBox.style.width = `${width}px`;
    this.selectionBox.style.height = `${height}px`;

    this.coordinates.style.display = 'block';
    this.coordinates.style.left = `${this.currentX + 10}px`;
    this.coordinates.style.top = `${this.currentY + 10}px`;
    this.coordinates.textContent = `${width} × ${height}`;
  }

  handleMouseUp(e) {
    if (!this.isSelecting) return;

    this.isSelecting = false;

    const left = Math.min(this.startX, this.currentX);
    const top = Math.min(this.startY, this.currentY);
    const width = Math.abs(this.currentX - this.startX);
    const height = Math.abs(this.currentY - this.startY);

    if (width > 50 && height > 50) {
      const cropArea = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(width),
        height: Math.round(height)
      };

      this.onAreaSelected(cropArea);
      
      this.overlay.style.background = 'transparent';
      this.overlay.style.pointerEvents = 'none';
      this.instructions.style.display = 'none';
      this.coordinates.style.display = 'none';
      
      this.selectionBox.style.boxShadow = 'none';
    } else {
      this.selectionBox.style.display = 'none';
      this.instructions.style.display = 'block';
      this.coordinates.style.display = 'none';
    }
  }

  handleKeyDown(e) {
    if (e.key === 'Escape') {
      this.hide();
    }
  }

  show() {
    if (!document.body.contains(this.host)) {
      document.body.appendChild(this.host);
    }
    this.overlay.style.display = 'block';
    this.instructions.style.display = 'block';
  }

  hide() {
    if (document.body.contains(this.host)) {
      document.body.removeChild(this.host);
    }
  }
}
