export class AreaSelector {
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
        background: rgba(0, 0, 0, 0.5);
        cursor: crosshair;
        z-index: 1;
      }

      .overlay.adjusting {
        cursor: default;
        pointer-events: none;
      }

      .selection-box {
        position: fixed;
        border: 3px solid #ff0000;
        background: rgba(255, 0, 0, 0.1);
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
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
        width: 16px;
        height: 16px;
        background: #ff0000;
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        z-index: 3;
        pointer-events: auto;
      }

      .resize-handle:hover {
        transform: scale(1.3);
        background: #ff3333;
      }

      .resize-handle:active {
        transform: scale(1.1);
        background: #cc0000;
      }

      .resize-handle.nw { top: -8px; left: -8px; cursor: nw-resize; }
      .resize-handle.ne { top: -8px; right: -8px; cursor: ne-resize; }
      .resize-handle.sw { bottom: -8px; left: -8px; cursor: sw-resize; }
      .resize-handle.se { bottom: -8px; right: -8px; cursor: se-resize; }
      .resize-handle.n { top: -8px; left: 50%; margin-left: -8px; cursor: n-resize; }
      .resize-handle.s { bottom: -8px; left: 50%; margin-left: -8px; cursor: s-resize; }
      .resize-handle.w { top: 50%; left: -8px; margin-top: -8px; cursor: w-resize; }
      .resize-handle.e { top: 50%; right: -8px; margin-top: -8px; cursor: e-resize; }

      .instructions {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.95);
        color: white;
        padding: 28px 40px;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-align: center;
        z-index: 4;
        pointer-events: none;
      }

      .instructions h3 {
        margin-bottom: 16px;
        font-size: 22px;
        font-weight: 600;
      }

      .instructions p {
        margin: 8px 0;
        font-size: 16px;
        opacity: 0.9;
      }

      .instructions.hidden {
        display: none;
      }

      .adjustment-instructions {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 0, 0, 0.95);
        color: white;
        padding: 18px 28px;
        border-radius: 10px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-align: center;
        z-index: 4;
        pointer-events: none;
        display: none;
      }

      .adjustment-instructions.visible {
        display: block;
      }

      .adjustment-instructions p {
        margin: 6px 0;
        font-size: 15px;
        font-weight: 500;
      }

      .adjustment-instructions strong {
        font-size: 17px;
      }

      .coordinates {
        position: fixed;
        background: rgba(0, 0, 0, 0.9);
        color: #fff;
        padding: 8px 14px;
        border-radius: 6px;
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 13px;
        font-weight: 600;
        z-index: 4;
        pointer-events: none;
        display: none;
        box-shadow: 0 3px 10px rgba(0,0,0,0.4);
      }

      .confirm-button {
        position: fixed;
        bottom: 48px;
        left: 50%;
        transform: translateX(-50%);
        background: #ff0000;
        color: white;
        border: none;
        padding: 18px 56px;
        border-radius: 10px;
        font-size: 18px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(255, 0, 0, 0.5);
        transition: all 0.2s;
        z-index: 4;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        pointer-events: auto;
        display: none;
      }

      .confirm-button:hover {
        background: #cc0000;
        transform: translateX(-50%) translateY(-3px);
        box-shadow: 0 8px 24px rgba(255, 0, 0, 0.6);
      }

      .confirm-button:active {
        transform: translateX(-50%) translateY(-1px);
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
      <h3>📹 녹화 영역 선택</h3>
      <p>드래그하여 녹화할 영역을 선택하세요</p>
      <p><strong>ESC</strong> 키를 눌러 취소</p>
    `;

    this.adjustmentInstructions = document.createElement('div');
    this.adjustmentInstructions.className = 'adjustment-instructions';
    this.adjustmentInstructions.innerHTML = `
      <p><strong>✨ 영역 수정 모드</strong></p>
      <p>• 빨간 영역을 클릭하고 드래그하여 위치 이동</p>
      <p>• 빨간 점을 드래그하여 크기 조절</p>
      <p>• 아래 버튼을 눌러 확정</p>
    `;

    this.confirmButton = document.createElement('button');
    this.confirmButton.className = 'confirm-button';
    this.confirmButton.textContent = '✓ 이 영역으로 확정';

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
