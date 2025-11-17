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

class Dock {
  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'screen-recorder-dock';
    this.host.style.cssText = 'all: initial; position: fixed; right: 20px; top: 20px; z-index: 2147483646; pointer-events: auto; display: block;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.dock{display:flex;gap:8px;align-items:center;padding:10px 14px;border-radius:12px;background:rgba(0,0,0,.9);color:#fff;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.btn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer}.stat{font:12px monospace}.group{display:flex;gap:6px;align-items:center}';
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
    const g1 = document.createElement('div'); g1.className = 'group'; g1.append(this.timeEl, this.sizeEl);
    const g2 = document.createElement('div'); g2.className = 'group'; g2.append(this.pauseBtn, this.stopBtn);
    this.wrap.append(g1, g2);
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
    else {
      const k = 1024; const sizes = ['B','KB','MB','GB']; const i = Math.floor(Math.log(bytes)/Math.log(k));
      this.sizeEl.textContent = `${(bytes/Math.pow(k,i)).toFixed(2)} ${sizes[i]}`;
    }
  }
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
    style.textContent = `
      .box {
        position: fixed;
        pointer-events: none;
        border: 2px solid rgba(255, 26, 26, 0.9);
        box-sizing: border-box;
        box-shadow:
          0 0 6px rgba(255, 26, 26, 0.7),
          0 0 12px rgba(255, 26, 26, 0.4);
      }
    `;
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


class ContentMain {
  constructor() {
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
        try {
          await safeSend({ type: MESSAGE_TYPES.CONTENT_SCRIPT_READY, initTime });
        } catch {}
        this.setupClickEventListener();
        this.sendViewportInfo();
      } catch (error) {
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

    switch (msg.type) {
      case MESSAGE_TYPES.SHOW_AREA_SELECTOR:
        if (!this.areaSelector) this.areaSelector = new SelectionOverlay();
        this.areaSelector.show();
        return { success: true };

      case MESSAGE_TYPES.HIDE_AREA_SELECTOR:
        if (this.areaSelector) this.areaSelector.hide();
        return { success: true };

      case MESSAGE_TYPES.SHOW_DOCK:
        this.isRecording = true;
        this.dock.show();
        
        if (this.currentCrop) {
          this.recordingOverlay.show(this.currentCrop);
        }
        
        return { success: true };

      case MESSAGE_TYPES.HIDE_DOCK:
        this.isRecording = false;
        this.dock.hide();
        // 오버레이는 녹화 중에도 유지하기 위해 여기서 숨기지 않음
        return { success: true };

      case MESSAGE_TYPES.UPDATE_DOCK_STATS:
        this.dock.updateStats(msg.data || {});
        return { success: true };

      case 'set-recording-crop':
        this.currentCrop = msg.data;

        // 선택 중(isSelecting) 여부와 상관없이, 현재 crop 기준으로 항상 오버레이 업데이트
        // (녹화 중에도 영역 표시 유지)
        this.recordingOverlay.show(this.currentCrop);

        // offscreen에 viewport 정보는 계속 보내줌
        this.sendViewportInfo();
        return { success: true };

      case MESSAGE_TYPES.UPDATE_PREFS:
        if (msg.data) {
          if (typeof msg.data.clickElementZoomEnabled !== 'undefined') this.elementZoomEnabled = !!msg.data.clickElementZoomEnabled;
          if (typeof msg.data.elementZoomScale !== 'undefined') this.elementZoomScale = parseFloat(msg.data.elementZoomScale) || 1.5;
          if (typeof msg.data.elementZoomDuration !== 'undefined') this.elementZoomDuration = parseInt(msg.data.elementZoomDuration, 10) || 800;
        }
        return { success: true };

      case MESSAGE_TYPES.TOGGLE_ELEMENT_ZOOM:
        if (!msg.data) return { success: false, error: 'No data provided' };
        this.elementZoomEnabled = msg.data.enabled;
        return { success: true };

      case 'recording-finished':
        try {
          const { format, size, filename } = msg.data || {};
          const toast = document.createElement('div');
          toast.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;padding:10px 14px;border-radius:8px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3)';
          toast.textContent = `Saved ${filename || format} (${(size/1024/1024).toFixed(2)} MB)`;
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 4000);
        } catch {}
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
    if (this.areaSelector) this.areaSelector.hide();
    if (this.dock) this.dock.hide();
    if (this.recordingOverlay) this.recordingOverlay.hide();
  }
}

new ContentMain();
