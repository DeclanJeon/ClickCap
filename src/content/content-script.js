(function() {
  'use strict';

  function isContextValid() {
    try {
      return !!chrome?.runtime?.id;
    } catch {
      return false;
    }
  }

  if (!isContextValid()) {
    console.warn('[ContentScript] Invalid context detected, script will not initialize');
    return;
  }

  if (window.__screenRecorderInitialized) {
    return;
  }
  window.__screenRecorderInitialized = true;
})();

let __CTX_INVALID = false;
function safeSend(msg, options = {}) {
  const { timeout = 5000, silent = false } = options;
  return new Promise((resolve) => {
    if (__CTX_INVALID) {
      resolve({ success: false, error: 'Context invalid', fatal: true });
      return;
    }
    try {
      if (!chrome?.runtime?.id) {
        __CTX_INVALID = true;
        resolve({ success: false, error: 'Context invalid', fatal: true });
        return;
      }
    } catch {
      __CTX_INVALID = true;
      resolve({ success: false, error: 'Context check failed', fatal: true });
      return;
    }
    const timeoutId = setTimeout(() => {
      if (!silent) console.warn('[ContentScript] Message timeout:', msg.type);
      resolve({ success: false, error: 'Timeout' });
    }, timeout);
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;
          if (error.includes('Extension context invalidated') || error.includes('Receiving end does not exist')) {
            __CTX_INVALID = true;
            if (!silent) console.error('[ContentScript] Fatal error:', error);
            resolve({ success: false, error, fatal: true });
          } else {
            if (!silent) console.warn('[ContentScript] Error:', error);
            resolve({ success: false, error });
          }
        } else {
          resolve(response || { success: true });
        }
      });
    } catch (error) {
      clearTimeout(timeoutId);
      __CTX_INVALID = true;
      if (!silent) console.error('[ContentScript] Exception:', error.message);
      resolve({ success: false, error: error.message, fatal: true });
    }
  });
}

class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  enqueue(message) {
    try {
      if (!chrome?.runtime?.id) return;
    } catch {
      return;
    }
    this.queue.push(message);
    if (!this.processing) {
      this.processQueue();
    }
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const message = this.queue.shift();
      try {
        const result = await safeSend(message, { timeout: 3000, silent: false });
        if (result.fatal) {
          this.queue = [];
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch {
        break;
      }
    }
    this.processing = false;
  }

  clear() {
    this.queue = [];
    this.processing = false;
  }
}

const messageQueue = new MessageQueue();

const MESSAGE_TYPES = {
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  PAUSE_RECORDING: 'pause-recording',
  RESUME_RECORDING: 'resume-recording',
  CANCEL_RECORDING: 'cancel-recording',
  AREA_SELECTED: 'area-selected',
  RECORDING_STATS: 'recording-stats',
  RECORDING_COMMAND: 'recording-command',
  SHOW_AREA_SELECTOR: 'show-area-selector',
  HIDE_AREA_SELECTOR: 'hide-area-selector',
  SHOW_DOCK: 'show-dock',
  HIDE_DOCK: 'hide-dock',
  UPDATE_DOCK_STATS: 'update-dock-stats',
  CONTENT_SCRIPT_READY: 'content-script-ready',
  OFFSCREEN_READY: 'offscreen-ready',
  UPDATE_PREFS: 'update-prefs',
  VIEWPORT_INFO: 'viewport-info',
  ELEMENT_CLICKED_ZOOM: 'element-clicked-zoom',
  TOGGLE_ELEMENT_ZOOM: 'toggle-element-zoom'
};

// ==================== DOCK CLASS (Inline) ====================
class Dock {
  constructor() {
    console.log('🎯 [Dock] Constructor called');
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-dock';
    this.host.style.cssText = 'all: initial; position: fixed; right: 20px; top: 20px; z-index: 2147483646; pointer-events: auto; display: none;';
    
    const shadow = this.host.attachShadow({ mode: 'open' });
    
    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      .dock {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 12px 16px;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.95);
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(10px);
        user-select: none;
      }

      .recording-indicator {
        width: 8px;
        height: 8px;
        background: #ff0000;
        border-radius: 50%;
        animation: pulse 1.5s ease-in-out infinite;
        flex-shrink: 0;
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
        gap: 12px;
        min-width: 120px;
      }

