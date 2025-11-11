import { MESSAGE_TYPES } from '../utils/constants.js';
import { formatDuration, formatFileSize } from '../utils/video-utils.js';

export class DockNavigation {
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
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'pause' });
    } else {
      this.pauseBtn.textContent = 'Pause';
      this.indicator.classList.remove('paused');
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'pause' });
    }
  }

  handleStop() {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'stop' });
  }

  handleLaser() {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TOGGLE_LASER });
  }

  handleCancel() {
    if (confirm('Are you sure you want to cancel this recording? All progress will be lost.')) {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'cancel' });
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
    console.log('[Dock] show() called, isVisible:', this.isVisible);
    
    if (!document.body) {
      console.error('[Dock] document.body not available');
      return;
    }
    
    if (!document.body.contains(this.host)) {
      console.log('[Dock] Appending host to document.body');
      document.body.appendChild(this.host);
    } else {
      console.log('[Dock] Host already in document.body');
    }
    
    // Force display
    this.host.style.display = 'block';
    this.dock.style.display = 'flex';
    
    console.log('[Dock] Host computed style:', window.getComputedStyle(this.host).display);
    console.log('[Dock] Dock computed style:', window.getComputedStyle(this.dock).display);
    
    this.isVisible = true;
    console.log('[Dock] Now visible');
  }

  hide() {
    if (document.body.contains(this.host)) {
      document.body.removeChild(this.host);
    }
    this.isVisible = false;
  }
}
