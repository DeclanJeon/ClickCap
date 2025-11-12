export class RecordingDebugger {
  constructor() {
    this.debugData = {};
  }

  async captureFullDiagnostics(video, cropAreaCSS, view) {
    console.log('🔍 ========== RECORDING DIAGNOSTICS START ==========');
    
    // 1. 비디오 스트림 정보
    this.debugData.video = {
      width: video.videoWidth,
      height: video.videoHeight,
      readyState: video.readyState,
      currentTime: video.currentTime
    };

    // 2. 뷰포트 정보
    this.debugData.viewport = {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      devicePixelRatio: window.devicePixelRatio
    };

    // 3. Visual Viewport 정보
    const vv = window.visualViewport;
    this.debugData.visualViewport = vv ? {
      width: vv.width,
      height: vv.height,
      offsetLeft: vv.offsetLeft,
      offsetTop: vv.offsetTop,
      pageLeft: vv.pageLeft,
      pageTop: vv.pageTop,
      scale: vv.scale
    } : null;

    // 4. Document 정보
    this.debugData.document = {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };

    // 5. CSS Crop 정보
    this.debugData.cssCrop = cropAreaCSS ? {
      x: cropAreaCSS.x,
      y: cropAreaCSS.y,
      width: cropAreaCSS.width,
      height: cropAreaCSS.height
    } : null;

    // 6. View Context (from content script)
    this.debugData.viewContext = view;

    // 7. 비디오 첫 프레임 캡처 및 분석
    await this.captureAndAnalyzeFrames(video, cropAreaCSS);

    // 8. 계산된 비율들
    this.debugData.calculations = this.calculateAllRatios();

    // 9. 콘솔에 출력
    this.printDiagnostics();

    // 10. JSON 파일로 저장
    this.downloadDiagnosticsJSON();

    console.log('🔍 ========== RECORDING DIAGNOSTICS END ==========');

    return this.debugData;
  }

  async captureAndAnalyzeFrames(video, cropAreaCSS) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');

    // 첫 프레임 그리기
    ctx.drawImage(video, 0, 0);

    // Frame 1: 전체 비디오 스트림
    const frame1Blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    this.downloadImage(frame1Blob, `debug-01-full-video-${canvas.width}x${canvas.height}.png`);

    // Frame 2: CSS 좌표로 빨간 박스 (1:1 매핑 가정)
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 5;
    if (cropAreaCSS) {
      ctx.strokeRect(cropAreaCSS.x, cropAreaCSS.y, cropAreaCSS.width, cropAreaCSS.height);
      ctx.font = '20px Arial';
      ctx.fillStyle = '#ff0000';
      ctx.fillText(`CSS: (${cropAreaCSS.x}, ${cropAreaCSS.y})`, cropAreaCSS.x + 10, cropAreaCSS.y + 30);
    }
    const frame2Blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    this.downloadImage(frame2Blob, `debug-02-css-coordinates-1to1.png`);

    // Frame 3: DPR 적용한 좌표로 파란 박스
    ctx.drawImage(video, 0, 0);
    const dpr = window.devicePixelRatio;
    if (cropAreaCSS) {
      ctx.strokeStyle = '#0000ff';
      ctx.lineWidth = 5;
      const dprX = cropAreaCSS.x * dpr;
      const dprY = cropAreaCSS.y * dpr;
      const dprW = cropAreaCSS.width * dpr;
      const dprH = cropAreaCSS.height * dpr;
      ctx.strokeRect(dprX, dprY, dprW, dprH);
      ctx.fillStyle = '#0000ff';
      ctx.fillText(`DPR: (${Math.round(dprX)}, ${Math.round(dprY)})`, dprX + 10, dprY + 30);
    }
    const frame3Blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    this.downloadImage(frame3Blob, `debug-03-dpr-coordinates.png`);

    // Frame 4: Video/Viewport 비율 적용한 좌표로 초록 박스
    ctx.drawImage(video, 0, 0);
    if (cropAreaCSS) {
      const scaleX = video.videoWidth / window.innerWidth;
      const scaleY = video.videoHeight / window.innerHeight;
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 5;
      const scaledX = cropAreaCSS.x * scaleX;
      const scaledY = cropAreaCSS.y * scaleY;
      const scaledW = cropAreaCSS.width * scaleX;
      const scaledH = cropAreaCSS.height * scaleY;
      ctx.strokeRect(scaledX, scaledY, scaledW, scaledH);
      ctx.fillStyle = '#00ff00';
      ctx.fillText(`Scaled: (${Math.round(scaledX)}, ${Math.round(scaledY)})`, scaledX + 10, scaledY + 30);
    }
    const frame4Blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    this.downloadImage(frame4Blob, `debug-04-viewport-ratio-coordinates.png`);

    // Frame 5: 모든 박스 함께 표시
    ctx.drawImage(video, 0, 0);
    if (cropAreaCSS) {
      // 빨간색: CSS 1:1
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 3;
      ctx.strokeRect(cropAreaCSS.x, cropAreaCSS.y, cropAreaCSS.width, cropAreaCSS.height);

      // 파란색: DPR 적용
      ctx.strokeStyle = '#0000ff';
      ctx.lineWidth = 3;
      const dprX = cropAreaCSS.x * dpr;
      const dprY = cropAreaCSS.y * dpr;
      const dprW = cropAreaCSS.width * dpr;
      const dprH = cropAreaCSS.height * dpr;
      ctx.strokeRect(dprX, dprY, dprW, dprH);

      // 초록색: Viewport 비율
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 3;
      const scaleX = video.videoWidth / window.innerWidth;
      const scaleY = video.videoHeight / window.innerHeight;
      const scaledX = cropAreaCSS.x * scaleX;
      const scaledY = cropAreaCSS.y * scaleY;
      const scaledW = cropAreaCSS.width * scaleX;
      const scaledH = cropAreaCSS.height * scaleY;
      ctx.strokeRect(scaledX, scaledY, scaledW, scaledH);

      // 범례
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(10, 10, 300, 100);
      ctx.fillStyle = '#000000';
      ctx.font = '16px Arial';
      ctx.fillText('🔴 Red: CSS 1:1 mapping', 20, 30);
      ctx.fillText('🔵 Blue: DPR applied', 20, 55);
      ctx.fillText('🟢 Green: Viewport ratio', 20, 80);
    }
    const frame5Blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    this.downloadImage(frame5Blob, `debug-05-all-methods-comparison.png`);

    // Frame 6: 픽셀 그리드 오버레이 (측정 도구)
    ctx.drawImage(video, 0, 0);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    // 가로선
    for (let y = 0; y < canvas.height; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillText(y.toString(), 5, y - 5);
    }
    // 세로선
    for (let x = 0; x < canvas.width; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillText(x.toString(), x + 5, 15);
    }
    const frame6Blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    this.downloadImage(frame6Blob, `debug-06-pixel-grid-for-measurement.png`);

    // 픽셀 분석
    this.debugData.pixelAnalysis = this.analyzePixels(ctx, video.videoWidth, video.videoHeight, cropAreaCSS);

    canvas.remove();
  }

  analyzePixels(ctx, width, height, cropAreaCSS) {
    const analysis = {};

    // 상단 100px 영역 분석 (헤더 감지용)
    const topRegion = ctx.getImageData(0, 0, width, Math.min(100, height));
    analysis.topRegion = {
      averageBrightness: this.getAverageBrightness(topRegion),
      rowBrightness: []
    };

    for (let y = 0; y < Math.min(100, height); y += 10) {
      const rowData = ctx.getImageData(0, y, width, 1);
      analysis.topRegion.rowBrightness.push({
        y: y,
        brightness: this.getAverageBrightness(rowData)
      });
    }

    // CSS 선택 영역의 경계 픽셀 분석
    if (cropAreaCSS) {
      // 상단 경계
      const topEdge = ctx.getImageData(cropAreaCSS.x, cropAreaCSS.y, cropAreaCSS.width, 1);
      analysis.cropEdges = {
        top: {
          y: cropAreaCSS.y,
          brightness: this.getAverageBrightness(topEdge),
          dominantColor: this.getDominantColor(topEdge)
        }
      };

      // 좌측 경계
      const leftEdge = ctx.getImageData(cropAreaCSS.x, cropAreaCSS.y, 1, cropAreaCSS.height);
      analysis.cropEdges.left = {
        x: cropAreaCSS.x,
        brightness: this.getAverageBrightness(leftEdge),
        dominantColor: this.getDominantColor(leftEdge)
      };
    }

    return analysis;
  }

  getAverageBrightness(imageData) {
    let sum = 0;
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    return Math.round(sum / (data.length / 4));
  }

  getDominantColor(imageData) {
    let r = 0, g = 0, b = 0;
    const data = imageData.data;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    return {
      r: Math.round(r / pixels),
      g: Math.round(g / pixels),
      b: Math.round(b / pixels)
    };
  }

  calculateAllRatios() {
    const video = this.debugData.video;
    const viewport = this.debugData.viewport;
    const css = this.debugData.cssCrop;

    const ratios = {
      // Video vs Window Inner
      videoToInner: {
        x: video.width / viewport.innerWidth,
        y: video.height / viewport.innerHeight
      },
      // Video vs Window Outer
      videoToOuter: {
        x: video.width / viewport.outerWidth,
        y: video.height / viewport.outerHeight
      },
      // Video vs Screen
      videoToScreen: {
        x: video.width / viewport.screenWidth,
        y: video.height / viewport.screenHeight
      },
      // DPR
      dpr: viewport.devicePixelRatio,
      // Video vs DPR-adjusted Inner
      videoToDPRInner: {
        x: video.width / (viewport.innerWidth * viewport.devicePixelRatio),
        y: video.height / (viewport.innerHeight * viewport.devicePixelRatio)
      }
    };

    // CSS crop이 있으면 예상 비디오 좌표들 계산
    if (css) {
      ratios.predictedVideoCoords = {
        method1_1to1: {
          x: css.x,
          y: css.y,
          width: css.width,
          height: css.height
        },
        method2_dpr: {
          x: Math.round(css.x * viewport.devicePixelRatio),
          y: Math.round(css.y * viewport.devicePixelRatio),
          width: Math.round(css.width * viewport.devicePixelRatio),
          height: Math.round(css.height * viewport.devicePixelRatio)
        },
        method3_videoToInner: {
          x: Math.round(css.x * ratios.videoToInner.x),
          y: Math.round(css.y * ratios.videoToInner.y),
          width: Math.round(css.width * ratios.videoToInner.x),
          height: Math.round(css.height * ratios.videoToInner.y)
        },
        method4_uniformScale: {
          x: Math.round(css.x * ratios.videoToInner.x),
          y: Math.round(css.y * ratios.videoToInner.x), // X 비율로 통일
          width: Math.round(css.width * ratios.videoToInner.x),
          height: Math.round(css.height * ratios.videoToInner.x)
        }
      };
    }

    return ratios;
  }

  printDiagnostics() {
    console.log('\n📊 ========== DIAGNOSTIC REPORT ==========\n');

    console.log('🎥 VIDEO STREAM:');
    console.log('  Resolution:', this.debugData.video.width, 'x', this.debugData.video.height);
    console.log('');

    console.log('🖥️ VIEWPORT:');
    console.log('  Inner:', this.debugData.viewport.innerWidth, 'x', this.debugData.viewport.innerHeight);
    console.log('  Outer:', this.debugData.viewport.outerWidth, 'x', this.debugData.viewport.outerHeight);
    console.log('  Screen:', this.debugData.viewport.screenWidth, 'x', this.debugData.viewport.screenHeight);
    console.log('  DPR:', this.debugData.viewport.devicePixelRatio);
    console.log('');

    if (this.debugData.cssCrop) {
      console.log('📐 CSS CROP (User Selection):');
      console.log('  x:', this.debugData.cssCrop.x);
      console.log('  y:', this.debugData.cssCrop.y);
      console.log('  width:', this.debugData.cssCrop.width);
      console.log('  height:', this.debugData.cssCrop.height);
      console.log('');
    }

    console.log('🧮 CALCULATED RATIOS:');
    const ratios = this.debugData.calculations;
    console.log('  Video/Inner:', ratios.videoToInner.x.toFixed(4), 'x', ratios.videoToInner.y.toFixed(4));
    console.log('  Video/Outer:', ratios.videoToOuter.x.toFixed(4), 'x', ratios.videoToOuter.y.toFixed(4));
    console.log('  Video/Screen:', ratios.videoToScreen.x.toFixed(4), 'x', ratios.videoToScreen.y.toFixed(4));
    console.log('  DPR:', ratios.dpr);
    console.log('');

    if (ratios.predictedVideoCoords) {
      console.log('🎯 PREDICTED VIDEO COORDINATES:');
      console.log('');
      console.log('  Method 1 (1:1 mapping):');
      console.log('    x:', ratios.predictedVideoCoords.method1_1to1.x);
      console.log('    y:', ratios.predictedVideoCoords.method1_1to1.y);
      console.log('    width:', ratios.predictedVideoCoords.method1_1to1.width);
      console.log('    height:', ratios.predictedVideoCoords.method1_1to1.height);
      console.log('');
      console.log('  Method 2 (DPR applied):');
      console.log('    x:', ratios.predictedVideoCoords.method2_dpr.x);
      console.log('    y:', ratios.predictedVideoCoords.method2_dpr.y);
      console.log('    width:', ratios.predictedVideoCoords.method2_dpr.width);
      console.log('    height:', ratios.predictedVideoCoords.method2_dpr.height);
      console.log('');
      console.log('  Method 3 (Video/Inner ratio):');
      console.log('    x:', ratios.predictedVideoCoords.method3_videoToInner.x);
      console.log('    y:', ratios.predictedVideoCoords.method3_videoToInner.y);
      console.log('    width:', ratios.predictedVideoCoords.method3_videoToInner.width);
      console.log('    height:', ratios.predictedVideoCoords.method3_videoToInner.height);
      console.log('');
      console.log('  Method 4 (Uniform scale):');
      console.log('    x:', ratios.predictedVideoCoords.method4_uniformScale.x);
      console.log('    y:', ratios.predictedVideoCoords.method4_uniformScale.y);
      console.log('    width:', ratios.predictedVideoCoords.method4_uniformScale.width);
      console.log('    height:', ratios.predictedVideoCoords.method4_uniformScale.height);
      console.log('');
    }

    console.log('🔬 PIXEL ANALYSIS:');
    if (this.debugData.pixelAnalysis) {
      console.log('  Top region avg brightness:', this.debugData.pixelAnalysis.topRegion.averageBrightness);
      if (this.debugData.pixelAnalysis.cropEdges) {
        console.log('  Crop top edge brightness:', this.debugData.pixelAnalysis.cropEdges.top.brightness);
        console.log('  Crop top edge color:', this.debugData.pixelAnalysis.cropEdges.top.dominantColor);
      }
    }
    console.log('');

    console.log('📁 DOWNLOADED FILES:');
    console.log('  1. debug-01-full-video-*.png');
    console.log('  2. debug-02-css-coordinates-1to1.png (🔴 RED box)');
    console.log('  3. debug-03-dpr-coordinates.png (🔵 BLUE box)');
    console.log('  4. debug-04-viewport-ratio-coordinates.png (🟢 GREEN box)');
    console.log('  5. debug-05-all-methods-comparison.png (ALL boxes)');
    console.log('  6. debug-06-pixel-grid-for-measurement.png (for manual measurement)');
    console.log('  7. debug-diagnostics.json (all data)');
    console.log('');

    console.log('📋 NEXT STEPS:');
    console.log('  1. Open debug-05-all-methods-comparison.png');
    console.log('  2. Check which colored box matches your selection:');
    console.log('     🔴 RED = Method 1 (1:1)');
    console.log('     🔵 BLUE = Method 2 (DPR)');
    console.log('     🟢 GREEN = Method 3 (Viewport ratio)');
    console.log('  3. If none match, open debug-06-pixel-grid-for-measurement.png');
    console.log('  4. Measure exact coordinates using the grid');
    console.log('  5. Report back:');
    console.log('     - Which method is closest? (Red/Blue/Green/None)');
    console.log('     - If none, what are the exact coordinates?');
    console.log('');

    console.log('📊 ========== END OF REPORT ==========\n');
  }

  downloadImage(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  downloadDiagnosticsJSON() {
    const json = JSON.stringify(this.debugData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    this.downloadImage(blob, 'debug-diagnostics.json');
  }
}