      .stat {
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 12px;
        white-space: nowrap;
      }

      .divider {
        width: 1px;
        height: 24px;
        background: rgba(255, 255, 255, 0.2);
        flex-shrink: 0;
      }

      .btn {
        background: rgba(255, 255, 255, 0.12);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.2s;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .btn:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: translateY(-1px);
      }

      .btn:active {
        transform: translateY(0);
      }

      .btn.pause-btn {
        background: rgba(255, 165, 0, 0.2);
        border-color: rgba(255, 165, 0, 0.4);
      }

      .btn.pause-btn:hover {
        background: rgba(255, 165, 0, 0.3);
      }

      .btn.stop-btn {
        background: rgba(255, 0, 0, 0.2);
        border-color: rgba(255, 0, 0, 0.4);
      }

      .btn.stop-btn:hover {
        background: rgba(255, 0, 0, 0.3);
      }

      .group {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .zoom-controls {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .zoom-toggle {
        display: flex;
        align-items: center;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        transition: all 0.2s;
        font-size: 14px;
      }

      .zoom-toggle:hover {
        background: rgba(255, 255, 255, 0.15);
      }

      .zoom-toggle.active {
        background: rgba(138, 43, 226, 0.3);
        border-color: rgba(138, 43, 226, 0.5);
      }

      .zoom-select {
        padding: 5px 24px 5px 10px;
        border-radius: 4px;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: #ffffff;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        outline: none;
        appearance: none;
        background-image: url('data:image/svg+xml;utf8,<svg fill="white" height="12" viewBox="0 0 16 16" width="12" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l4 4 4-4z"/></svg>');
        background-repeat: no-repeat;
        background-position: right 6px center;
        transition: all 0.2s;
        min-width: 60px;
      }

      .zoom-select:hover {
        background-color: rgba(50, 50, 50, 0.95);
        border-color: rgba(255, 255, 255, 0.5);
      }

      .zoom-select:focus {
        border-color: rgba(138, 43, 226, 0.8);
        box-shadow: 0 0 0 2px rgba(138, 43, 226, 0.2);
      }

      .zoom-select:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        background-color: rgba(30, 30, 30, 0.5);
      }

      /* Select 드롭다운 옵션 스타일 */
      .zoom-select option {
        background: #2a2a2a;
        color: #ffffff;
        padding: 8px;
      }

      .zoom-select option:hover {
        background: #3a3a3a;
      }

      .zoom-label {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.7);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-right: 4px;
        font-weight: 600;
      }
    `;
    
    shadow.appendChild(style);
    
    this.wrap = document.createElement('div');
    this.wrap.className = 'dock';
    
    // Recording indicator
    this.indicator = document.createElement('div');
    this.indicator.className = 'recording-indicator';
    
    // Stats
    const statsGroup = document.createElement('div');
    statsGroup.className = 'stats';
    
    this.timeEl = document.createElement('div');
    this.timeEl.className = 'stat';
    this.timeEl.textContent = '00:00';
    
    this.sizeEl = document.createElement('div');
    this.sizeEl.className = 'stat';
    this.sizeEl.textContent = '0 B';
    
    statsGroup.append(this.timeEl, this.sizeEl);
    
    // Divider
    const divider1 = document.createElement('div');
    divider1.className = 'divider';
    
    // Control buttons
    const btnGroup = document.createElement('div');
    btnGroup.className = 'group';
    
    this.pauseBtn = document.createElement('button');
    this.pauseBtn.className = 'btn pause-btn';
    this.pauseBtn.textContent = '일시정지';
    
    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'btn stop-btn';
    this.stopBtn.textContent = '중지';
    
    btnGroup.append(this.pauseBtn, this.stopBtn);
    
    // Divider
    const divider2 = document.createElement('div');
    divider2.className = 'divider';
    
    // Zoom controls
    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'zoom-controls';
    
    this.zoomToggle = document.createElement('div');
    this.zoomToggle.className = 'zoom-toggle active';
    this.zoomToggle.textContent = '🔍';
    this.zoomToggle.title = '클릭 줌 활성화/비활성화';
    
    const scaleWrapper = document.createElement('div');
    scaleWrapper.className = 'group';
    const scaleLabel = document.createElement('span');
    scaleLabel.className = 'zoom-label';
    scaleLabel.textContent = '배율';
    
    this.zoomScaleSelect = document.createElement('select');
    this.zoomScaleSelect.className = 'zoom-select';
    this.zoomScaleSelect.innerHTML = `
      <option value="1.1">1.1x</option>
      <option value="1.2">1.2x</option>
      <option value="1.3">1.3x</option>
      <option value="1.5" selected>1.5x</option>
      <option value="1.8">1.8x</option>
      <option value="2.0">2.0x</option>
      <option value="2.5">2.5x</option>
      <option value="3.0">3.0x</option>
      <option value="3.5">3.5x</option>
      <option value="4.0">4.0x</option>
    `;
    
    scaleWrapper.append(scaleLabel, this.zoomScaleSelect);
    
    const durationWrapper = document.createElement('div');
    durationWrapper.className = 'group';
    const durationLabel = document.createElement('span');
    durationLabel.className = 'zoom-label';
    durationLabel.textContent = '지속';
    
    this.zoomDurationSelect = document.createElement('select');
    this.zoomDurationSelect.className = 'zoom-select';
    this.zoomDurationSelect.innerHTML = `
      <option value="200">0.2초</option>
      <option value="300">0.3초</option>
      <option value="400">0.4초</option>
      <option value="500">0.5초</option>
      <option value="600">0.6초</option>
      <option value="800" selected>0.8초</option>
      <option value="1000">1.0초</option>
      <option value="1200">1.2초</option>
      <option value="1500">1.5초</option>
      <option value="2000">2.0초</option>
      <option value="2500">2.5초</option>
      <option value="3000">3.0초</option>
    `;
    
    durationWrapper.append(durationLabel, this.zoomDurationSelect);
    
    zoomGroup.append(this.zoomToggle, scaleWrapper, durationWrapper);
    
    // Assemble dock
    this.wrap.append(
      this.indicator,
      statsGroup,
      divider1,
      btnGroup,
      divider2,
      zoomGroup
    );
    
    shadow.appendChild(this.wrap);
    
    // State
    this.isPaused = false;
    this.zoomEnabled = true;
    
    // Event listeners
    this.attachEventListeners();
    
    console.log('✅ [Dock] Constructor completed');
  }
  
  attachEventListeners() {
    // Pause button
    this.pauseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      console.log('⏸️ [Dock] Pause button clicked');
      
      const result = await safeSend({
        type: MESSAGE_TYPES.RECORDING_COMMAND,
        command: 'pause'
      });
      
      if (result.success !== false) {
        this.isPaused = !this.isPaused;
        this.pauseBtn.textContent = this.isPaused ? '재개' : '일시정지';
        
        if (this.isPaused) {
          this.indicator.classList.add('paused');
        } else {
          this.indicator.classList.remove('paused');
        }
      }
    });
    
    // Stop button
    this.stopBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      console.log('⏹️ [Dock] Stop button clicked');
      
      await safeSend({
        type: MESSAGE_TYPES.RECORDING_COMMAND,
        command: 'stop'
      });
      
      this.hide();
    });
    
    // Zoom toggle
    this.zoomToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.zoomEnabled = !this.zoomEnabled;
      
      if (this.zoomEnabled) {
        this.zoomToggle.classList.add('active');
        this.zoomScaleSelect.disabled = false;
        this.zoomDurationSelect.disabled = false;
      } else {
        this.zoomToggle.classList.remove('active');
        this.zoomScaleSelect.disabled = true;
        this.zoomDurationSelect.disabled = true;
      }
      
      safeSend({
        type: MESSAGE_TYPES.UPDATE_PREFS,
        data: { clickElementZoomEnabled: this.zoomEnabled }
      });
      
      console.log('🔍 [Dock] Zoom toggled:', this.zoomEnabled);
    });
    
    // Zoom scale
    this.zoomScaleSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const scale = parseFloat(e.target.value);
      
      safeSend({
        type: MESSAGE_TYPES.UPDATE_PREFS,
        data: { elementZoomScale: scale }
      });
      
      console.log('📏 [Dock] Zoom scale changed:', scale);
    });
    
    // Zoom duration
    this.zoomDurationSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const duration = parseInt(e.target.value, 10);
      
      safeSend({
        type: MESSAGE_TYPES.UPDATE_PREFS,
        data: { elementZoomDuration: duration }
      });
      
      console.log('⏱️ [Dock] Zoom duration changed:', duration);
    });
  }
  
  show() {
    console.log('👁️ [Dock] show() called');
    
    if (!document.body) {
      console.warn('⚠️ [Dock] document.body not ready, retrying...');
      setTimeout(() => this.show(), 100);
      return;
    }
    
    // Remove any existing dock
    const existingDock = document.getElementById('screen-recorder-dock');
    if (existingDock && existingDock !== this.host) {
      console.log('🗑️ [Dock] Removing existing dock');
      existingDock.remove();
    }
    
    if (!document.body.contains(this.host)) {
      console.log('➕ [Dock] Appending to body');
      document.body.appendChild(this.host);
    }
    
    this.host.style.display = 'block';
    console.log('✅ [Dock] Now visible');
  }
  
  hide() {
    console.log('🙈 [Dock] hide() called');
    if (this.host.parentNode) {
      this.host.parentNode.removeChild(this.host);
    }
  }
  
  updateStats({ duration, size, isPaused }) {
    // Update time
    const s = Math.floor((duration || 0) / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    this.timeEl.textContent = `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    
    // Update size
    const bytes = size || 0;
    if (!bytes) {
      this.sizeEl.textContent = '0 B';
    } else {
      const k = 1024;
      const sizes = ['B','KB','MB','GB'];
      const i = Math.floor(Math.log(bytes)/Math.log(k));
      this.sizeEl.textContent = `${(bytes/Math.pow(k,i)).toFixed(2)} ${sizes[i]}`;
    }
    
