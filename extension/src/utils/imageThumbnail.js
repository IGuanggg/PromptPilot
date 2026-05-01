import { appendLog } from '../services/logService.js';

/**
 * Create a thumbnail blob from an image source.
 * @param {Blob|string} source - Blob or data URL
 * @param {object} opts - { maxWidth, maxHeight, type, quality }
 * @returns {Promise<Blob|null>}
 */
export async function createThumbnailBlob(source, opts = {}) {
  const { maxWidth = 256, maxHeight = 256, type = 'image/webp', quality = 0.75 } = opts;

  try {
    const img = await loadImage(source);
    if (!img || !img.naturalWidth) return null;

    const { width, height } = computeThumbSize(img.naturalWidth, img.naturalHeight, maxWidth, maxHeight);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), type, quality);
    });

    appendLog({ level: 'info', apiType: 'system', event: 'THUMBNAIL_CREATED', provider: 'canvas', message: `Thumbnail: ${width}x${height}`, data: { width, height, sizeBytes: blob?.size || 0 } });

    return blob;
  } catch (error) {
    appendLog({ level: 'warn', apiType: 'system', event: 'THUMBNAIL_FAILED', provider: 'canvas', message: error.message });
    return null;
  }
}

function loadImage(source) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    if (source instanceof Blob) {
      img.src = URL.createObjectURL(source);
    } else {
      img.src = String(source);
    }
  });
}

function computeThumbSize(naturalW, naturalH, maxW, maxH) {
  const ratio = Math.min(maxW / naturalW, maxH / naturalH, 1);
  return {
    width: Math.round(naturalW * ratio),
    height: Math.round(naturalH * ratio)
  };
}
