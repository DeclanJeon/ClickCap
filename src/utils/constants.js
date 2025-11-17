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
  UPDATE_PREFS: 'update-prefs',
  VIEWPORT_INFO: 'viewport-info',
  ELEMENT_CLICKED_ZOOM: 'element-clicked-zoom',
  TOGGLE_ELEMENT_ZOOM: 'toggle-element-zoom'
};

export const STORAGE_KEYS = {
  USER_PREFERENCES: 'userPreferences'
};

export const DEFAULT_PREFERENCES = {
  quality: 'HIGH',
  fps: 30,
  includeAudio: true,
  showDock: true,
  clickElementZoomEnabled: true,
  elementZoomScale: 1.5,
  elementZoomDuration: 800
};

// Chunk size limit for storage (10MB)
export const CHUNK_SIZE_LIMIT = 10 * 1024 * 1024;