    // Update pause state if provided
    if (typeof isPaused !== 'undefined' && isPaused !== this.isPaused) {
      this.isPaused = isPaused;
      this.pauseBtn.textContent = this.isPaused ? '재개' : '일시정지';
      
      if (this.isPaused) {
        this.indicator.classList.add('paused');
      } else {
        this.indicator.classList.remove('paused');
      }
    }
  }
  
  updateZoomState(enabled, scale, duration) {
    this.zoomEnabled = enabled;
    
    if (enabled) {
      this.zoomToggle.classList.add('active');
      this.zoomScaleSelect.disabled = false;
      this.zoomDurationSelect.disabled = false;
    } else {
      this.zoomToggle.classList.remove('active');
      this.zoomScaleSelect.disabled = true;
      this.zoomDurationSelect.disabled = true;
    }
    
    this.zoomScaleSelect.value = scale.toString();
    this.zoomDurationSelect.value = duration.toString();
  }
}

// ==================== Selection Overlay ====================
class SelectionOverlay {
  constructor() {
    this.host = document.createElement('div');
    this.host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483646;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    
    const style = document.createElement('style');
    style.textContent = '.overlay{position:fixed;inset:0;cursor:crosshair}.mask{position:absolute;inset:0;background:rgba(0,0,0,.35);pointer-events:none}.box{position:absolute;border:3px solid #0078ff;background:rgba(0,120,255,.12);box-shadow:0 0 0 9999px rgba(0,0,0,.35);display:none;pointer-events:none}.tip{position:fixed;left:50%;top:16px;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,.65);padding:8px 12px;border-radius:8px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}';
    this.shadow.appendChild(style);
    
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.mask = document.createElement('div');
    this.mask.className = 'mask';
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.textContent = '마우스로 드래그하여 영역을 선택하세요 (ESC 취소)';
    
    this.overlay.appendChild(this.mask);
    this.overlay.appendChild(this.box);
    this.shadow.appendChild(this.overlay);
    this.shadow.appendChild(this.tip);
    
    this.down = null;
    this.mm = this.mouseMove.bind(this);
    this.mu = this.mouseUp.bind(this);
    this.md = this.mouseDown.bind(this);
    this.kd = this.keyDown.bind(this);
  }
  
