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
  VIEWPORT_INFO: 'viewport-info',
  ELEMENT_CLICKED_ZOOM: 'element-clicked-zoom',
  TOGGLE_ELEMENT_ZOOM: 'toggle-element-zoom'
};

// 강화된 메시지 전송 함수
function safeSend(msg, retries = 3) {
  return new Promise((resolve) => {
    let attempt = 0;
    
    const trySend = () => {
      attempt++;
      
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            console.warn(`[ContentScript] Message send attempt ${attempt} failed:`, chrome.runtime.lastError.message);
            
            if (attempt < retries) {
              setTimeout(trySend, 200 * attempt); // 지수적 백오프
              return;
            }
            
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { success: true });
          }
        });
      } catch (error) {
        console.warn(`[ContentScript] Exception on attempt ${attempt}:`, error.message);
        
        if (attempt < retries) {
          setTimeout(trySend, 200 * attempt);
          return;
        }
        
        resolve({ success: false, error: error.message });
      }
    };
    
    trySend();
  });
}

// 메시지 큐 시스템
class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }
  
  enqueue(message) {
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
        const result = await safeSend(message, 2);
        if (!result.success) {
          console.warn('[ContentScript] Failed to send queued message, re-queueing:', message);
          this.queue.unshift(message); // 실패한 메시지를 다시 큐에 넣음
          setTimeout(() => this.processQueue(), 1000);
          break;
        }
        
        console.log('[ContentScript] Successfully sent queued message:', message.type);
        await new Promise(resolve => setTimeout(resolve, 50)); // 메시지 간 간격
      } catch (error) {
        console.error('[ContentScript] Error processing queued message:', error);
      }
    }
    
    this.processing = false;
  }
}

const messageQueue = new MessageQueue();

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
    const SAFETY_MARGIN = 2; // 안전 마진 줄임
    const TOTAL_OFFSET = BORDER_WIDTH + SAFETY_MARGIN;

    // Math.round를 사용하여 픽셀 정밀도 보장
    const left = Math.round(crop.x - TOTAL_OFFSET);
    const top = Math.round(crop.y - TOTAL_OFFSET);
    const width = Math.round(crop.width + TOTAL_OFFSET * 2);
    const height = Math.round(crop.height + TOTAL_OFFSET * 2);

    // 테두리를 크롭 영역보다 바깥쪽으로 이동
    this.box.style.left = left + 'px';
    this.box.style.top = top + 'px';
    this.box.style.width = width + 'px';
    this.box.style.height = height + 'px';
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
    this.clickZoomBtn = document.createElement('button');
    this.clickZoomBtn.className = 'btn toggle';
    this.clickZoomBtn.textContent = 'ClickZoom';
    const g1 = document.createElement('div'); g1.className = 'group'; g1.append(this.timeEl, this.sizeEl);
    const g2 = document.createElement('div'); g2.className = 'group'; g2.append(this.pauseBtn, this.stopBtn);
    const g3 = document.createElement('div'); g3.className = 'group'; g3.append(this.laserBtn, this.cursorBtn, this.zoomBtn, this.clickZoomBtn);
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
    this.clickZoomBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.clickZoomBtn.classList.toggle('active');
      const enabled = this.clickZoomBtn.classList.contains('active');
      await safeSend({
        type: MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM,
        target: 'offscreen',
        data: { enabled }
      });
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

