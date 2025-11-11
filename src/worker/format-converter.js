importScripts('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');

const { createFFmpeg, fetchFile } = FFmpeg;

class FormatConverter {
  constructor() {
    this.ffmpeg = createFFmpeg({
      log: true,
      corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js'
    });
    this.isLoaded = false;
  }

  async init() {
    if (!this.isLoaded) {
      await this.ffmpeg.load();
      this.isLoaded = true;
    }
  }

  async convertToMP4(webmBlob, onProgress) {
    await this.init();

    const inputName = 'input.webm';
    const outputName = 'output.mp4';

    this.ffmpeg.FS('writeFile', inputName, await fetchFile(webmBlob));

    this.ffmpeg.setProgress(({ ratio }) => {
      if (onProgress) {
        onProgress(Math.round(ratio * 100));
      }
    });

    await this.ffmpeg.run(
      '-i', inputName,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputName
    );

    const data = this.ffmpeg.FS('readFile', outputName);
    this.ffmpeg.FS('unlink', inputName);
    this.ffmpeg.FS('unlink', outputName);

    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  async convertToGIF(webmBlob, options = {}, onProgress) {
    await this.init();

    const {
      fps = 10,
      width = 480,
      quality = 80
    } = options;

    const inputName = 'input.webm';
    const outputName = 'output.gif';

    this.ffmpeg.FS('writeFile', inputName, await fetchFile(webmBlob));

    this.ffmpeg.setProgress(({ ratio }) => {
      if (onProgress) {
        onProgress(Math.round(ratio * 100));
      }
    });

    await this.ffmpeg.run(
      '-i', inputName,
      '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
      '-loop', '0',
      outputName
    );

    const data = this.ffmpeg.FS('readFile', outputName);
    this.ffmpeg.FS('unlink', inputName);
    this.ffmpeg.FS('unlink', outputName);

    return new Blob([data.buffer], { type: 'image/gif' });
  }

  async extractFrame(videoBlob, timeInSeconds) {
    await this.init();

    const inputName = 'input.webm';
    const outputName = 'frame.png';

    this.ffmpeg.FS('writeFile', inputName, await fetchFile(videoBlob));

    await this.ffmpeg.run(
      '-i', inputName,
      '-ss', timeInSeconds.toString(),
      '-vframes', '1',
      '-q:v', '2',
      outputName
    );

    const data = this.ffmpeg.FS('readFile', outputName);
    this.ffmpeg.FS('unlink', inputName);
    this.ffmpeg.FS('unlink', outputName);

    return new Blob([data.buffer], { type: 'image/png' });
  }

  async trimVideo(videoBlob, startTime, endTime) {
    await this.init();

    const inputName = 'input.webm';
    const outputName = 'output.webm';

    this.ffmpeg.FS('writeFile', inputName, await fetchFile(videoBlob));

    const duration = endTime - startTime;

    await this.ffmpeg.run(
      '-i', inputName,
      '-ss', startTime.toString(),
      '-t', duration.toString(),
      '-c', 'copy',
      outputName
    );

    const data = this.ffmpeg.FS('readFile', outputName);
    this.ffmpeg.FS('unlink', inputName);
    this.ffmpeg.FS('unlink', outputName);

    return new Blob([data.buffer], { type: 'video/webm' });
  }
}

const converter = new FormatConverter();

self.addEventListener('message', async (event) => {
  const { type, data, id } = event.data;

  try {
    let result;

    switch (type) {
      case 'convert-to-mp4':
        result = await converter.convertToMP4(data.blob, (progress) => {
          self.postMessage({ type: 'progress', id, progress });
        });
        break;

      case 'convert-to-gif':
        result = await converter.convertToGIF(data.blob, data.options, (progress) => {
          self.postMessage({ type: 'progress', id, progress });
        });
        break;

      case 'extract-frame':
        result = await converter.extractFrame(data.blob, data.time);
        break;

      case 'trim-video':
        result = await converter.trimVideo(data.blob, data.startTime, data.endTime);
        break;

      default:
        throw new Error(`Unknown conversion type: ${type}`);
    }

    self.postMessage({ type: 'success', id, result });
  } catch (error) {
    self.postMessage({ type: 'error', id, error: error.message });
  }
});