  mouseDown(e) {
    this.down = { x: e.clientX, y: e.clientY };
    Object.assign(this.box.style, { left: this.down.x + 'px', top: this.down.y + 'px', width: '0px', height: '0px', display: 'block' });
  }
  
  mouseMove(e) {
    if (!this.down) return;
    const x = Math.min(this.down.x, e.clientX);
    const y = Math.min(this.down.y, e.clientY);
    const w = Math.abs(e.clientX - this.down.x);
    const h = Math.abs(e.clientY - this.down.y);
    Object.assign(this.box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  }
  
  mouseUp(e) {
    if (!this.down) return;
    const x = Math.min(this.down.x, e.clientX);
    const y = Math.min(this.down.y, e.clientY);
    const w = Math.abs(e.clientX - this.down.x);
    const h = Math.abs(e.clientY - this.down.y);
    this.down = null;
    
    if (w > 30 && h > 30) {
      const cropArea = { x, y, width: w, height: h };
      const viewContext = this.collectViewContext();
      safeSend({
        type: MESSAGE_TYPES.AREA_SELECTED,
        data: { cropArea, view: viewContext }
      });
      this.sendViewportInfo();
      this.hide();
    } else {
      this.box.style.display = 'none';
    }
  }
  
  collectViewContext() {
    const vv = window.visualViewport || null;
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
      vvScale: vv ? vv.scale : 1,
      vvOffsetLeft: vv ? vv.offsetLeft : 0,
      vvOffsetTop: vv ? vv.offsetTop : 0,
      vvWidth: vv ? vv.width : window.innerWidth,
      vvHeight: vv ? vv.height : window.innerHeight
    };
  }
  
