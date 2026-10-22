const OUTPUT_HEIGHTS = new Set(['source', '1080', '720', '480']);

export function normalizeOutputResolution(value) {
  const normalized = String(value);
  return OUTPUT_HEIGHTS.has(normalized) ? normalized : 'source';
}

export function calculateOutputDimensions(source, limits = {}) {
  const { maxHeight = 'source', maxWidth = null } = limits;
  const heightLimit = maxHeight === 'source' ? Infinity : Number(maxHeight);
  const widthLimit = maxWidth === null ? Infinity : Number(maxWidth);
  const scale = Math.min(1, heightLimit / source.height, widthLimit / source.width);

  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale))
  };
}
