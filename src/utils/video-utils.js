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
  return `${prefix}_${timestamp}.${format}`;
}

export function getMimeType(format) {
  const mimeTypes = {
    webm: 'video/webm;codecs=vp9,opus',
    mp4: 'video/mp4',
    gif: 'image/gif'
  };
  return mimeTypes[format] || mimeTypes.webm;
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

export function cropVideoStream(originalStream, cropArea, fps = 30) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.srcObject = originalStream;
    video.muted = true;
    
    video.onloadedmetadata = () => {
      video.play();
      
      const canvas = document.createElement('canvas');
      canvas.width = cropArea.width;
      canvas.height = cropArea.height;
      const ctx = canvas.getContext('2d');

      let animationId;
      const drawFrame = () => {
        ctx.drawImage(
          video,
          cropArea.x,
          cropArea.y,
          cropArea.width,
          cropArea.height,
          0,
          0,
          cropArea.width,
          cropArea.height
        );
        animationId = requestAnimationFrame(drawFrame);
      };
      drawFrame();

      const croppedVideoStream = canvas.captureStream(fps);
      
      const audioTrack = originalStream.getAudioTracks()[0];
      if (audioTrack) {
        croppedVideoStream.addTrack(audioTrack);
      }

      resolve({
        stream: croppedVideoStream,
        cleanup: () => {
          cancelAnimationFrame(animationId);
          video.srcObject = null;
          video.remove();
          canvas.remove();
        }
      });
    };

    video.onerror = (error) => reject(error);
  });
}

export async function mergeBlobs(blobs) {
  return new Blob(blobs, { type: blobs[0].type });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
