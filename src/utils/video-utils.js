export function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function generateFilename(format, prefix = 'recording') {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${randomSuffix}.${format.toLowerCase()}`;
}

export function getMimeType(format) {
  const mimeTypes = {
    WEBM: 'video/webm;codecs=vp9,opus',
    webm: 'video/webm;codecs=vp9,opus',
    MP4: 'video/mp4',
    mp4: 'video/mp4',
    GIF: 'image/gif',
    gif: 'image/gif'
  };
  return mimeTypes[format] || 'video/webm;codecs=vp9,opus';
}

export function estimateBitrate(quality) {
  const bitrateMap = {
    LOW: 2000000,
    MEDIUM: 5000000,
    HIGH: 8000000,
    ULTRA: 15000000
  };
  return bitrateMap[quality] || bitrateMap.HIGH;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 100);
}

export async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function calculateCropArea(sourceWidth, sourceHeight, cropArea) {
  if (!cropArea) {
    return {
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
      destWidth: sourceWidth,
      destHeight: sourceHeight
    };
  }

  const sourceX = Math.max(0, Math.min(cropArea.x, sourceWidth));
  const sourceY = Math.max(0, Math.min(cropArea.y, sourceHeight));
  const sourceWidth_ = Math.max(1, Math.min(cropArea.width, sourceWidth - sourceX));
  const sourceHeight_ = Math.max(1, Math.min(cropArea.height, sourceHeight - sourceY));

  return {
    sourceX,
    sourceY,
    sourceWidth: sourceWidth_,
    sourceHeight: sourceHeight_,
    destWidth: sourceWidth_,
    destHeight: sourceHeight_
  };
}
