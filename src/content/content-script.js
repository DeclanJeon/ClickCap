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
    // Early exit if context is already invalid
    if (__CTX_INVALID) {
      resolve({ success: false, error: 'Context invalid', fatal: true });
      return;
    }

    // Fast context check without try-catch for performance
    if (!chrome?.runtime?.id) {
      __CTX_INVALID = true;
      if (!silent) console.error('[ContentScript] Extension context unavailable');
      resolve({ success: false, error: 'Extension context unavailable', fatal: true });
      return;
    }

    const timeoutId = setTimeout(() => {
      if (!silent) console.warn('[ContentScript] Message timeout:', msg.type);
      resolve({ success: false, error: 'Message timeout' });
    }, timeout);

    try {
      chrome.runtime.sendMessage(msg, (response) => {
        clearTimeout(timeoutId);

        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;

          // Check for fatal context errors
          if (error.includes('Extension context invalidated') ||
              error.includes('Receiving end does not exist') ||
              error.includes('message channel closed')) {
            __CTX_INVALID = true;
            if (!silent) console.error('[ContentScript] Extension context lost:', error);
            resolve({ success: false, error: 'Extension context lost', fatal: true });
          } else {
            // Non-fatal errors (e.g., service worker busy)
            if (!silent) console.warn('[ContentScript] Runtime error:', error);
            resolve({ success: false, error });
          }
        } else {
          // Success - ensure we always return a success response
          resolve(response || { success: true });
        }
      });
    } catch (error) {
      clearTimeout(timeoutId);
      __CTX_INVALID = true;
      if (!silent) console.error('[ContentScript] Message exception:', error.message);
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

// ==================== AREA SELECTOR (Inline) ====================
class AreaSelector {
  constructor(onAreaSelected) {
    this.onAreaSelected = onAreaSelected;
    this.isSelecting = false;
    this.isDragging = false;
    this.isResizing = false;
    this.selectedArea = null;
    this.startX = 0;
    this.startY = 0;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
    this.resizeHandle = null;
    this.initialArea = null;

    this.createElements();
    this.attachEventListeners();
  }

  createElements() {
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-area-selector';
    this.host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: auto;';
    
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
        inset: 0;
        background: rgba(49,61,68,0.35);
        cursor: crosshair;
        z-index: 1;
      }

      .overlay.adjusting {
        cursor: default;
        pointer-events: none;
      }

      .selection-box {
        position: fixed;
        border: 2px solid #00668c;
        background: rgba(113,196,239,0.12);
        box-shadow: 0 0 0 9999px rgba(0,0,0,0.45);
        box-sizing: border-box;
        cursor: move;
        z-index: 2;
        pointer-events: auto;
        display: none;
      }

      .selection-box.visible {
        display: block;
      }

      .resize-handle {
        position: absolute;
        width: 14px;
        height: 14px;
        background: #00668c;
        border: 2px solid #fffefb;
        border-radius: 50%;
        box-shadow: 0 3px 10px rgba(0,0,0,0.4);
        z-index: 3;
        pointer-events: auto;
        transition: transform 0.15s ease, background 0.15s ease;
      }

      .resize-handle:hover {
        transform: scale(1.25);
        background: #71c4ef;
      }

      .resize-handle:active {
        transform: scale(1.1);
      }

      .resize-handle.nw { top: -7px; left: -7px; cursor: nw-resize; }
      .resize-handle.ne { top: -7px; right: -7px; cursor: ne-resize; }
      .resize-handle.sw { bottom: -7px; left: -7px; cursor: sw-resize; }
      .resize-handle.se { bottom: -7px; right: -7px; cursor: se-resize; }
      .resize-handle.n { top: -7px; left: 50%; margin-left: -7px; cursor: n-resize; }
      .resize-handle.s { bottom: -7px; left: 50%; margin-left: -7px; cursor: s-resize; }
      .resize-handle.w { top: 50%; left: -7px; margin-top: -7px; cursor: w-resize; }
      .resize-handle.e { top: 50%; right: -7px; margin-top: -7px; cursor: e-resize; }

      .instructions {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(255,254,251,0.96);
        color: #1d1c1c;
        padding: 22px 30px;
        border-radius: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-align: center;
        z-index: 4;
        pointer-events: none;
        box-shadow: 0 12px 30px rgba(0,0,0,0.25);
      }

      .instructions h3 {
        margin-bottom: 10px;
        font-size: 17px;
        font-weight: 600;
      }

      .instructions p {
        margin: 4px 0;
        font-size: 13px;
        color: #313d44;
      }

      .instructions.hidden {
        display: none;
      }

      .adjustment-instructions {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,102,140,0.96);
        color: #fffefb;
        padding: 12px 20px;
        border-radius: 10px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-align: center;
        z-index: 4;
        pointer-events: none;
        display: none;
        box-shadow: 0 10px 25px rgba(0,0,0,0.25);
      }

      .adjustment-instructions.visible {
        display: block;
      }

      .adjustment-instructions p {
        margin: 3px 0;
        font-size: 12px;
      }

      .adjustment-instructions strong {
        font-size: 13px;
      }

      .coordinates {
        position: fixed;
        background: rgba(49,61,68,0.95);
        color: #fffefb;
        padding: 6px 10px;
        border-radius: 6px;
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 11px;
        font-weight: 600;
        z-index: 4;
        pointer-events: none;
        display: none;
        box-shadow: 0 3px 10px rgba(0,0,0,0.4);
      }

      .confirm-button {
        position: fixed;
        bottom: 32px;
        left: 50%;
        transform: translateX(-50%);
        background: #00668c;
        color: #fffefb;
        border: none;
        padding: 12px 32px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 8px 20px rgba(0,102,140,0.5);
        transition: all 0.15s ease;
        z-index: 4;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        pointer-events: auto;
        display: none;
      }

      .confirm-button:hover {
        background: #00506f;
        transform: translateX(-50%) translateY(-1px);
        box-shadow: 0 11px 26px rgba(0,102,140,0.55);
      }

      .confirm-button:active {
        transform: translateX(-50%) translateY(0);
      }

      .confirm-button.visible {
        display: block;
      }
    `;

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';

    this.selectionBox = document.createElement('div');
    this.selectionBox.className = 'selection-box';

    // Resize handles
    const handlePositions = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
    this.handles = {};
    handlePositions.forEach(pos => {
      const handle = document.createElement('div');
      handle.className = `resize-handle ${pos}`;
      handle.dataset.position = pos;
      this.selectionBox.appendChild(handle);
      this.handles[pos] = handle;
    });

    this.instructions = document.createElement('div');
    this.instructions.className = 'instructions';
    this.instructions.innerHTML = `
      <h3>캡처할 영역을 선택하세요</h3>
      <p>마우스로 드래그해서 녹화할 구간을 지정할 수 있습니다.</p>
      <p><strong>ESC</strong> 키를 눌러 취소할 수 있습니다.</p>
    `;

    this.adjustmentInstructions = document.createElement('div');
    this.adjustmentInstructions.className = 'adjustment-instructions';
    this.adjustmentInstructions.innerHTML = `
      <p><strong>영역 미세 조정</strong></p>
      <p>테두리를 드래그해서 크기를 조정할 수 있어요.</p>
      <p>영역 안을 드래그하면 위치를 옮길 수 있습니다.</p>
      <p>하단 버튼을 눌러 이 영역으로 녹화를 시작하세요.</p>
    `;

    this.confirmButton = document.createElement('button');
    this.confirmButton.className = 'confirm-button';
    this.confirmButton.textContent = '이 영역으로 녹화 시작';

    this.coordinates = document.createElement('div');
    this.coordinates.className = 'coordinates';

    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(this.overlay);
    this.shadowRoot.appendChild(this.selectionBox);
    this.shadowRoot.appendChild(this.instructions);
    this.shadowRoot.appendChild(this.adjustmentInstructions);
    this.shadowRoot.appendChild(this.confirmButton);
    this.shadowRoot.appendChild(this.coordinates);
  }

  attachEventListeners() {
    // Overlay mousedown - start selection
    this.overlay.addEventListener('mousedown', (e) => {
      if (this.selectedArea) return; // Already selected
      this.handleSelectionStart(e);
    });

    // Selection box mousedown - start dragging
    this.selectionBox.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('resize-handle')) return;
      this.handleDragStart(e);
    });

    // Resize handles
    Object.values(this.handles).forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        this.handleResizeStart(e);
      });
    });

    // Global mouse events
    document.addEventListener('mousemove', (e) => {
      this.handleMouseMove(e);
    });

    document.addEventListener('mouseup', (e) => {
      this.handleMouseUp(e);
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hide();
      }
    });

    // Confirm button
    this.confirmButton.addEventListener('click', () => {
      this.handleConfirm();
    });
  }

  handleSelectionStart(e) {
    e.preventDefault();
    e.stopPropagation();

    console.log(' [AreaSelector] Selection started');

    this.isSelecting = true;
    this.startX = e.clientX;
    this.startY = e.clientY;

    this.selectionBox.style.left = `${this.startX}px`;
    this.selectionBox.style.top = `${this.startY}px`;
    this.selectionBox.style.width = '0px';
    this.selectionBox.style.height = '0px';
    this.selectionBox.classList.add('visible');

    this.instructions.classList.add('hidden');
  }

  handleDragStart(e) {
    e.preventDefault();
    e.stopPropagation();

    console.log(' [AreaSelector] Drag started');

    this.isDragging = true;
    this.dragOffsetX = e.clientX - this.selectedArea.x;
    this.dragOffsetY = e.clientY - this.selectedArea.y;
  }

  handleResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();

    this.resizeHandle = e.target.dataset.position;
    this.isResizing = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.initialArea = { ...this.selectedArea };

    console.log(' [AreaSelector] Resize started:', this.resizeHandle);
  }

  handleMouseMove(e) {
    if (this.isSelecting) {
      const currentX = e.clientX;
      const currentY = e.clientY;

      const left = Math.min(this.startX, currentX);
      const top = Math.min(this.startY, currentY);
      const width = Math.abs(currentX - this.startX);
      const height = Math.abs(currentY - this.startY);

      this.selectionBox.style.left = `${left}px`;
      this.selectionBox.style.top = `${top}px`;
      this.selectionBox.style.width = `${width}px`;
      this.selectionBox.style.height = `${height}px`;

      // Show coordinates
      this.coordinates.style.display = 'block';
      this.coordinates.style.left = `${currentX + 15}px`;
      this.coordinates.style.top = `${currentY + 15}px`;
      this.coordinates.textContent = `${width} × ${height}`;

    } else if (this.isDragging) {
      const newX = e.clientX - this.dragOffsetX;
      const newY = e.clientY - this.dragOffsetY;

      // Constrain to viewport
      const constrainedX = Math.max(0, Math.min(newX, window.innerWidth - this.selectedArea.width));
      const constrainedY = Math.max(0, Math.min(newY, window.innerHeight - this.selectedArea.height));

      this.selectedArea.x = constrainedX;
      this.selectedArea.y = constrainedY;

      this.updateSelectionBox();

      // Show coordinates
      this.coordinates.style.display = 'block';
      this.coordinates.style.left = `${e.clientX + 15}px`;
      this.coordinates.style.top = `${e.clientY + 15}px`;
      this.coordinates.textContent = `위치: ${Math.round(constrainedX)}, ${Math.round(constrainedY)}`;

    } else if (this.isResizing) {
      this.handleResize(e);

      // Show coordinates
      this.coordinates.style.display = 'block';
      this.coordinates.style.left = `${e.clientX + 15}px`;
      this.coordinates.style.top = `${e.clientY + 15}px`;
      this.coordinates.textContent = `${Math.round(this.selectedArea.width)} × ${Math.round(this.selectedArea.height)}`;
    }
  }

  handleMouseUp(e) {
    if (this.isSelecting) {
      this.isSelecting = false;

      const left = parseInt(this.selectionBox.style.left);
      const top = parseInt(this.selectionBox.style.top);
      const width = parseInt(this.selectionBox.style.width);
      const height = parseInt(this.selectionBox.style.height);

      console.log(' [AreaSelector] Selection ended:', { left, top, width, height });

      if (width > 50 && height > 50) {
        const BORDER_WIDTH = 3;

        this.selectedArea = {
          x: left + BORDER_WIDTH,
          y: top + BORDER_WIDTH,
          width: width - (BORDER_WIDTH * 2),
          height: height - (BORDER_WIDTH * 2)
        };

        console.log(' [AreaSelector] Area selected:', this.selectedArea);

        // Enter adjustment mode immediately
        this.enterAdjustmentMode();
      } else {
        // Too small, reset
        this.selectionBox.classList.remove('visible');
        this.instructions.classList.remove('hidden');
      }

      this.coordinates.style.display = 'none';

    } else if (this.isDragging) {
      this.isDragging = false;
      this.coordinates.style.display = 'none';
      console.log(' [AreaSelector] Drag ended');

    } else if (this.isResizing) {
      this.isResizing = false;
      this.resizeHandle = null;
      this.initialArea = null;
      this.coordinates.style.display = 'none';
      console.log(' [AreaSelector] Resize ended');
    }
  }

  handleResize(e) {
    if (!this.selectedArea || !this.resizeHandle || !this.initialArea) return;

    const deltaX = e.clientX - this.startX;
    const deltaY = e.clientY - this.startY;

    const newArea = { ...this.initialArea };

    switch (this.resizeHandle) {
      case 'nw':
        newArea.x += deltaX;
        newArea.y += deltaY;
        newArea.width -= deltaX;
        newArea.height -= deltaY;
        break;
      case 'n':
        newArea.y += deltaY;
        newArea.height -= deltaY;
        break;
      case 'ne':
        newArea.y += deltaY;
        newArea.width += deltaX;
        newArea.height -= deltaY;
        break;
      case 'w':
        newArea.x += deltaX;
        newArea.width -= deltaX;
        break;
      case 'e':
        newArea.width += deltaX;
        break;
      case 'sw':
        newArea.x += deltaX;
        newArea.width -= deltaX;
        newArea.height += deltaY;
        break;
      case 's':
        newArea.height += deltaY;
        break;
      case 'se':
        newArea.width += deltaX;
        newArea.height += deltaY;
        break;
    }

    // Constrain minimum size
    if (newArea.width >= 50 && newArea.height >= 50) {
      // Constrain to viewport
      if (newArea.x >= 0 && newArea.x + newArea.width <= window.innerWidth &&
          newArea.y >= 0 && newArea.y + newArea.height <= window.innerHeight) {
        this.selectedArea = newArea;
        this.updateSelectionBox();
      }
    }
  }

  updateSelectionBox() {
    if (!this.selectedArea) return;

    this.selectionBox.style.left = `${this.selectedArea.x}px`;
    this.selectionBox.style.top = `${this.selectedArea.y}px`;
    this.selectionBox.style.width = `${this.selectedArea.width}px`;
    this.selectionBox.style.height = `${this.selectedArea.height}px`;
  }

  enterAdjustmentMode() {
    console.log(' [AreaSelector] Entering adjustment mode');

    this.overlay.classList.add('adjusting');
    this.adjustmentInstructions.classList.add('visible');
    this.confirmButton.classList.add('visible');
    this.selectionBox.classList.add('visible');

    this.updateSelectionBox();
  }

  handleConfirm() {
    if (!this.selectedArea) return;

    console.log(' [AreaSelector] Area confirmed:', this.selectedArea);

    const viewContext = this.collectViewContext();
    this.onAreaSelected({ cropArea: this.selectedArea, view: viewContext });
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

  show() {
    console.log(' [AreaSelector] Showing selector');

    if (!document.body.contains(this.host)) {
      document.body.appendChild(this.host);
    }

    // Reset state
    this.selectedArea = null;
    this.isSelecting = false;
    this.isDragging = false;
    this.isResizing = false;

    this.overlay.style.display = 'block';
    this.overlay.classList.remove('adjusting');
    this.instructions.classList.remove('hidden');
    this.selectionBox.classList.remove('visible');
    this.adjustmentInstructions.classList.remove('visible');
    this.confirmButton.classList.remove('visible');
    this.coordinates.style.display = 'none';
  }

  hide() {
    console.log(' [AreaSelector] Hiding selector');

    if (document.body.contains(this.host)) {
      document.body.removeChild(this.host);
    }
  }
}

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
      :host {
        all: initial;
      }

      .dock {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 10px 14px;
        border-radius: 12px;
        background: rgba(255,254,251,0.98);
        color: #1d1c1c;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.16);
        backdrop-filter: blur(8px);
        user-select: none;
      }

      .recording-indicator {
        width: 10px;
        height: 10px;
        background: #00668c;
        border-radius: 50%;
        box-shadow: 0 0 0 4px rgba(0,102,140,0.25);
        animation: pulse 1.4s ease-in-out infinite;
        flex-shrink: 0;
      }

      .recording-indicator.paused {
        background: #b6ccd8;
        box-shadow: 0 0 0 4px rgba(182,204,216,0.4);
        animation: none;
      }

      .recording-indicator.waiting {
        background: #71c4ef;
        box-shadow: 0 0 0 4px rgba(113,196,239,0.25);
        animation: none;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(1.25); }
      }

      .stats {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 110px;
      }

      .stat {
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 11px;
        white-space: nowrap;
        color: #313d44;
      }

      .divider {
        width: 1px;
        height: 28px;
        background: #cccbc8;
        flex-shrink: 0;
      }

      .btn {
        background: #d4eaf7;
        border: 1px solid #b6ccd8;
        color: #1d1c1c;
        padding: 6px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.15s ease;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .btn:hover {
        background: #71c4ef;
        border-color: #00668c;
        color: #fffefb;
        transform: translateY(-1px);
        box-shadow: 0 3px 8px rgba(0,102,140,0.25);
      }

      .btn:active {
        transform: translateY(0);
        box-shadow: none;
      }

      .btn.hidden {
        display: none;
      }

      .btn.start-btn {
        background: #00668c;
        border-color: #00668c;
        color: #fffefb;
        padding: 7px 14px;
        font-size: 12px;
      }

      .btn.start-btn:hover {
        background: #00506f;
      }

      .btn.pause-btn {
        background: #fffefb;
      }

      .btn.stop-btn {
        background: #d9534f;
        border-color: #d9534f;
        color: #fffefb;
      }

      .group {
        display: flex;
        gap: 6px;
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
        border-radius: 6px;
        background: #f5f4f1;
        border: 1px solid #cccbc8;
        transition: all 0.15s ease;
        font-size: 12px;
        color: #313d44;
      }

      .zoom-toggle:hover {
        background: #d4eaf7;
      }

      .zoom-toggle.active {
        background: #71c4ef;
        border-color: #00668c;
        color: #fffefb;
      }

      .zoom-select {
        padding: 4px 22px 4px 8px;
        border-radius: 6px;
        background: #fffefb;
        border: 1px solid #cccbc8;
        color: #1d1c1c;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        outline: none;
        appearance: none;
        background-image: url('data:image/svg+xml;utf8,<svg fill="%23313d44" height="12" viewBox="0 0 16 16" width="12" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l4 4 4-4z"/></svg>');
        background-repeat: no-repeat;
        background-position: right 6px center;
        transition: all 0.15s ease;
        min-width: 60px;
      }

      .zoom-select:hover {
        border-color: #00668c;
      }

      .zoom-select:focus {
        border-color: #00668c;
        box-shadow: 0 0 0 2px rgba(0,102,140,0.18);
      }

      .zoom-select:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        background-color: #f5f4f1;
      }

      .zoom-label {
        font-size: 10px;
        color: #313d44;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-right: 4px;
        font-weight: 600;
      }

      .encoding-progress {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 130px;
      }

      .encoding-label {
        font-size: 11px;
        color: #313d44;
        font-weight: 500;
      }

      .encoding-bar {
        width: 100%;
        height: 6px;
        background: #f5f4f1;
        border-radius: 4px;
        overflow: hidden;
      }

      .encoding-fill {
        height: 100%;
        background: linear-gradient(90deg, #71c4ef, #00668c);
        border-radius: 4px;
        transition: width 0.25s ease;
        width: 0%;
      }

      .encoding-percent {
        font-size: 10px;
        color: #313d44;
        text-align: right;
        font-weight: 600;
      }
    `;
    
    shadow.appendChild(style);
    
    this.wrap = document.createElement('div');
    this.wrap.className = 'dock';
    
    // Recording indicator
    this.indicator = document.createElement('div');
    this.indicator.className = 'recording-indicator waiting';
    
    // Stats
    const statsGroup = document.createElement('div');
    statsGroup.className = 'stats';
    
    this.timeEl = document.createElement('div');
    this.timeEl.className = 'stat time-display';
    this.timeEl.textContent = '00:00';
    
    this.sizeEl = document.createElement('div');
    this.sizeEl.className = 'stat size-display';
    this.sizeEl.textContent = '0 B';
    
    statsGroup.append(this.timeEl, this.sizeEl);
    
    // GIF Encoding Progress
    this.encodingProgress = document.createElement('div');
    this.encodingProgress.className = 'encoding-progress';
    this.encodingProgress.style.display = 'none';
    
    const encodingLabel = document.createElement('div');
    encodingLabel.className = 'encoding-label';
    encodingLabel.textContent = 'GIF 인코딩 중...';
    
    const encodingBar = document.createElement('div');
    encodingBar.className = 'encoding-bar';
    
    this.encodingFill = document.createElement('div');
    this.encodingFill.className = 'encoding-fill';
    
    const encodingPercent = document.createElement('div');
    encodingPercent.className = 'encoding-percent';
    encodingPercent.textContent = '0%';
    
    encodingBar.appendChild(this.encodingFill);
    this.encodingProgress.append(encodingLabel, encodingBar, encodingPercent);
    
    // Divider
    const divider1 = document.createElement('div');
    divider1.className = 'divider';
    
    // Control buttons
    const btnGroup = document.createElement('div');
    btnGroup.className = 'group';
    
    // Start button (for area selection mode)
    this.startBtn = document.createElement('button');
    this.startBtn.className = 'btn start-btn hidden';
    this.startBtn.textContent = '🎬 녹화 시작';
    
    this.pauseBtn = document.createElement('button');
    this.pauseBtn.className = 'btn pause-btn';
    this.pauseBtn.textContent = '⏸';
    
    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'btn stop-btn';
    this.stopBtn.textContent = '⏹';
    
    btnGroup.append(this.startBtn, this.pauseBtn, this.stopBtn);
    
    // Divider
    const divider2 = document.createElement('div');
    divider2.className = 'divider';
    
    // Zoom controls
    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'zoom-controls';
    
    this.zoomToggle = document.createElement('div');
    this.zoomToggle.className = 'zoom-toggle active';
    this.zoomToggle.textContent = '🎯';
    this.zoomToggle.title = '클릭 줌 켜기/끄기';
    
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
      this.encodingProgress,
      divider1,
      btnGroup,
      divider2,
      zoomGroup
    );
    
    shadow.appendChild(this.wrap);
    
    // State
    this.isPaused = false;
    this.isWaitingToStart = false;
    this.zoomEnabled = true;
    
    // Event listeners
    this.attachEventListeners();
    
    console.log('✅ [Dock] Constructor completed');
  }
  
  attachEventListeners() {
    // Start button (for area selection)
    this.startBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      console.log(' [Dock] Start button clicked');
      
      // Hide start button and show recording controls
      this.startBtn.classList.add('hidden');
      this.pauseBtn.classList.remove('hidden');
      this.stopBtn.classList.remove('hidden');
      this.indicator.classList.remove('waiting');
      this.isWaitingToStart = false;
      
      // Send start recording command to service worker
      const result = await safeSend({
        type: 'start-area-recording'
      });
      
      if (result.success) {
        console.log(' [Dock] Recording started');
      }
    });
    
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
        this.pauseBtn.textContent = this.isPaused ? '▶' : '⏸';
        
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
  
  show(waitingMode = false) {
    console.log(' [Dock] show() called, waitingMode:', waitingMode);
    
    if (!document.body) {
      console.warn(' [Dock] document.body not ready, retrying...');
      setTimeout(() => this.show(waitingMode), 100);
      return;
    }
    
    // Remove any existing dock
    const existingDock = document.getElementById('screen-recorder-dock');
    if (existingDock && existingDock !== this.host) {
      console.log(' [Dock] Removing existing dock');
      existingDock.remove();
    }
    
    if (!document.body.contains(this.host)) {
      console.log(' [Dock] Appending to body');
      document.body.appendChild(this.host);
    }
    
    this.isWaitingToStart = waitingMode;
    
    if (waitingMode) {
      // Show start button, hide other controls
      this.startBtn.classList.remove('hidden');
      this.pauseBtn.classList.add('hidden');
      this.stopBtn.classList.add('hidden');
      this.indicator.classList.add('waiting');
    } else {
      // Show recording controls
      this.startBtn.classList.add('hidden');
      this.pauseBtn.classList.remove('hidden');
      this.stopBtn.classList.remove('hidden');
      this.indicator.classList.remove('waiting');
    }
    
    this.host.style.display = 'block';
    console.log(' [Dock] Now visible');
  }
  
  hide() {
    console.log('🙈 [Dock] hide() called');
    if (this.host.parentNode) {
      this.host.parentNode.removeChild(this.host);
    }
  }
  
  updateStats({ duration, size, isPaused, isEncodingGif, gifEncodingProgress }) {
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
    
    // GIF 인코딩 중일 때
    if (isEncodingGif) {
      this.showEncodingProgress();
      if (typeof gifEncodingProgress === 'number') {
        this.updateEncodingProgress(gifEncodingProgress);
      }
    } else {
      this.hideEncodingProgress();
    }
  }

  showEncodingProgress() {
    if (this.encodingProgress) {
      this.encodingProgress.style.display = 'flex';
    }
  }

  hideEncodingProgress() {
    if (this.encodingProgress) {
      this.encodingProgress.style.display = 'none';
    }
  }

  updateEncodingProgress(progress) {
    const percentage = Math.round(progress * 100);
    if (this.encodingFill) {
      this.encodingFill.style.width = percentage + '%';
    }
    if (this.encodingProgress) {
      const percentElement = this.encodingProgress.querySelector('.encoding-percent');
      if (percentElement) {
        percentElement.textContent = percentage + '%';
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


// ==================== Recording Overlay ====================
class RecordingOverlay {
  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-overlay'; // ✅ ID 추가
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

    console.log('✅ [RecordingOverlay] Constructor completed');
  }

  show(crop) {
    if (!document.body) {
      console.warn('[RecordingOverlay] document.body not ready');
      return;
    }

    if (!document.body.contains(this.host)) {
      document.body.appendChild(this.host);
      console.log('✅ [RecordingOverlay] Appended to body');
    }

    this.update(crop);
  }

  update(crop) {
    this.box.style.left = Math.round(crop.x) + 'px';
    this.box.style.top = Math.round(crop.y) + 'px';
    this.box.style.width = Math.round(crop.width) + 'px';
    this.box.style.height = Math.round(crop.height) + 'px';
  }

  hide() {
    try {
      if (this.host && this.host.parentNode) {
        this.host.parentNode.removeChild(this.host);
      }
    } catch (e) {
      // Silently handle removal errors
    }

    // 강제로 ID로 찾아서 제거
    try {
      const overlay = document.getElementById('screen-recorder-overlay');
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    } catch (e) {
      // Silently handle force removal errors
    }
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

    // ✅ 기본값을 true로 설정
    this.elementZoomEnabled = true;  // ← 이전: false
    this.elementZoomScale = 1.5;
    this.elementZoomDuration = 800;
    this.lastClickTime = 0;
    this.clickThrottleMs = 300;

    this.isRecording = false;

    this.setupMessageListener();
    this.init();
    window.__screenRecorderShutdown = () => this.cleanup();

    // ✅ 디버깅 코드 추가
    setTimeout(() => {
      console.log('🔍 [ContentMain] Listener check:', {
        hasClickHandler: !!this._clickHandler,
        isInitialized: this.isInitialized,
        elementZoomEnabled: this.elementZoomEnabled,
        hasCrop: !!this.currentCrop,
        isRecording: this.isRecording
      });
    }, 2000);
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
        
        // ✅ 초기화 완료 후 클릭 리스너 등록
      this.setupClickEventListener();
      console.log('✅ [ContentMain] Click listener registered');

      // ✅ 녹화 세션 복원
      await this.restoreRecordingSession();

      this.sendViewportInfo();
      } catch (error) {
        console.error('❌ [ContentMain] Initialization failed:', error);
        this.isInitialized = false;
      }
    })();

    return this.initPromise;
  }

  // ✅ 새 메서드: 녹화 세션 복원
  async restoreRecordingSession() {
    try {
      const response = await safeSend({ type: 'GET_RECORDING_SESSION' });

      if (!response?.success || !response?.session) {
        console.log('ℹ️ [ContentMain] No active recording session');
        return;
      }

      const session = response.session;

      if (!session.isActive) {
        console.log('ℹ️ [ContentMain] Recording session is not active');
        return;
      }

      console.log('🔄 [ContentMain] Restoring recording session:', session);

      // 상태 복원
      this.currentCrop = session.cropArea;
      this.isRecording = true;
      this.elementZoomEnabled = session.preferences?.clickElementZoomEnabled !== false;
      this.elementZoomScale = session.preferences?.elementZoomScale || 1.5;
      this.elementZoomDuration = session.preferences?.elementZoomDuration || 800;

      // ✅ UI 복원 (약간의 지연 후)
      await new Promise(resolve => setTimeout(resolve, 300));

      if (this.currentCrop) {
        this.recordingOverlay.show(this.currentCrop);
        console.log('✅ [ContentMain] Recording overlay restored');
      }

      this.dock.show(false); // waitingMode = false
      this.dock.updateZoomState(
        this.elementZoomEnabled,
        this.elementZoomScale,
        this.elementZoomDuration
      );

      console.log('✅ [ContentMain] Recording session restored successfully');

    } catch (error) {
      console.warn('⚠️ [ContentMain] Failed to restore recording session:', error);
    }
  }

  setupClickEventListener() {
    console.log('🔧 [ContentMain] Setting up click listener...');

    // ✅ 이전 리스너 제거 (중복 방지)
    if (this._clickHandler) {
      document.removeEventListener('click', this._clickHandler, true);
      console.log('🗑️ [ContentMain] Removed previous click listener');
    }

    // ✅ 리스너 함수를 인스턴스 변수로 저장
    this._clickHandler = (e) => {
      // Dock 클릭 무시
      const isDockClick = e.target.closest('#screen-recorder-dock');
      if (isDockClick) {
        return;
      }

      this.handleClickEvent(e);
    };

    document.addEventListener('click', this._clickHandler, true);
    console.log('✅ [ContentMain] Click listener registered');
  }

  handleClickEvent(e) {
  // 녹화 중이 아니면 아무 것도 하지 않음
  if (!this.isRecording) {
    return;
  }

  // crop 영역이 없으면 (초기화 전, 정리 후) 아무 것도 하지 않음
  if (!this.currentCrop) {
    return;
  }

  // 줌이 비활성화되어 있으면 아무 것도 하지 않음
  if (!this.elementZoomEnabled) {
    return;
  }

  const now = Date.now();
  if (now - this.lastClickTime < this.clickThrottleMs) {
    return;
  }
  this.lastClickTime = now;

  const clickX = e.clientX;
  const clickY = e.clientY;

  const isInsideCrop =
    clickX >= this.currentCrop.x &&
    clickX <= this.currentCrop.x + this.currentCrop.width &&
    clickY >= this.currentCrop.y &&
    clickY <= this.currentCrop.y + this.currentCrop.height;

  if (!isInsideCrop) {
    // 영역 밖 클릭은 그냥 무시
    return;
  }

  const element = document.elementFromPoint(clickX, clickY);
  if (!element) {
    return;
  }

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

  // ✅ 직접 메시지 전송 (safeSend 우회)
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.ELEMENT_CLICKED_ZOOM,
    data: {
      zoomArea,
      timestamp: now
    }
  }, (response) => {
    // 여기도 굳이 콘솔 경고 찍지 않고 조용히 넘어가도 됨
    if (chrome.runtime.lastError) {
      return;
    }
    if (!response?.success) {
      return;
    }
  });
  }

  async route(msg) {
    if (!this.isInitialized) {
      await this.initPromise;
    }

    console.log('📥 [ContentMain] Received message:', msg.type);

    switch (msg.type) {
      case 'ping':
        return { success: true, timestamp: Date.now() };

      case MESSAGE_TYPES.SHOW_AREA_SELECTOR:
        if (!this.areaSelector) {
          this.areaSelector = new AreaSelector(({ cropArea, view }) => {
            safeSend({
              type: MESSAGE_TYPES.AREA_SELECTED,
              data: { cropArea, view }
            });
          });
        }
        this.areaSelector.show();
        return { success: true };

      case MESSAGE_TYPES.HIDE_AREA_SELECTOR:
        if (this.areaSelector) this.areaSelector.hide();
        return { success: true };

      case MESSAGE_TYPES.SHOW_DOCK:
        console.log(' [ContentMain] SHOW_DOCK received');
        this.isRecording = true;
        
        // Check if we're in area selection mode
        const waitingMode = msg.data?.waitingMode || false;
        
        this.dock.show(waitingMode);
        
        // 지정 영역 모드이고 대기 중이 아닐 때만 녹화 영역 테두리 표시
        if (this.currentCrop && !waitingMode) {
          this.recordingOverlay.show(this.currentCrop);
        } else if (this.currentCrop && waitingMode) {
          // 대기 모드에서는 영역 표시만 (녹화 테두리는 나중에)
          console.log(' [ContentMain] Waiting mode - showing crop area without recording border');
        }
        
        // Dock 초기 상태 업데이트
        this.dock.updateZoomState(
          this.elementZoomEnabled,
          this.elementZoomScale,
          this.elementZoomDuration
        );
        
        return { success: true };

      case MESSAGE_TYPES.HIDE_DOCK:
        console.log('🛑 [ContentMain] HIDE_DOCK received');

        // ✅ 상태 먼저 초기화
        this.isRecording = false;
        this.currentCrop = null;

        // ✅ UI 제거
        if (this.dock) {
          this.dock.hide();
        }

        if (this.recordingOverlay) {
          this.recordingOverlay.hide();
        }

        // ✅ 추가 확인: DOM에서 강제 제거
        setTimeout(() => {
          try {
            const overlay = document.getElementById('screen-recorder-overlay');
            if (overlay && overlay.parentNode) {
              overlay.parentNode.removeChild(overlay);
              console.log('✅ [ContentMain] Force removed overlay after timeout');
            }
          } catch (e) {
            console.warn('[ContentMain] Failed to force remove overlay:', e);
          }
        }, 100);

        return { success: true };

      case MESSAGE_TYPES.UPDATE_DOCK_STATS:
        this.dock.updateStats(msg.data || {});
        return { success: true };

      case 'recording-started':
      console.log('🎬 [ContentMain] Recording started notification');

      this.isRecording = true; // ✅ 녹화 상태 플래그 설정

      if (this.currentCrop) {
        // ✅ 대기 모드에서 이미 표시된 overlay를 유지하거나 새로 표시
        this.recordingOverlay.show(this.currentCrop);
        console.log('✅ [ContentMain] Recording overlay shown');
      } else {
        console.warn('⚠️ [ContentMain] No crop area for recording overlay');
      }

      // ✅ 경고 토스트
      const warningToast = document.createElement('div');
      warningToast.style.cssText = 'all:initial;position:fixed;top:80px;right:20px;z-index:2147483647;background:rgba(255,152,0,.95);color:#fff;padding:12px 16px;border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3);max-width:300px;';
      warningToast.textContent = '⚠️ 녹화 중 페이지를 이동하면 녹화가 자동 중지됩니다.';
      document.body.appendChild(warningToast);
      setTimeout(() => warningToast.remove(), 5000);

      return { success: true };

      case 'set-recording-crop':
        this.currentCrop = msg.data;

        console.log('✅ [ContentMain] Crop area set:', this.currentCrop);
      console.log('🔍 [ContentMain] Current state:', {
        elementZoomEnabled: this.elementZoomEnabled,
        elementZoomScale: this.elementZoomScale,
        elementZoomDuration: this.elementZoomDuration,
        isRecording: this.isRecording,
        hasCrop: !!this.currentCrop
      });

      // ✅ 대기 모드에서도 overlay 표시 (선택 영역 확인용)
      if (this.currentCrop && msg.data?.waitingMode) {
        console.log('📍 [ContentMain] Showing crop overlay in waiting mode');
        this.recordingOverlay.show(this.currentCrop);
      }

      this.sendViewportInfo();
      return { success: true, cropSet: true };

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

      case 'gif-encoding-progress':
        if (this.dock && msg.data) {
          this.dock.updateStats({
            isEncodingGif: true,
            gifEncodingProgress: msg.data.progress || 0
          });
        }
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
        console.warn('⚠️ [ContentMain] Unknown message type:', msg.type);
        return { success: true }; // ✅ 알 수 없는 메시지도 성공 응답
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

    // ✅ 상태 먼저 초기화 (클릭 이벤트 차단)
    this.isRecording = false;
    this.currentCrop = null;
    this.elementZoomEnabled = false;

    // ✅ UI 요소 제거
    if (this.areaSelector) {
      try {
        this.areaSelector.hide();
      } catch (e) {
        // Silently handle area selector cleanup errors
      }
      this.areaSelector = null;
    }

    if (this.dock) {
      try {
        this.dock.hide();
      } catch (e) {
        // Silently handle dock cleanup errors
      }
    }

    if (this.recordingOverlay) {
      try {
        this.recordingOverlay.hide();
      } catch (e) {
        // Silently handle recording overlay cleanup errors
      }
    }

    // 강제로 DOM에서 제거 (혹시 모를 경우 대비)
    try {
      const overlays = document.querySelectorAll('[id^="screen-recorder"]');
      overlays.forEach(el => {
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      });
    } catch (e) {
      // Silently handle force remove errors
    }

    console.log('✅ [ContentMain] Cleanup completed');
  }
}

new ContentMain();
