export const MESSAGE_TYPES = {
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
  GIF_ENCODING_PROGRESS: 'gif-encoding-progress'
};

export const RECORDING_STATES = {
  IDLE: 'idle',
  SELECTING_AREA: 'selecting-area',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  ENCODING: 'encoding'
};

export const RECORDING_MODES = {
  FULL_SCREEN: 'full-screen',
  AREA: 'area'
};

export const VIDEO_QUALITY = {
  LOW: { bitrate: 2000000, label: 'Low (2 Mbps)' },
  MEDIUM: { bitrate: 5000000, label: 'Medium (5 Mbps)' },
  HIGH: { bitrate: 8000000, label: 'High (8 Mbps)' },
  ULTRA: { bitrate: 15000000, label: 'Ultra (15 Mbps)' }
};

export const GIF_QUALITY = {
  ULTRA: { value: 1, label: 'Ultra (Largest file)' },
  HIGH: { value: 5, label: 'High' },
  MEDIUM: { value: 10, label: 'Medium (Recommended)' },
  LOW: { value: 20, label: 'Low (Smallest file)' }
};

export const FORMATS = {
  WEBM: 'WEBM',
  MP4: 'MP4',
  GIF: 'GIF'
};

export const STORAGE_KEYS = {
  RECORDING_STATE: 'recordingState',
  USER_PREFERENCES: 'userPreferences',
  RECORDING_DATA: 'recordingData',
  OFFSCREEN_STATE: 'offscreenState',
  LAST_RECORDING_ID: 'lastRecordingId'
};

export const DEFAULT_PREFERENCES = {
  quality: 'HIGH',
  fps: 30,
  format: 'WEBM',
  includeAudio: true,
  laserPointerEnabled: false,
  clickZoomEnabled: true,
  showDock: true,
  showCursor: true,
  zoomHighlightEnabled: false,
  zoomHighlightDurationSec: 3,
  zoomHighlightScale: 1.2,
  gifFps: 10,
  gifQuality: 10,
  gifDither: false
};

export const GIF_CONSTRAINTS = {
  MAX_DURATION_SEC: 60,
  MAX_FRAMES: 600,
  MAX_DIMENSION: 800,
  MIN_FPS: 8,
  MAX_FPS: 15,
  DEFAULT_FPS: 10
};

export const CHUNK_SIZE_LIMIT = 10 * 1024 * 1024;

export const KEEP_ALIVE_INTERVAL = 45000;

export const STATE_STALE_TIMEOUT = 10 * 60 * 1000;
