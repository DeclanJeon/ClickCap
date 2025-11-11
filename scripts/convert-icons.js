#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// SVG to Canvas conversion using simple text replacement
// This is a basic converter - for production you'd want to use a proper SVG library

function svgToPng(svgContent, outputPath) {
  // Create a simple canvas-based converter
  const { createCanvas } = require('canvas');

  // Extract size from SVG
  const widthMatch = svgContent.match(/width="(\d+)"/);
  const heightMatch = svgContent.match(/height="(\d+)"/);

  const width = widthMatch ? parseInt(widthMatch[1]) : 128;
  const height = heightMatch ? parseInt(heightMatch[1]) : 128;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Simple background (white)
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);

  // Extract colors and draw simple representation
  const isRecording = svgContent.includes('recording');
  const isNotRecording = svgContent.includes('not-recording');

  if (isRecording) {
    // Red circle for recording
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(width/2, height/2, Math.min(width, height) * 0.3, 0, 2 * Math.PI);
    ctx.fill();
  } else if (isNotRecording) {
    // Green circle for not recording
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(width/2, height/2, Math.min(width, height) * 0.3, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Save as PNG
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);

  console.log(`Created ${outputPath} (${width}x${height})`);
}

// Main conversion
const iconsDir = path.join(__dirname, '../icons');

// Convert recording.svg to recording.png
const recordingSvg = fs.readFileSync(path.join(iconsDir, 'recording.svg'), 'utf8');
svgToPng(recordingSvg, path.join(iconsDir, 'recording.png'));

// Convert not-recording.svg to not-recording.png
const notRecordingSvg = fs.readFileSync(path.join(iconsDir, 'not-recording.svg'), 'utf8');
svgToPng(notRecordingSvg, path.join(iconsDir, 'not-recording.png'));

console.log('Icon conversion completed!');