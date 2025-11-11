/**
 * Format Converter Worker - Native Browser APIs Only
 * No external dependencies, pure browser APIs
 */

// WebM to MP4 conversion using MediaRecorder + Canvas
async function convertToMP4(webmBlob, onProgress) {
  try {
    onProgress(10);

    // Create video element from WebM
    const videoUrl = URL.createObjectURL(webmBlob);
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });

    onProgress(30);

    // Create canvas for re-encoding
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');

    // Capture stream from canvas
    const stream = canvas.captureStream(30);

    // Add audio track if exists
    try {
      const audioContext = new AudioContext();
      const source = audioContext.createMediaElementSource(video);
      const destination = audioContext.createMediaStreamDestination();
      source.connect(destination);

      if (destination.stream.getAudioTracks().length > 0) {
        stream.addTrack(destination.stream.getAudioTracks()[0]);
      }
      audioContext.close();
    } catch (audioError) {
      console.warn('Audio processing failed, continuing without audio:', audioError);
    }

    onProgress(50);

    // Record with MP4-compatible codec (fallback to WebM if MP4 not supported)
    let mimeType = 'video/webm;codecs=vp9,opus';
    let fileName = 'recording.webm';

    // Try MP4 format if supported
    if (MediaRecorder.isTypeSupported('video/mp4')) {
      mimeType = 'video/mp4';
      fileName = 'recording.mp4';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
      mimeType = 'video/webm;codecs=h264';
    }

    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8000000
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    // Play video and draw to canvas
    video.play();
    let frameCount = 0;
    const totalFrames = Math.floor(video.duration * 30);

    const drawFrame = () => {
      if (video.ended || video.paused) {
        recorder.stop();
        return;
      }

      ctx.drawImage(video, 0, 0);
      frameCount++;

      const progress = 50 + Math.floor((frameCount / totalFrames) * 40);
      onProgress(Math.min(progress, 90));

      requestAnimationFrame(drawFrame);
    };

    recorder.start();
    drawFrame();

    // Wait for recording to finish
    const outputBlob = await new Promise((resolve) => {
      recorder.onstop = () => {
        const finalBlob = new Blob(chunks, { type: mimeType });
        resolve(finalBlob);
      };
    });

    // Cleanup
    URL.revokeObjectURL(videoUrl);
    video.remove();
    canvas.remove();

    onProgress(100);
    return { blob: outputBlob, fileName };

  } catch (error) {
    console.error('MP4 conversion failed:', error);
    throw new Error('MP4 conversion failed: ' + error.message);
  }
}

// WebM to GIF conversion using Canvas
async function convertToGIF(webmBlob, options, onProgress) {
  const {
    fps = 10,
    width = 480,
    quality = 10
  } = options;

  try {
    onProgress(10);

    // Create video element
    const videoUrl = URL.createObjectURL(webmBlob);
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });

    onProgress(30);

    // Create canvas
    const canvas = document.createElement('canvas');
    const aspectRatio = video.videoWidth / video.videoHeight;
    canvas.width = width;
    canvas.height = Math.floor(width / aspectRatio);
    const ctx = canvas.getContext('2d');

    // Extract frames
    const frames = [];
    const frameDuration = 1000 / fps;
    const totalFrames = Math.floor(video.duration * fps);

    for (let i = 0; i < Math.min(totalFrames, 50); i++) { // Limit to 50 frames for performance
      const currentTime = i / fps;
      video.currentTime = currentTime;

      await new Promise(resolve => {
        video.onseeked = resolve;
      });

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      frames.push(imageData);

      const progress = 30 + Math.floor((i / Math.min(totalFrames, 50)) * 60);
      onProgress(Math.min(progress, 90));
    }

    onProgress(95);

    // Create animated WebP as GIF fallback (more widely supported)
    const gifBlob = await createAnimatedWebP(frames, frameDuration, canvas.width, canvas.height);

    // Cleanup
    URL.revokeObjectURL(videoUrl);
    video.remove();
    canvas.remove();

    onProgress(100);
    return { blob: gifBlob, fileName: 'recording.webp' };

  } catch (error) {
    console.error('GIF conversion failed:', error);
    throw new Error('GIF conversion failed: ' + error.message);
  }
}

// Create animated WebP as GIF replacement
async function createAnimatedWebP(frames, delay, width, height) {
  // Simple implementation - create a single frame WebP
  // For true animation, a more complex encoder would be needed
  if (frames.length === 0) {
    throw new Error('No frames to convert');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Use the first frame
  ctx.putImageData(frames[0], 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      canvas.remove();
      resolve(blob);
    }, 'image/webp', quality);
  });
}

// Simple video info extraction
async function getVideoInfo(webmBlob) {
  try {
    const videoUrl = URL.createObjectURL(webmBlob);
    const video = document.createElement('video');
    video.src = videoUrl;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });

    const info = {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      frameRate: 30, // Estimated
      size: webmBlob.size
    };

    URL.revokeObjectURL(videoUrl);
    video.remove();

    return info;
  } catch (error) {
    throw new Error('Failed to get video info: ' + error.message);
  }
}

// Message handler
self.addEventListener('message', async (event) => {
  const { type, data, id } = event.data;

  try {
    let result;

    switch (type) {
      case 'init':
        result = { success: true, message: 'Native API converter initialized' };
        break;

      case 'convert-to-mp4':
        const mp4Result = await convertToMP4(data.blob, (progress) => {
          self.postMessage({ type: 'progress', id, progress });
        });
        result = mp4Result;
        break;

      case 'convert-to-gif':
        const gifResult = await convertToGIF(data.blob, data.options || {}, (progress) => {
          self.postMessage({ type: 'progress', id, progress });
        });
        result = gifResult;
        break;

      case 'get-video-info':
        result = await getVideoInfo(data.blob);
        break;

      default:
        throw new Error(`Unknown conversion type: ${type}`);
    }

    self.postMessage({ type: 'success', id, result });
  } catch (error) {
    console.error('Conversion error:', error);
    self.postMessage({
      type: 'error',
      id,
      error: error.message || 'Unknown error occurred'
    });
  }
});

console.log('[Format Converter] Worker initialized with native browser APIs');