// 요소 타입 식별 함수
function getElementElementType(element) {
  const tagName = element.tagName.toLowerCase();
  const className = element.className || '';
  const role = element.getAttribute('role') || '';
  
  // 버튼 타입 세분화
  if (tagName === 'button') {
    // 기본 버튼
    if (className.includes('primary') || className.includes('main')) {
      return 'primary-button';
    } else if (className.includes('secondary') || className.includes('sub')) {
      return 'secondary-button';
    } else if (className.includes('danger') || className.includes('delete') || className.includes('remove')) {
      return 'danger-button';
    }
    return 'button';
  }
  
  // 입력 버튼
  if (tagName === 'input' && ['button', 'submit', 'reset'].includes(element.type)) {
    return element.type === 'submit' ? 'submit-button' : 'input-button';
  }
  
  // 링크 타입 세분화
  if (tagName === 'a' && element.href) {
    if (element.href.startsWith('mailto:')) return 'email-link';
    if (element.href.startsWith('tel:')) return 'phone-link';
    if (element.href.startsWith('#')) return 'anchor-link';
    if (element.download) return 'download-link';
    if (element.target === '_blank') return 'external-link';
    return 'link';
  }
  
  // 입력 필드 타입 세분화
  if (tagName === 'input') {
    switch (element.type) {
      case 'text':
      case 'search':
      case 'email':
      case 'url':
      case 'password':
        return 'text-input';
      case 'number':
        return 'number-input';
      case 'date':
      case 'datetime-local':
      case 'time':
      case 'month':
      case 'week':
        return 'date-input';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'file':
        return 'file-input';
      case 'color':
        return 'color-input';
      case 'range':
        return 'range-input';
      default:
        return 'input';
    }
  }
  
  // 텍스트 영역
  if (tagName === 'textarea') {
    return 'textarea';
  }
  
  // 선택 목록
  if (tagName === 'select') {
    return element.multiple ? 'multi-select' : 'select';
  }
  
  // 이미지 타입 세분화
  if (tagName === 'img') {
    if (className.includes('avatar') || className.includes('profile')) return 'avatar-image';
    if (className.includes('thumbnail') || className.includes('thumb')) return 'thumbnail-image';
    if (className.includes('icon')) return 'icon-image';
    if (element.alt && element.alt.includes('logo')) return 'logo-image';
    return 'image';
  }
  
  // 아이콘 요소
  if (tagName === 'i' || tagName === 'svg' ||
      className.includes('icon') || className.includes('fa-') ||
      className.includes('material-icons')) {
    return 'icon';
  }
  
  // 카드 또는 패널
  if (className.includes('card') || className.includes('panel') ||
      className.includes('tile') || role === 'article') {
    return 'card';
  }
  
  // 탭 또는 네비게이션 항목
  if (className.includes('tab') || className.includes('nav-item') ||
      role === 'tab' || role === 'menuitem') {
    return 'tab';
  }
  
  // 헤딩 요소
  if (/^h[1-6]$/.test(tagName)) {
    return 'heading';
  }
  
  // 목록 항목
  if (tagName === 'li') {
    return 'list-item';
  }
  
  // 테이블 관련 요소
  if (tagName === 'td' || tagName === 'th') {
    return 'table-cell';
  }
  
  // 레이블
  if (tagName === 'label') {
    return 'label';
  }
  
  // 기본 타입
  return 'element';
}

// 요소 정보 수집 함수
function getElementInfo(element, cropArea) {
  // 요소의 화면 기준 위치와 크기 정보
  const rect = element.getBoundingClientRect();
  
  // 요소의 실제 크기 (패딩, 테두리 포함)
  const width = rect.width;
  const height = rect.height;
  
  // 화면 기준 좌표
  const screenX = rect.left + window.scrollX;
  const screenY = rect.top + window.scrollY;
  
  // 녹화 영역 내에서의 상대적 위치 계산
  const relativeX = screenX - cropArea.x;
  const relativeY = screenY - cropArea.y;
  
  // 요소가 녹화 영역 내에 완전히 포함되는지 확인
  const isFullyInRecordingArea =
    relativeX >= 0 &&
    relativeY >= 0 &&
    relativeX + width <= cropArea.width &&
    relativeY + height <= cropArea.height;
  
  // 요소가 녹화 영역과 일부라도 겹치는지 확인
  const isPartiallyInRecordingArea =
    relativeX + width > 0 &&
    relativeY + height > 0 &&
    relativeX < cropArea.width &&
    relativeY < cropArea.height;
  
  // 녹화 영역 내에서의 실제 표시 영역 계산
  const visibleArea = {
    x: Math.max(0, relativeX),
    y: Math.max(0, relativeY),
    width: Math.min(width, cropArea.width - relativeX),
    height: Math.min(height, cropArea.height - relativeY)
  };
  
  // 요소의 중심점 계산
  const centerX = relativeX + width / 2;
  const centerY = relativeY + height / 2;
  
  // 요소 타입 식별
  const elementType = getElementElementType(element);
  
  return {
    elementType,
    width,
    height,
    screenX,
    screenY,
    relativeX,
    relativeY,
    isFullyInRecordingArea,
    isPartiallyInRecordingArea,
    visibleArea,
    centerX,
    centerY
  };
}

