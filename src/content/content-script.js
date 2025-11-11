const MESSAGE_TYPES = {
  SHOW_AREA_SELECTOR: 'show-area-selector',
  HIDE_AREA_SELECTOR: 'hide-area-selector',
  AREA_SELECTED: 'area-selected',
  SHOW_DOCK: 'show-dock',
  HIDE_DOCK: 'hide-dock',
  UPDATE_DOCK_STATS: 'update-dock-stats',
  RECORDING_COMMAND: 'recording-command',
  TOGGLE_LASER: 'toggle-laser',
  CONTENT_SCRIPT_READY: 'content-script-ready'
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

class AreaSelector {
  constructor(onSelected) {
    this.onSelected = onSelected;
    this.host = document.createElement('div');
    this.host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);cursor:crosshair;}
      .box{position:absolute;border:3px solid #ff0000;background:rgba(255,0,0,0.1);display:none;}
      .tip{position:fixed;left:50%;top:20px;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,.6);padding:8px 12px;border-radius:8px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    `;
    shadow.appendChild(style);

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.textContent = '드래그하여 영역 선택 (ESC 취소)';

    this.overlay.appendChild(this.box);
    shadow.appendChild(this.overlay);
    shadow.appendChild(this.tip);

    this.down = null;
    this.mouseDown = (e) => {
      this.down = { x: e.clientX, y: e.clientY };
      Object.assign(this.box.style, { left: this.down.x + 'px', top: this.down.y + 'px', width: '0px', height: '0px', display: 'block' });
    };
    this.mouseMove = (e) => {
      if (!this.down) return;
      const x = Math.min(this.down.x, e.clientX);
      const y = Math.min(this.down.y, e.clientY);
      const w = Math.abs(e.clientX - this.down.x);
      const h = Math.abs(e.clientY - this.down.y);
      Object.assign(this.box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    };
    this.mouseUp = async (e) => {
      if (!this.down) return;
      const x = Math.min(this.down.x, e.clientX);
      const y = Math.min(this.down.y, e.clientY);
      const w = Math.abs(e.clientX - this.down.x);
      const h = Math.abs(e.clientY - this.down.y);
      this.down = null;
      if (w > 30 && h > 30) {
        await safeSend({ type: MESSAGE_TYPES.AREA_SELECTED, data: { cropArea: { x, y, width: w, height: h } } });
        this.hide();
      } else {
        this.box.style.display = 'none';
      }
    };
    this.keyDown = (e) => {
      if (e.key === 'Escape') this.hide();
    };
  }

  show() {
    if (!document.body) return setTimeout(() => this.show(), 50);
    document.body.appendChild(this.host);
    this.overlay.addEventListener('mousedown', this.mouseDown);
    window.addEventListener('mousemove', this.mouseMove);
    window.addEventListener('mouseup', this.mouseUp);
    window.addEventListener('keydown', this.keyDown);
  }

  hide() {
    this.overlay.removeEventListener('mousedown', this.mouseDown);
    window.removeEventListener('mousemove', this.mouseMove);
    window.removeEventListener('mouseup', this.mouseUp);
    window.removeEventListener('keydown', this.keyDown);
    if (this.host.parentNode) this.host.parentNode.removeChild(this.host);
  }
}

class Dock {
  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-dock';
    this.host.style.cssText = `
      all: initial; position: fixed; right: 20px; top: 20px; z-index: 2147483646;
      pointer-events: auto; visibility: visible; display: block;`;

    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .dock{display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:12px;
        background:rgba(0,0,0,0.9);color:#fff;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
      .btn{background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);color:#fff;
        padding:6px 10px;border-radius:8px;cursor:pointer;}
      .stat{font:12px monospace;}
    `;
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
    this.wrap.append(this.timeEl, this.sizeEl, this.pauseBtn, this.stopBtn);
    shadow.appendChild(this.wrap);

    this.pauseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await safeSend({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'pause' });
      this.pauseBtn.textContent = this.pauseBtn.textContent === 'Pause' ? 'Resume' : 'Pause';
    });
    this.stopBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await safeSend({ type: MESSAGE_TYPES.RECORDING_COMMAND, command: 'stop' });
      this.hide();
    });
  }

  show() {
    if (!document.body) return setTimeout(() => this.show(), 50);
    const exist = document.getElementById('screen-recorder-dock');
    if (exist && exist !== this.host) exist.remove();
    if (!document.body.contains(this.host)) document.body.appendChild(this.host);
    this.host.style.display = 'block';
    this.host.style.visibility = 'visible';
  }

  hide() {
    if (this.host.parentNode) this.host.parentNode.removeChild(this.host);
  }

  updateStats({ duration, size }) {
    this.timeEl.textContent = this.formatTime(duration || 0);
    this.sizeEl.textContent = this.formatSize(size || 0);
  }

  formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  formatSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024; const sizes = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(bytes)/Math.log(k));
    return `${(bytes/Math.pow(k,i)).toFixed(2)} ${sizes[i]}`;
  }
}

class ContentMain {
  constructor() {
    this.areaSelector = null;
    this.dock = new Dock();

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'ping') { sendResponse({ success: true }); return true; }
      this.route(msg).then(sendResponse);
      return true;
    });

    // 스크립트 준비 알림
    safeSend({ type: MESSAGE_TYPES.CONTENT_SCRIPT_READY });
  }

  async route(msg) {
    switch (msg.type) {
      case MESSAGE_TYPES.SHOW_AREA_SELECTOR:
        if (!this.areaSelector) {
          this.areaSelector = new AreaSelector(async (crop) => {
            await safeSend({ type: MESSAGE_TYPES.AREA_SELECTED, data: { cropArea: crop } });
          });
        }
        this.areaSelector.show();
        return { success: true };
      case MESSAGE_TYPES.HIDE_AREA_SELECTOR:
        if (this.areaSelector) this.areaSelector.hide();
        return { success: true };
      case MESSAGE_TYPES.SHOW_DOCK:
        this.dock.show();
        return { success: true };
      case MESSAGE_TYPES.HIDE_DOCK:
        this.dock.hide();
        return { success: true };
      case MESSAGE_TYPES.UPDATE_DOCK_STATS:
        this.dock.updateStats(msg.data || {});
        return { success: true };
      default:
        return { success: false };
    }
  }
}

new ContentMain();
console.log('[Content] Loaded');