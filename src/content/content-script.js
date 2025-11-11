const MESSAGE_TYPES = {
  AREA_SELECTED: 'area-selected',
  SHOW_AREA_SELECTOR: 'show-area-selector',
  HIDE_AREA_SELECTOR: 'hide-area-selector',
  SHOW_DOCK: 'show-dock',
  HIDE_DOCK: 'hide-dock',
  RECORDING_STATS: 'recording-stats',
  TOGGLE_LASER: 'toggle-laser',
  MOUSE_MOVE: 'mouse-move',
  MOUSE_CLICK: 'mouse-click'
};

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

class AreaSelector {
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

class DockNavigation {
  constructor() {
    this.isVisible = false;
    this.isDragging = false;
    this.offsetX = 0;
    this.offsetY = 0;
    this.isPaused = false;
    this.laserEnabled = false;

    this.createElements();
    this.attachEventListeners();
    this.loadPosition();
  }

  createElements() {
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-dock';
    this.host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646;';
    
    this.shadowRoot = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      .dock {
        position: fixed;
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 12px 16px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        gap: 12px;
        cursor: move;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1);
        user-select: none;
        backdrop-filter: blur(10px);
      }

      .dock:hover {
        background: rgba(0, 0, 0, 0.95);
      }

      .recording-indicator {
        width: 8px;
        height: 8px;
        background: #ff0000;
        border-radius: 50%;
        animation: pulse 1.5s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.2); }
      }

      .recording-indicator.paused {
        background: #ffa500;
        animation: none;
      }

      .stats {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 120px;
      }

      .stat-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }

      .stat-label {
        opacity: 0.7;
        font-weight: 500;
      }

      .stat-value {
        font-weight: 600;
        font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      }

      .controls {
        display: flex;
        gap: 6px;
        padding-left: 12px;
        border-left: 1px solid rgba(255, 255, 255, 0.2);
      }

      .dock button {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.2s;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .dock button:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.3);
        transform: translateY(-1px);
      }

      .dock button:active {
        transform: translateY(0);
      }

      .dock button.pause-btn {
        background: rgba(255, 165, 0, 0.2);
        border-color: rgba(255, 165, 0, 0.4);
      }

      .dock button.pause-btn:hover {
        background: rgba(255, 165, 0, 0.3);
      }

      .dock button.stop-btn {
        background: rgba(255, 0, 0, 0.2);
        border-color: rgba(255, 0, 0, 0.4);
      }

      .dock button.stop-btn:hover {
        background: rgba(255, 0, 0, 0.3);
      }

      .dock button.laser-btn {
        background: rgba(138, 43, 226, 0.2);
        border-color: rgba(138, 43, 226, 0.4);
      }

      .dock button.laser-btn:hover {
        background: rgba(138, 43, 226, 0.3);
      }

      .dock button.laser-btn.active {
        background: rgba(138, 43, 226, 0.4);
        border-color: rgba(138, 43, 226, 0.6);
      }

      .divider {
        width: 1px;
        height: 24px;
        background: rgba(255, 255, 255, 0.2);
      }
    `;

    this.dock = document.createElement('div');
    this.dock.className = 'dock';
    this.dock.innerHTML = `
      <div class="recording-indicator"></div>
      <div class="stats">
        <div class="stat-row">
          <span class="stat-label">⏱</span>
          <span class="stat-value time-display">00:00</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">💾</span>
          <span class="stat-value size-display">0 MB</span>
        </div>
      </div>
      <div class="controls">
        <button class="pause-btn">Pause</button>
        <button class="stop-btn">Stop</button>
        <div class="divider"></div>
        <button class="laser-btn">Laser</button>
        <button class="cancel-btn">Cancel</button>
      </div>
    `;

    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(this.dock);

    this.indicator = this.dock.querySelector('.recording-indicator');
    this.timeDisplay = this.dock.querySelector('.time-display');
    this.sizeDisplay = this.dock.querySelector('.size-display');
    this.pauseBtn = this.dock.querySelector('.pause-btn');
    this.stopBtn = this.dock.querySelector('.stop-btn');
    this.laserBtn = this.dock.querySelector('.laser-btn');
    this.cancelBtn = this.dock.querySelector('.cancel-btn');
  }

  attachEventListeners() {
    this.dock.addEventListener('mousedown', this.handleMouseDown.bind(this));
    document.addEventListener('mousemove', this.handleMouseMove.bind(this));
    document.addEventListener('mouseup', this.handleMouseUp.bind(this));

    this.pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlePause();
    });

    this.stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleStop();
    });

    this.laserBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleLaser();
    });

    this.cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleCancel();
    });
  }

  handleMouseDown(e) {
    if (e.target.tagName === 'BUTTON') return;
    
    this.isDragging = true;
    const rect = this.host.getBoundingClientRect();
    this.offsetX = e.clientX - rect.left;
    this.offsetY = e.clientY - rect.top;
    this.dock.style.cursor = 'grabbing';
  }

  handleMouseMove(e) {
    if (!this.isDragging) return;

    const x = e.clientX - this.offsetX;
    const y = e.clientY - this.offsetY;

    const maxX = window.innerWidth - this.host.offsetWidth;
    const maxY = window.innerHeight - this.host.offsetHeight;

    const boundedX = Math.max(0, Math.min(x, maxX));
    const boundedY = Math.max(0, Math.min(y, maxY));

    this.host.style.left = `${boundedX}px`;
    this.host.style.top = `${boundedY}px`;
  }

  handleMouseUp() {
    if (this.isDragging) {
      this.isDragging = false;
      this.dock.style.cursor = 'move';
      this.savePosition();
    }
  }

  handlePause() {
    this.isPaused = !this.isPaused;
    
    if (this.isPaused) {
      this.pauseBtn.textContent = 'Resume';
      this.indicator.classList.add('paused');
      chrome.runtime.sendMessage({ type: 'recording-command', command: 'pause' });
    } else {
      this.pauseBtn.textContent = 'Pause';
      this.indicator.classList.remove('paused');
      chrome.runtime.sendMessage({ type: 'recording-command', command: 'pause' });
    }
  }

  handleStop() {
    chrome.runtime.sendMessage({ type: 'recording-command', command: 'stop' });
  }

  handleLaser() {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TOGGLE_LASER });
  }

  handleCancel() {
    if (confirm('Are you sure you want to cancel this recording? All progress will be lost.')) {
      chrome.runtime.sendMessage({ type: 'recording-command', command: 'cancel' });
    }
  }

  updateStats({ duration, size, isPaused }) {
    this.timeDisplay.textContent = formatDuration(duration);
    this.sizeDisplay.textContent = formatFileSize(size);

    if (isPaused && !this.isPaused) {
      this.isPaused = true;
      this.pauseBtn.textContent = 'Resume';
      this.indicator.classList.add('paused');
    } else if (!isPaused && this.isPaused) {
      this.isPaused = false;
      this.pauseBtn.textContent = 'Pause';
      this.indicator.classList.remove('paused');
    }
  }

  updateLaserState(enabled) {
    this.laserEnabled = enabled;
    if (enabled) {
      this.laserBtn.classList.add('active');
    } else {
      this.laserBtn.classList.remove('active');
    }
  }

  savePosition() {
    const position = {
      left: this.host.style.left,
      top: this.host.style.top
    };
    localStorage.setItem('dock-position', JSON.stringify(position));
  }

  loadPosition() {
    const saved = localStorage.getItem('dock-position');
    if (saved) {
      const position = JSON.parse(saved);
      this.host.style.left = position.left;
      this.host.style.top = position.top;
    } else {
      this.host.style.top = '20px';
      this.host.style.right = '20px';
    }
  }

  show() {
    if (!document.body.contains(this.host)) {
      document.body.appendChild(this.host);
    }
    this.isVisible = true;
  }

  hide() {
    if (document.body.contains(this.host)) {
      document.body.removeChild(this.host);
    }
    this.isVisible = false;
  }
}

class ContentScriptManager {
  constructor() {
    this.areaSelector = null;
    this.dockNavigation = null;
    this.laserEnabled = false;
    this.mouseTrackingInterval = null;

    this.setupMessageHandlers();
  }

  setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message).then(sendResponse);
      return true;
    });
  }

  async handleMessage(message) {
    switch (message.type) {
      case MESSAGE_TYPES.SHOW_AREA_SELECTOR:
        return this.showAreaSelector();
      case MESSAGE_TYPES.HIDE_AREA_SELECTOR:
        return this.hideAreaSelector();
      case MESSAGE_TYPES.SHOW_DOCK:
        return this.showDock();
      case MESSAGE_TYPES.HIDE_DOCK:
        return this.hideDock();
      case MESSAGE_TYPES.RECORDING_STATS:
        return this.updateDockStats(message.data);
      case MESSAGE_TYPES.TOGGLE_LASER:
        return this.toggleLaser();
      default:
        return { success: false };
    }
  }

  showAreaSelector() {
    if (!this.areaSelector) {
      this.areaSelector = new AreaSelector((cropArea) => {
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.AREA_SELECTED,
          data: { cropArea }
        });
      });
    }
    this.areaSelector.show();
    return { success: true };
  }

  hideAreaSelector() {
    if (this.areaSelector) {
      this.areaSelector.hide();
    }
    return { success: true };
  }

  showDock() {
    if (!this.dockNavigation) {
      this.dockNavigation = new DockNavigation();
    }
    this.dockNavigation.show();
    this.startMouseTracking();
    return { success: true };
  }

  hideDock() {
    if (this.dockNavigation) {
      this.dockNavigation.hide();
    }
    this.stopMouseTracking();
    return { success: true };
  }

  updateDockStats(stats) {
    if (this.dockNavigation) {
      this.dockNavigation.updateStats(stats);
    }
    return { success: true };
  }

  toggleLaser() {
    this.laserEnabled = !this.laserEnabled;
    
    if (this.dockNavigation) {
      this.dockNavigation.updateLaserState(this.laserEnabled);
    }

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TOGGLE_LASER,
      target: 'offscreen',
      data: { enabled: this.laserEnabled }
    });

    return { success: true };
  }

  startMouseTracking() {
    let lastX = 0;
    let lastY = 0;
    let clickTimeout = null;

    const throttledMouseMove = (e) => {
      if (Math.abs(e.clientX - lastX) > 5 || Math.abs(e.clientY - lastY) > 5) {
        lastX = e.clientX;
        lastY = e.clientY;

        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.MOUSE_MOVE,
          target: 'offscreen',
          data: { x: e.clientX, y: e.clientY }
        }).catch(() => {});
      }
    };

    const handleClick = (e) => {
      if (clickTimeout) {
        clearTimeout(clickTimeout);
      }

      clickTimeout = setTimeout(() => {
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.MOUSE_CLICK,
          target: 'offscreen',
          data: { x: e.clientX, y: e.clientY }
        }).catch(() => {});
      }, 50);
    };

    document.addEventListener('mousemove', throttledMouseMove, { passive: true });
    document.addEventListener('click', handleClick, { passive: true });

    this.mouseTrackingCleanup = () => {
      document.removeEventListener('mousemove', throttledMouseMove);
      document.removeEventListener('click', handleClick);
      if (clickTimeout) {
        clearTimeout(clickTimeout);
      }
    };
  }

  stopMouseTracking() {
    if (this.mouseTrackingCleanup) {
      this.mouseTrackingCleanup();
      this.mouseTrackingCleanup = null;
    }
  }
}

new ContentScriptManager();