// 줌 영역 계산 함수
function calculateZoomArea(elementInfo, zoomScale = 1.5) {
  const { visibleArea, elementType, width, height } = elementInfo;
  
  // 요소 타입별 기본 패딩과 확대 비율 설정
  let paddingX = 20;
  let paddingY = 20;
  let customScale = zoomScale;
  
  // 요소 타입별 세부 설정
  switch (elementType) {
    // 버튼 타입
    case 'primary-button':
    case 'submit-button':
      paddingX = Math.max(25, width * 0.4);
      paddingY = Math.max(25, height * 0.4);
      customScale = 1.6;
      break;
      
    case 'secondary-button':
    case 'input-button':
      paddingX = Math.max(20, width * 0.3);
      paddingY = Math.max(20, height * 0.3);
      customScale = 1.4;
      break;
      
    case 'danger-button':
      paddingX = Math.max(30, width * 0.5);
      paddingY = Math.max(30, height * 0.5);
      customScale = 1.7;
      break;
      
    case 'button':
      paddingX = Math.max(20, width * 0.3);
      paddingY = Math.max(20, height * 0.3);
      customScale = 1.4;
      break;
      
    // 링크 타입
    case 'email-link':
    case 'phone-link':
      paddingX = Math.max(15, width * 0.6);
      paddingY = Math.max(10, height * 0.4);
      customScale = 1.3;
      break;
      
    case 'download-link':
    case 'external-link':
      paddingX = Math.max(20, width * 0.5);
      paddingY = Math.max(15, height * 0.3);
      customScale = 1.4;
      break;
      
    case 'anchor-link':
      paddingX = Math.max(10, width * 0.3);
      paddingY = Math.max(10, height * 0.3);
      customScale = 1.2;
      break;
      
    case 'link':
      paddingX = Math.max(10, width * 0.5);
      paddingY = Math.max(10, height * 0.3);
      customScale = 1.3;
      break;
      
    // 입력 필드 타입
    case 'text-input':
    case 'search':
    case 'email':
    case 'url':
    case 'password':
      paddingX = Math.max(20, width * 0.2);
      paddingY = Math.max(15, height * 0.2);
      customScale = 1.25;
      break;
      
    case 'number-input':
    case 'date-input':
      paddingX = Math.max(15, width * 0.25);
      paddingY = Math.max(15, height * 0.25);
      customScale = 1.3;
      break;
      
    case 'textarea':
      paddingX = Math.max(25, width * 0.15);
      paddingY = Math.max(25, height * 0.15);
      customScale = 1.2;
      break;
      
    case 'select':
    case 'multi-select':
      paddingX = Math.max(20, width * 0.2);
      paddingY = Math.max(20, height * 0.2);
      customScale = 1.25;
      break;
      
    case 'checkbox':
    case 'radio':
      paddingX = Math.max(30, width * 0.8);
      paddingY = Math.max(30, height * 0.8);
      customScale = 1.8;
      break;
      
    case 'file-input':
    case 'color-input':
    case 'range-input':
      paddingX = Math.max(25, width * 0.3);
      paddingY = Math.max(25, height * 0.3);
      customScale = 1.4;
      break;
      
    // 이미지 타입
    case 'avatar-image':
    case 'logo-image':
      paddingX = Math.max(15, width * 0.2);
      paddingY = Math.max(15, height * 0.2);
      customScale = 1.3;
      break;
      
    case 'thumbnail-image':
      paddingX = Math.max(20, width * 0.25);
      paddingY = Math.max(20, height * 0.25);
      customScale = 1.4;
      break;
      
    case 'icon-image':
    case 'icon':
      paddingX = Math.max(25, width * 0.5);
      paddingY = Math.max(25, height * 0.5);
      customScale = 2.0;
      break;
      
    case 'image':
      paddingX = Math.max(20, width * 0.15);
      paddingY = Math.max(20, height * 0.15);
      customScale = 1.3;
      break;
      
    // 컨테이너 요소
    case 'card':
    case 'panel':
      paddingX = Math.max(30, width * 0.1);
      paddingY = Math.max(30, height * 0.1);
      customScale = 1.15;
      break;
      
    // 네비게이션 요소
    case 'tab':
    case 'nav-item':
    case 'menuitem':
      paddingX = Math.max(15, width * 0.3);
      paddingY = Math.max(15, height * 0.3);
      customScale = 1.3;
      break;
      
    // 텍스트 요소
    case 'heading':
      paddingX = Math.max(20, width * 0.2);
      paddingY = Math.max(15, height * 0.2);
      customScale = 1.25;
      break;
      
    case 'list-item':
      paddingX = Math.max(15, width * 0.25);
      paddingY = Math.max(10, height * 0.25);
      customScale = 1.2;
      break;
      
    case 'table-cell':
      paddingX = Math.max(10, width * 0.2);
      paddingY = Math.max(10, height * 0.2);
      customScale = 1.2;
      break;
      
    case 'label':
      paddingX = Math.max(10, width * 0.3);
      paddingY = Math.max(8, height * 0.3);
      customScale = 1.2;
      break;
      
    default:
      paddingX = Math.max(20, width * 0.25);
      paddingY = Math.max(20, height * 0.25);
      customScale = 1.3;
  }
  
  // 확대될 영역 계산
  const zoomArea = {
    x: visibleArea.x - paddingX,
    y: visibleArea.y - paddingY,
    width: visibleArea.width + (paddingX * 2),
    height: visibleArea.height + (paddingY * 2)
  };
  
  // 확대 비율 적용
  const centerX = visibleArea.x + visibleArea.width / 2;
  const centerY = visibleArea.y + visibleArea.height / 2;
  
  zoomArea.width = visibleArea.width * customScale;
  zoomArea.height = visibleArea.height * customScale;
  zoomArea.x = centerX - (zoomArea.width / 2);
  zoomArea.y = centerY - (zoomArea.height / 2);
  
  return zoomArea;
}