  keyDown(e) {
    if (e.key === 'Escape') this.hide();
  }
  
  show() {
    if (!document.body) return setTimeout(() => this.show(), 50);
    document.body.appendChild(this.host);
    this.overlay.addEventListener('mousedown', this.md);
    window.addEventListener('mousemove', this.mm);
    window.addEventListener('mouseup', this.mu);
    window.addEventListener('keydown', this.kd);
  }
  
  hide() {
    this.overlay.removeEventListener('mousedown', this.md);
    window.removeEventListener('mousemove', this.mm);
    window.removeEventListener('mouseup', this.mu);
    window.removeEventListener('keydown', this.kd);
    if (this.host.parentNode) this.host.parentNode.removeChild(this.host);
  }
  
  sendViewportInfo() {
    safeSend({ type: MESSAGE_TYPES.VIEWPORT_INFO, target: 'offscreen', data: {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    }});
  }
}

// ==================== Recording Overlay ====================
class RecordingOverlay {
  constructor() {
    this.host = document.createElement('div');
    this.host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events:none;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `.box {position: fixed;pointer-events: none;border: 2px solid rgba(255, 26, 26, 0.9);box-sizing: border-box;box-shadow:0 0 6px rgba(255, 26, 26, 0.7),0 0 12px rgba(255, 26, 26, 0.4);}`;
    shadow.appendChild(style);
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.overlay.appendChild(this.box);
    shadow.appendChild(this.overlay);
  }

  show(crop) {
    if (!document.body) return;
    if (!document.body.contains(this.host)) document.body.appendChild(this.host);
    this.update(crop);
  }

  update(crop) {
    this.box.style.left = Math.round(crop.x) + 'px';
    this.box.style.top = Math.round(crop.y) + 'px';
    this.box.style.width = Math.round(crop.width) + 'px';
    this.box.style.height = Math.round(crop.height) + 'px';
  }

  hide() {
    if (this.host.parentNode) this.host.parentNode.removeChild(this.host);
  }
}

// ==================== MAIN CONTENT CLASS ====================
class ContentMain {
  constructor() {
    console.log('🚀 [ContentMain] Initializing...');
    this.isInitialized = false;
    this.initPromise = null;
    this.initStartTime = Date.now();

    this.areaSelector = null;
    this.dock = new Dock();
    this.recordingOverlay = new RecordingOverlay();
    this.currentCrop = null;

    this.elementZoomEnabled = false;
    this.elementZoomScale = 1.5;
    this.elementZoomDuration = 800;
    this.lastClickTime = 0;
    this.clickThrottleMs = 300;

    this.isRecording = false;

    this.setupMessageListener();
    this.init();
    window.__screenRecorderShutdown = () => this.cleanup();
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'ping') {
        sendResponse({
          success: true,
          timestamp: Date.now(),
          initialized: this.isInitialized,
          initTime: Date.now() - this.initStartTime
        });
        return true;
      }
      
