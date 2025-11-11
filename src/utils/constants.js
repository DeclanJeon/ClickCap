export const MESSAGE_TYPES = {
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  PAUSE_RECORDING: 'pause-recording',
  RESUME_RECORDING: 'resume-recording',
  CANCEL_RECORDING: 'cancel-recording',
  AREA_SELECTED: 'area-selected',
  RECORDING_STATS: 'recording-stats',
  RECORDING_COMMAND: 'recording-command',
  MOUSE_MOVE: 'mouse-move',
  MOUSE_CLICK: 'mouse-click',
  TOGGLE_LASER: 'toggle-laser',
  SHOW_AREA_SELECTOR: 'show-area-selector',
  HIDE_AREA_SELECTOR: 'hide-area-selector',
  SHOW_DOCK: 'show-dock',
  HIDE_DOCK: 'hide-dock',
  UPDATE_DOCK_STATS: 'update-dock-stats',
  RECORDING_STATE_CHANGED: 'recording-state-changed'
};

export const RECORDING_STATES = {
  IDLE: 'idle',
  SELECTING_AREA: 'selecting-area',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPED: 'stopped'
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

export const FORMATS = {
  WEBM: 'webm',
  MP4: 'mp4',
  GIF: 'gif'
};

export const STORAGE_KEYS = {
  RECORDING_STATE: 'recordingState',
  USER_PREFERENCES: 'userPreferences',
  RECORDING_DATA: 'recordingData'
};

export const DEFAULT_PREFERENCES = {
  quality: 'HIGH',
  fps: 30,
  format: 'WEBM',
  includeAudio: true,
  laserPointerEnabled: false,
  clickZoomEnabled: true
};