// 좌표 보정 함수
function normalizeCoordinatesToRecordingArea(zoomArea, cropArea) {
  // 녹화 영역을 벗어나는 좌표 보정
  const normalizedArea = { ...zoomArea };
  
  // X 좌표 보정
  if (normalizedArea.x < 0) {
    normalizedArea.width += normalizedArea.x;
    normalizedArea.x = 0;
  }
  
  // Y 좌표 보정
  if (normalizedArea.y < 0) {
    normalizedArea.height += normalizedArea.y;
    normalizedArea.y = 0;
  }
  
  // 너비 보정 (녹화 영역을 벗어나는 경우)
  if (normalizedArea.x + normalizedArea.width > cropArea.width) {
    normalizedArea.width = cropArea.width - normalizedArea.x;
  }
  
  // 높이 보정 (녹화 영역을 벗어나는 경우)
  if (normalizedArea.y + normalizedArea.height > cropArea.height) {
    normalizedArea.height = cropArea.height - normalizedArea.y;
  }
  
  return normalizedArea;
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
    
    // 새로 추가: 요소 클릭 줌 효과 관련 상태
    this.elementZoomEnabled = false;
    this.lastClickTime = 0;
    this.clickThrottleMs = 300; // 클릭 쓰로틀링

    // ✅ 강화된 메시지 리스너 추가
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // ping 메시지 즉시 응답
      if (msg.type === 'ping') {
        sendResponse({ success: true, timestamp: Date.now() });
        return true;
      }

      // REQUEST_VIEW_CONTEXT 핸들러 추가
      if (msg?.type === 'REQUEST_VIEW_CONTEXT') {
        const viewContext = this.collectViewContext();
        console.log('[ContentScript] REQUEST_VIEW_CONTEXT received, sending:', viewContext);
        sendResponse({ success: true, data: viewContext });
        return true;
      }

      // 비동기 라우팅 처리
      const handleAsync = async () => {
        try {
          const response = await this.route(msg);
          console.log('[ContentScript] Route response:', msg.type, response);
          sendResponse(response);
        } catch (error) {
          console.error('[ContentScript] Route error:', msg.type, error);
          sendResponse({ success: false, error: error.message });
        }
      };

      handleAsync();
      return true;  // 비동기 응답 대기
    });
    
    // 페이지 언로드 시 정리
    window.addEventListener('beforeunload', () => {
      console.log('[ContentScript] Page unloading, cleaning up');
      this.cleanup();
    });
    
    // 페이지 가시성 변화 감지
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[ContentScript] Page became visible, processing message queue');
        messageQueue.processQueue();
      }
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
    
    // 클릭 이벤트 리스너 설정
    this.setupClickEventListener();

    console.log('[ContentScript] Initialized and ready');
  }
  
  // 클릭 이벤트 리스너 설정
  setupClickEventListener() {
    // 캡처 단계에서 클릭 이벤트 감지
    document.addEventListener('click', (e) => {
      this.handleClickEvent(e);
    }, true);
  }
  
  // 클릭 이벤트 처리
  handleClickEvent(e) {
    // 기능이 비활성화되었거나 녹화 중이 아니면 무시
    if (!this.elementZoomEnabled || !this.currentCrop) return;
    
    // 클릭 쓰로틀링 적용
    const now = Date.now();
    if (now - this.lastClickTime < this.clickThrottleMs) return;
    this.lastClickTime = now;
    
    // 클릭된 요소 정보 수집
    const elementInfo = getElementInfo(e.target, this.currentCrop);
    
    // 녹화 영역과 겹치지 않으면 무시
    if (!elementInfo.isPartiallyInRecordingArea) return;
    
    // 줌 영역 계산
    const zoomArea = calculateZoomArea(elementInfo, 1.5);
    const normalizedZoomArea = normalizeCoordinatesToRecordingArea(zoomArea, this.currentCrop);
    
    // offscreen.js로 메시지 전송
    safeSend({
      type: MESSAGE_TYPES.ELEMENT_CLICKED_ZOOM,
      target: 'offscreen',
      data: {
        elementInfo,
        zoomArea: normalizedZoomArea,
        timestamp: now
      }
    });
  }
  async route(msg) {
    console.log('[ContentScript] Routing message:', msg.type);

    switch (msg.type) {
      // INITIALIZE_RECORDING 메시지 처리 추가
      case 'INITIALIZE_RECORDING':
        console.log('[ContentScript] Initialize recording message received:', msg.data);
        return { success: true };

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

      case MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM:
        // msg.data가 undefined인 경우 방지
        if (!msg.data) {
          console.warn('[ContentScript] TOGGLE_ELEMENT_ZOOM received without data');
          return { success: false, error: 'No data provided' };
        }
        this.elementZoomEnabled = msg.data.enabled;
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
    // 메시지 큐를 통한 안전한 전송
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
    // 정리 작업
    if (this.areaSelector) {
      this.areaSelector.hide();
    }
    if (this.dock) {
      this.dock.hide();
    }
    if (this.recordingOverlay) {
      this.recordingOverlay.hide();
    }
    if (this.zoomHL) {
      this.zoomHL.disable();
    }
  }
}

new ContentMain();