      if (msg?.type === 'REQUEST_VIEW_CONTEXT') {
        const viewContext = this.collectViewContext();
        sendResponse({ success: true, data: viewContext });
        return true;
      }

      const handleAsync = async () => {
        try {
          if (!this.isInitialized) {
            await this.initPromise;
          }
          const response = await this.route(msg);
          sendResponse(response);
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      };

      handleAsync();
      return true;
    });
  }

  async init() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        if (document.readyState !== 'complete') {
          await new Promise(resolve => {
            const checkReady = () => {
              if (document.readyState === 'complete') resolve();
              else setTimeout(checkReady, 50);
            };
            window.addEventListener('load', resolve, { once: true });
            checkReady();
          });
        }

        window.addEventListener('beforeunload', () => {
          this.cleanup();
        });

        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            messageQueue.processQueue();
          }
        });

        window.addEventListener('resize', () => {
          this.sendViewportInfo();
        });

        this.isInitialized = true;
        const initTime = Date.now() - this.initStartTime;
        console.log(`✅ [ContentMain] Initialized in ${initTime}ms`);
        
        try {
          await safeSend({ type: MESSAGE_TYPES.CONTENT_SCRIPT_READY, initTime });
        } catch {}
        
        this.setupClickEventListener();
        this.sendViewportInfo();
      } catch (error) {
        console.error('❌ [ContentMain] Initialization failed:', error);
        this.isInitialized = false;
      }
    })();

    return this.initPromise;
  }

  setupClickEventListener() {
    document.addEventListener('click', (e) => {
      this.handleClickEvent(e);
    }, true);
  }

  handleClickEvent(e) {
    try {
      if (!chrome?.runtime?.id) return;
    } catch {
      return;
    }

    if (!this.elementZoomEnabled || !this.currentCrop) return;

    const now = Date.now();
    if (now - this.lastClickTime < this.clickThrottleMs) return;
    this.lastClickTime = now;

    const clickX = e.clientX;
    const clickY = e.clientY;

    const isInsideCrop =
      clickX >= this.currentCrop.x &&
      clickX <= this.currentCrop.x + this.currentCrop.width &&
      clickY >= this.currentCrop.y &&
      clickY <= this.currentCrop.y + this.currentCrop.height;

    if (!isInsideCrop) return;

    const element = document.elementFromPoint(clickX, clickY);
    if (!element) return;

    const rect = element.getBoundingClientRect();

    const relativeX = rect.left - this.currentCrop.x;
    const relativeY = rect.top - this.currentCrop.y;
    const relativeWidth = rect.width;
    const relativeHeight = rect.height;

    const padding = 20;
    const zoomArea = {
      x: Math.max(0, relativeX - padding),
      y: Math.max(0, relativeY - padding),
      width: Math.min(relativeWidth + padding * 2, this.currentCrop.width),
      height: Math.min(relativeHeight + padding * 2, this.currentCrop.height),
      scale: this.elementZoomScale || 1.5
    };

    messageQueue.enqueue({
      type: MESSAGE_TYPES.ELEMENT_CLICKED_ZOOM,
      target: 'offscreen',
      data: {
        zoomArea,
        timestamp: now
      }
    });
  }

  async route(msg) {
    if (!this.isInitialized) {
      await this.initPromise;
    }

    console.log('📨 [ContentMain] Received message:', msg.type);

    switch (msg.type) {
      case MESSAGE_TYPES.SHOW_AREA_SELECTOR:
        if (!this.areaSelector) this.areaSelector = new SelectionOverlay();
        this.areaSelector.show();
        return { success: true };

      case MESSAGE_TYPES.HIDE_AREA_SELECTOR:
        if (this.areaSelector) this.areaSelector.hide();
        return { success: true };

      case MESSAGE_TYPES.SHOW_DOCK:
        console.log('🎬 [ContentMain] SHOW_DOCK received');
        this.isRecording = true;
        this.dock.show();
        
        if (this.currentCrop) {
          this.recordingOverlay.show(this.currentCrop);
        }
        
        // Dock에 현재 줌 설정 동기화
        this.dock.updateZoomState(
          this.elementZoomEnabled,
          this.elementZoomScale,
          this.elementZoomDuration
        );
        
        return { success: true };

      case MESSAGE_TYPES.HIDE_DOCK:
        console.log('🛑 [ContentMain] HIDE_DOCK received');
        this.isRecording = false;
        this.dock.hide();
        
        // 녹화 영역 박스도 함께 제거
        this.recordingOverlay.hide();
        this.currentCrop = null;
        
        return { success: true };

      case MESSAGE_TYPES.UPDATE_DOCK_STATS:
        this.dock.updateStats(msg.data || {});
        return { success: true };

      case 'set-recording-crop':
        this.currentCrop = msg.data;
        
        // 녹화 중일 때만 오버레이 표시
        if (this.isRecording) {
          this.recordingOverlay.show(this.currentCrop);
        }
        
        this.sendViewportInfo();
        return { success: true };

      case MESSAGE_TYPES.UPDATE_PREFS:
        if (msg.data) {
          if (typeof msg.data.clickElementZoomEnabled !== 'undefined') this.elementZoomEnabled = !!msg.data.clickElementZoomEnabled;
          if (typeof msg.data.elementZoomScale !== 'undefined') this.elementZoomScale = parseFloat(msg.data.elementZoomScale) || 1.5;
          if (typeof msg.data.elementZoomDuration !== 'undefined') this.elementZoomDuration = parseInt(msg.data.elementZoomDuration, 10) || 800;
          
          // Dock에 줌 설정 동기화
          if (this.dock) {
            this.dock.updateZoomState(
              this.elementZoomEnabled,
              this.elementZoomScale,
              this.elementZoomDuration
            );
          }
        }
        return { success: true };

      case MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM:
        if (!msg.data) return { success: false, error: 'No data provided' };
        this.elementZoomEnabled = msg.data.enabled;
        return { success: true };

      case 'recording-finished':
        try {
          const { format, size, filename } = msg.data || {};
          
          // 녹화 완료 시 모든 UI 요소 제거
          this.isRecording = false;
          this.recordingOverlay.hide();
          this.currentCrop = null;
          
          // 완료 토스트 표시
          const toast = document.createElement('div');
          toast.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;padding:10px 14px;border-radius:8px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3)';
          toast.textContent = `녹화 완료: ${filename || format} (${(size/1024/1024).toFixed(2)} MB)`;
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 4000);
        } catch (e) {
          console.error('[ContentMain] Error in recording-finished:', e);
        }
        return { success: true };

      case 'cleanup-recording-ui':
        console.log('🧹 [ContentMain] cleanup-recording-ui received');
        this.cleanup();
        return { success: true };

      default:
        return { success: false, error: 'Unknown message type' };
    }
  }

  collectViewContext() {
    const vv = window.visualViewport || null;
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
      vvScale: vv ? vv.scale : 1,
      vvOffsetLeft: vv ? vv.offsetLeft : 0,
      vvOffsetTop: vv ? vv.offsetTop : 0,
      vvWidth: vv ? vv.width : window.innerWidth,
      vvHeight: vv ? vv.height : window.innerHeight
    };
  }

  sendViewportInfo() {
    messageQueue.enqueue({
      type: MESSAGE_TYPES.VIEWPORT_INFO,
      target: 'offscreen',
      data: {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      }
    });
  }

  cleanup() {
    console.log('🧹 [ContentMain] Cleanup called');
    
    // 모든 UI 요소 제거
    if (this.areaSelector) {
      this.areaSelector.hide();
      this.areaSelector = null;
    }
    
    if (this.dock) {
      this.dock.hide();
    }
    
    if (this.recordingOverlay) {
      this.recordingOverlay.hide();
    }
    
    // 상태 초기화
    this.isRecording = false;
    this.currentCrop = null;
    this.elementZoomEnabled = false;
    
    console.log('✅ [ContentMain] Cleanup completed');
  }
}

new ContentMain();
