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
  TOGGLE_LASER: 'toggle-laser',
  LASER_MOVED: 'laser-moved',
  TOGGLE_CURSOR: 'toggle-cursor',
  TOGGLE_ZOOM_HIGHLIGHT: 'toggle-zoom-highlight',
  ZOOM_HIGHLIGHT_AREA: 'zoom-highlight-area',
  UPDATE_PREFS: 'update-prefs',
  VIEWPORT_INFO: 'viewport-info'
};

function safeSend(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        resolve(res || { success: true });
      });
    } catch {
      resolve({ success: false });
    }
  });
}

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
    this.tip.textContent = '드래그하여 영역 지정 (ESC 취소)';
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
      // 영역 선택 완료 시 view 컨텍스트 동봉
      const cropArea = { x, y, width: w, height: h }; // CSS pixels (visual viewport 기준)
      const viewContext = this.collectViewContext();

      console.log('[SelectionOverlay] Area selected with crop:', cropArea);
      console.log('[SelectionOverlay] View context:', viewContext);

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

  // view 컨텍스트 수집 함수 추가
  collectViewContext() {
    const vv = window.visualViewport || null;

    return {
      // ✅ 핵심: 실제 렌더링되는 뷰포트 크기
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,

      // 추가 정보 (디버깅용)
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
  keyDown(e) { if (e.key === 'Escape') this.hide(); }
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

class RecordingOverlay {
  constructor() {
    this.host = document.createElement('div');
    this.host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events:none;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');

    // ✅ 개선된 스타일
    style.textContent = `
      .box {
        position: fixed;
        pointer-events: none;
        border: 3px solid #ff1a1a;
        box-sizing: content-box;  /* ✅ border를 바깥쪽에 그림 */
        box-shadow:
          0 0 0 2px rgba(255, 26, 26, 0.25),
          inset 0 0 0 2px rgba(255, 26, 26, 0.25),
          0 0 15px rgba(255, 26, 26, 0.6);
        transition: box-shadow 0.2s ease;
      }

      .box.recording {
        animation: recordingPulse 1.5s ease-in-out infinite;
      }

      @keyframes recordingPulse {
        0%, 100% {
          box-shadow:
            0 0 0 2px rgba(255, 26, 26, 0.25),
            inset 0 0 0 2px rgba(255, 26, 26, 0.25),
            0 0 15px rgba(255, 26, 26, 0.6);
        }
        50% {
          box-shadow:
            0 0 0 2px rgba(255, 26, 26, 0.4),
            inset 0 0 0 2px rgba(255, 26, 26, 0.4),
            0 0 25px rgba(255, 26, 26, 0.9);
        }
      }

      .box.blue {
        border-color: #0078ff;
        box-shadow:
          0 0 0 2px rgba(0, 120, 255, 0.25),
          inset 0 0 0 2px rgba(0, 120, 255, 0.25),
          0 0 15px rgba(0, 120, 255, 0.6);
      }

      .indicator {
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 26, 26, 0.95);
        color: white;
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        z-index: 2147483647;
        pointer-events: none;
        display: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 12px rgba(255, 26, 26, 0.4);
      }

      .indicator.visible {
        display: block;
      }

      .indicator::before {
        content: '● ';
        animation: blink 1s ease-in-out infinite;
      }

      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `;

    shadow.appendChild(style);
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.indicator = document.createElement('div');
    this.indicator.className = 'indicator';
    this.indicator.textContent = 'Recording Area';

    this.overlay.appendChild(this.box);
    shadow.appendChild(this.overlay);
    shadow.appendChild(this.indicator);
  }

  show(crop, isSelecting) {
    if (!document.body) return;
    if (!document.body.contains(this.host)) document.body.appendChild(this.host);
    this.update(crop);

    // ✅ 상태에 따라 클래스 변경
    if (isSelecting) {
      this.box.classList.add('blue');
      this.box.classList.remove('recording');
      this.indicator.classList.remove('visible');
    } else {
      this.box.classList.remove('blue');
      this.box.classList.add('recording');
      this.indicator.classList.add('visible');
    }
  }

  update(crop) {
    // ✅ 테두리를 실제 녹화 영역 바깥쪽에 표시
    const BORDER_WIDTH = 3;
    const SAFETY_MARGIN = 5;
    const TOTAL_OFFSET = BORDER_WIDTH + SAFETY_MARGIN;

    // 테두리를 크롭 영역보다 바깥쪽으로 이동
    this.box.style.left = (crop.x - TOTAL_OFFSET) + 'px';
    this.box.style.top = (crop.y - TOTAL_OFFSET) + 'px';
    this.box.style.width = (crop.width + TOTAL_OFFSET * 2) + 'px';
    this.box.style.height = (crop.height + TOTAL_OFFSET * 2) + 'px';
  }

  hide() {
    if (this.host.parentNode) this.host.parentNode.removeChild(this.host);
  }
}

class Dock {
  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-dock';
    this.host.style.cssText = 'all: initial; position: fixed; right: 20px; top: 20px; z-index: 2147483646; pointer-events: auto; display: block;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.dock{display:flex;gap:8px;align-items:center;padding:10px 14px;border-radius:12px;background:rgba(0,0,0,.9);color:#fff;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.btn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer}.toggle.active{background:rgba(102,126,234,.35);border-color:rgba(102,126,234,.6)}.stat{font:12px monospace}.group{display:flex;gap:6px;align-items:center}';
    shadow.appendChild(style);
    this.wrap = document.createElement('div');
    this.wrap.className = 'dock';
    this.timeEl = document.createElement('div');
    this.timeEl.className = 'stat';
    this.timeEl.textContent = '00:00';
    this.sizeEl = document.createElement('div');
    this.sizeEl.className = 'stat';
    this.sizeEl.textContent = '0 B';
    this.pauseBtn = document.createElement('button');
    this.pauseBtn.className = 'btn';
    this.pauseBtn.textContent = 'Pause';
    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'btn';
    this.stopBtn.textContent = 'Stop';
    this.laserBtn = document.createElement('button');
    this.laserBtn.className = 'btn toggle';
    this.laserBtn.textContent = 'Laser';
    this.cursorBtn = document.createElement('button');
    this.cursorBtn.className = 'btn toggle';
    this.cursorBtn.textContent = 'Cursor';
    this.zoomBtn = document.createElement('button');
    this.zoomBtn.className = 'btn toggle';
    this.zoomBtn.textContent = 'Zoom';
    const g1 = document.createElement('div'); g1.className = 'group'; g1.append(this.timeEl, this.sizeEl);
    const g2 = document.createElement('div'); g2.className = 'group'; g2.append(this.pauseBtn, this.stopBtn);
    const g3 = document.createElement('div'); g3.className = 'group'; g3.append(this.laserBtn, this.cursorBtn, this.zoomBtn);
    this.wrap.append(g1, g2, g3);
    shadow.appendChild(this.wrap);
    this.isPaused = false;
    this.pauseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await safeSend({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'pause' });
      this.isPaused = !this.isPaused;
      this.pauseBtn.textContent = this.isPaused ? 'Resume' : 'Pause';
    });
    this.stopBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await safeSend({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'stop' });
      this.hide();
    });
    this.laserBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.laserBtn.classList.toggle('active');
      await safeSend({ type: MESSAGE_TYPES.TOGGLE_LASER, target: 'offscreen' });
    });
    this.cursorBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.cursorBtn.classList.toggle('active');
      await safeSend({ type: MESSAGE_TYPES.TOGGLE_CURSOR, target: 'offscreen' });
    });
    this.zoomBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.zoomBtn.classList.toggle('active');
      await safeSend({ type: MESSAGE_TYPES.TOGGLE_ZOOM_HIGHLIGHT, target: 'offscreen' });
    });
  }
  show() {
    if (!document.body) return setTimeout(() => this.show(), 50);
    const exist = document.getElementById('screen-recorder-dock');
    if (exist && exist !== this.host) exist.remove();
    if (!document.body.contains(this.host)) document.body.appendChild(this.host);
    this.host.style.display = 'block';
  }
  hide() { if (this.host.parentNode) this.host.parentNode.removeChild(this.host); }
  updateStats({ duration, size }) {
    const s = Math.floor((duration || 0) / 1000);
       const m = Math.floor(s / 60);
    const sec = s % 60;
    this.timeEl.textContent = `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    const bytes = size || 0;
    if (!bytes) this.sizeEl.textContent = '0 B';
    else { const k = 1024; const sizes = ['B','KB','MB','GB']; const i = Math.floor(Math.log(bytes)/Math.log(k)); this.sizeEl.textContent = `${(bytes/Math.pow(k,i)).toFixed(2)} ${sizes[i]}`; }
  }
}

class ZoomHighlighter {
  constructor(getCrop) {
    this.getCrop = getCrop;
    this.enabled = false;
    this.dragging = false;
    this.start = null;
    this.host = document.createElement('div');
    this.host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483644; pointer-events:none;';
    const sh = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.rect{position:fixed;border:2px dashed rgba(255,255,255,.8);background:rgba(255,255,255,.08);display:none;pointer-events:none}';
    sh.appendChild(style);
    this.rect = document.createElement('div');
    this.rect.className = 'rect';
    sh.appendChild(this.rect);
    this.md = this.mousedown.bind(this);
    this.mm = this.mousemove.bind(this);
    this.mu = this.mouseup.bind(this);
  }
  enable() {
    if (this.enabled) return; this.enabled = true;
    if (!document.body.contains(this.host)) document.body.appendChild(this.host);
    window.addEventListener('mousedown', this.md, true);
    window.addEventListener('mousemove', this.mm, true);
    window.addEventListener('mouseup', this.mu, true);
  }
  disable() {
    this.enabled = false;
    window.removeEventListener('mousedown', this.md, true);
    window.removeEventListener('mousemove', this.mm, true);
    window.removeEventListener('mouseup', this.mu, true);
    if (this.host.parentNode) this.host.parentNode.removeChild(this.host);
    this.rect.style.display = 'none';
    this.dragging = false;
  }
  mousedown(e) {
    const crop = this.getCrop(); if (!crop) return;
    if (e.clientX < crop.x || e.clientX > crop.x + crop.width || e.clientY < crop.y || e.clientY > crop.y + crop.height) return;
    this.dragging = true;
    this.start = { x: e.clientX, y: e.clientY };
    Object.assign(this.rect.style, { display: 'block', left: this.start.x + 'px', top: this.start.y + 'px', width: '0px', height: '0px' });
    e.stopPropagation(); e.preventDefault();
  }
  mousemove(e) {
    if (!this.dragging) return;
    const x = Math.min(this.start.x, e.clientX);
    const y = Math.min(this.start.y, e.clientY);
    const w = Math.abs(e.clientX - this.start.x);
    const h = Math.abs(e.clientY - this.start.y);
    Object.assign(this.rect.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  }
  mouseup() {
    if (!this.dragging) return;
    this.dragging = false;
    const left = parseInt(this.rect.style.left || '0', 10);
    const top = parseInt(this.rect.style.top || '0', 10);
    const width = parseInt(this.rect.style.width || '0', 10);
    const height = parseInt(this.rect.style.height || '0', 10);
    this.rect.style.display = 'none';
    if (width > 20 && height > 20) {
      safeSend({ type: MESSAGE_TYPES.ZOOM_HIGHLIGHT_AREA, target: 'offscreen', data: { x: left, y: top, width, height } });
    }
  }
}

// ✅ View Context 수집 함수
function collectViewContext() {
  const vv = window.visualViewport || null;
  return {
    dpr: window.devicePixelRatio || 1,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    vvScale: vv ? vv.scale : 1,
    vvOffsetLeft: vv ? vv.offsetLeft : 0,
    vvOffsetTop: vv ? vv.offsetTop : 0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    vvWidth: vv ? vv.width : window.innerWidth,
    vvHeight: vv ? vv.height : window.innerHeight,
  };
}

class ContentMain {
  constructor() {
    this.areaSelector = null;
    this.dock = new Dock();
    this.recordingOverlay = new RecordingOverlay();
    this.currentCrop = null;
    this.zoomHL = new ZoomHighlighter(() => this.currentCrop);

    // ✅ 메시지 리스너 추가
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'ping') {
        sendResponse({ success: true });
        return true;
      }

      // REQUEST_VIEW_CONTEXT 핸들러 추가
      if (msg?.type === 'REQUEST_VIEW_CONTEXT') {
        const viewContext = this.collectViewContext();
        console.log('[ContentScript] REQUEST_VIEW_CONTEXT received, sending:', viewContext);
        sendResponse({ success: true, data: viewContext });
        return true;
      }

      // ✅ 에러 처리와 함께 라우팅
      this.route(msg)
        .then(response => {
          console.log('[ContentScript] Route response:', msg.type, response);
          sendResponse(response);
        })
        .catch(error => {
          console.error('[ContentScript] Route error:', msg.type, error);
          sendResponse({ success: false, error: error.message });
        });

      return true;  // 비동기 응답 대기
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.currentCrop) return;
      if (e.clientX < this.currentCrop.x || e.clientX > this.currentCrop.x + this.currentCrop.width || e.clientY < this.currentCrop.y || e.clientY > this.currentCrop.y + this.currentCrop.height) return;
      safeSend({ type: MESSAGE_TYPES.LASER_MOVED, target: 'offscreen', data: { x: e.clientX - this.currentCrop.x, y: e.clientY - this.currentCrop.y } });
    }, true);
    window.addEventListener('resize', () => {
      this.sendViewportInfo();
    });
    this.sendViewportInfo();
    safeSend({ type: MESSAGE_TYPES.CONTENT_SCRIPT_READY });

    console.log('[ContentScript] Initialized and ready');
  }
  async route(msg) {
    console.log('[ContentScript] Routing message:', msg.type);

    switch (msg.type) {
      case MESSAGE_TYPES.SHOW_AREA_SELECTOR:
        if (!this.areaSelector) this.areaSelector = new SelectionOverlay();
        this.areaSelector.show();
        return { success: true };

      case MESSAGE_TYPES.HIDE_AREA_SELECTOR:
        if (this.areaSelector) this.areaSelector.hide();
        return { success: true };

      case MESSAGE_TYPES.SHOW_DOCK:
        console.log('[ContentScript] SHOW_DOCK received');
        console.log('[ContentScript] Current crop:', this.currentCrop);

        this.dock.show();

        if (this.currentCrop) {
          console.log('[ContentScript] Showing recording overlay with crop:', this.currentCrop);
          this.recordingOverlay.show(this.currentCrop, false);
        } else {
          console.warn('[ContentScript] No current crop to show overlay');
        }

        return { success: true };

      case MESSAGE_TYPES.HIDE_DOCK:
        console.log('[ContentScript] HIDE_DOCK received');
        this.dock.hide();
        this.recordingOverlay.hide();
        return { success: true };

      case MESSAGE_TYPES.UPDATE_DOCK_STATS:
        this.dock.updateStats(msg.data || {});
        return { success: true };

      // ✅ 명시적으로 처리
      case 'set-recording-crop':
        console.log('[ContentScript] Setting recording crop:', msg.data);
        this.currentCrop = msg.data;
        this.recordingOverlay.show(this.currentCrop, msg.data.isSelecting || false);
        this.sendViewportInfo();
        return { success: true };

      case 'set-selecting-crop':
        this.currentCrop = msg.data;
        this.recordingOverlay.show(this.currentCrop, true);
        this.sendViewportInfo();
        return { success: true };

      case 'zoom-highlight-toggle':
        if (msg.data?.enabled) this.zoomHL.enable();
        else this.zoomHL.disable();
        return { success: true };

      case 'recording-finished':
        try {
          const { format, size, filename } = msg.data || {};
          // 간단 토스트
          const toast = document.createElement('div');
          toast.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;padding:10px 14px;border-radius:8px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3)';
          toast.textContent = `Saved ${filename || format} (${(size/1024/1024).toFixed(2)} MB)`;
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 4000);
        } catch {}
        return { success: true };

      default:
        console.warn('[ContentScript] Unknown message type:', msg.type);
        return { success: false, error: 'Unknown message type' };
    }
  }

  collectViewContext() {
    const vv = window.visualViewport || null;

    return {
      // ✅ 핵심: 실제 렌더링되는 뷰포트 크기
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,

      // 추가 정보 (디버깅용)
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
    safeSend({ type: MESSAGE_TYPES.VIEWPORT_INFO, target: 'offscreen', data: {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    }});
  }
}

new ContentMain();
