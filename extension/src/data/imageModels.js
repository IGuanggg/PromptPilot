export const IMAGE_MODEL_CHANNELS = { IMAGE: 'image', NANO_BANANA: 'nano-banana' };

const IMAGE_MODELS = [
  {
    id: 'gpt-image-2-vip', name: 'gpt-image-2-vip', displayName: 'gpt-image-2-vip',
    channel: 'image', channelLabel: 'GPT Image API',
    submitEndpoint: '/v1/draw/completions', resultEndpoint: '/v1/draw/result',
    creditCost: 900,
    supportsTextToImage: true, supportsImageToImage: true,
    supportsReferenceImage: true, supportsMultiAngle: true,
    supportsResolutions: ['1k', '2k', '4k'], supportsApiSizes: ['1K', '2K', '4K'],
    maxResolution: '4K', maxSizeLabel: '最高 4K',
    badges: ['文生图', '图生图', '1K', '2K', '4K'],
    description: '高质量 GPT Image 模型，适合精细出图和高质量作品。',
    supportsAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    payloadType: 'aspectRatio'
  },
  {
    id: 'gpt-image-2', name: 'gpt-image-2', displayName: 'gpt-image-2',
    channel: 'image', channelLabel: 'GPT Image API',
    submitEndpoint: '/v1/draw/completions', resultEndpoint: '/v1/draw/result',
    creditCost: 600,
    supportsTextToImage: true, supportsImageToImage: true,
    supportsReferenceImage: true, supportsMultiAngle: true,
    supportsResolutions: ['1k'], supportsApiSizes: ['1K'],
    maxResolution: '1K', maxSizeLabel: '最高 1K',
    badges: ['文生图', '图生图', '1K'],
    description: '通用 GPT Image 模型，适合日常生成和快速预览。',
    supportsAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    payloadType: 'aspectRatio'
  },
  {
    id: 'nano-banana-pro', name: 'nano-banana-pro', displayName: 'nano-banana-pro',
    channel: 'nano-banana', channelLabel: 'Nano Banana API',
    submitEndpoint: '/v1/draw/nano-banana', resultEndpoint: '/v1/draw/result',
    creditCost: 1800,
    supportsTextToImage: true, supportsImageToImage: true,
    supportsReferenceImage: true, supportsMultiAngle: true,
    supportsResolutions: ['1k', '2k', '4k'], supportsApiSizes: ['1K', '2K', '4K'],
    maxResolution: '4K', maxSizeLabel: '最高 4K',
    badges: ['文生图', '图生图', '1K', '2K', '4K'],
    description: '高质量 Nano Banana 模型，适合细节更丰富的作品输出。',
    supportsAspectRatios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9'],
    payloadType: 'imageSize'
  },
  {
    id: 'nano-banana-2', name: 'nano-banana-2', displayName: 'nano-banana-2',
    channel: 'nano-banana', channelLabel: 'Nano Banana API',
    submitEndpoint: '/v1/draw/nano-banana', resultEndpoint: '/v1/draw/result',
    creditCost: 1200,
    supportsTextToImage: true, supportsImageToImage: true,
    supportsReferenceImage: true, supportsMultiAngle: true,
    supportsResolutions: ['1k', '2k', '4k'], supportsApiSizes: ['1K', '2K', '4K'],
    maxResolution: '4K', maxSizeLabel: '最高 4K',
    badges: ['文生图', '图生图', '1K', '2K', '4K'],
    description: '综合型 Nano Banana 模型，适合图生图、文生图和多角度生成。',
    supportsAspectRatios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9', '1:4', '4:1', '1:8', '8:1'],
    payloadType: 'imageSize'
  },
  {
    id: 'nano-banana-fast', name: 'nano-banana-fast', displayName: 'nano-banana-fast',
    channel: 'nano-banana', channelLabel: 'Nano Banana API',
    submitEndpoint: '/v1/draw/nano-banana', resultEndpoint: '/v1/draw/result',
    creditCost: 440,
    supportsTextToImage: true, supportsImageToImage: true,
    supportsReferenceImage: true, supportsMultiAngle: false,
    supportsResolutions: ['1k'], supportsApiSizes: ['1K'],
    maxResolution: '1K', maxSizeLabel: '最高 1K',
    badges: ['文生图', '图生图', '1K', '快速'],
    description: '快速低成本模型，适合草图预览和快速测试。',
    supportsAspectRatios: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9'],
    payloadType: 'imageSize'
  }
];

// ── Model lookup ──

export function getImageModels() { return IMAGE_MODELS; }

export function getImageModelConfig(modelName) {
  return IMAGE_MODELS.find(m => m.id === modelName || m.name === modelName) || IMAGE_MODELS[1];
}

export function getSubmitEndpointForModel(modelName) {
  const m = getImageModelConfig(modelName);
  return m?.submitEndpoint || '/v1/draw/completions';
}

export function getResultEndpointForModel(modelName) {
  const m = getImageModelConfig(modelName);
  return m?.resultEndpoint || '/v1/draw/result';
}

// ── Capability queries ──

export function getSupportedResolutions(modelName) {
  const m = getImageModelConfig(modelName);
  return m?.supportsResolutions || ['1k'];
}

export function getSupportedApiSizes(modelName) {
  const m = getImageModelConfig(modelName);
  return m?.supportsApiSizes || ['1K'];
}

export function getModelMaxResolution(modelName) {
  const m = getImageModelConfig(modelName);
  return m?.maxResolution || '1K';
}

export function modelSupportsResolution(modelName, resolution) {
  const supported = getSupportedResolutions(modelName);
  // Normalize: resolution can be '1k' or '1K'
  const norm = String(resolution).toLowerCase();
  return supported.some(s => s.toLowerCase() === norm);
}

export function getSafeResolutionForModel(modelName, resolutionPreset) {
  const supported = getSupportedResolutions(modelName);
  const norm = String(resolutionPreset || '1k').toLowerCase();
  if (supported.some(s => s.toLowerCase() === norm)) return resolutionPreset || '1k';
  return supported[0] || '1k';
}

// ── Aspect ratio ──

export function detectAspectRatioFromImage(image) {
  const w = Number(image?.width || image?.naturalWidth || image?.originalWidth || 0);
  const h = Number(image?.height || image?.naturalHeight || image?.originalHeight || 0);
  if (!w || !h) return 'auto';
  const r = w / h;
  const candidates = [
    { value: '1:1', ratio: 1 }, { value: '16:9', ratio: 16 / 9 }, { value: '9:16', ratio: 9 / 16 },
    { value: '4:3', ratio: 4 / 3 }, { value: '3:4', ratio: 3 / 4 },
    { value: '3:2', ratio: 3 / 2 }, { value: '2:3', ratio: 2 / 3 },
    { value: '5:4', ratio: 5 / 4 }, { value: '4:5', ratio: 4 / 5 }, { value: '21:9', ratio: 21 / 9 }
  ];
  return candidates.reduce((best, item) => Math.abs(item.ratio - r) < Math.abs(best.ratio - r) ? item : best, candidates[0]).value;
}

export function resolveAspectRatioForNano({ settings, currentImage, outputSize }) {
  const api = settings?.imageApi || {};
  const sizeMode = api.sizeMode || 'preset';
  const sizeOutputAspect = outputSize?.aspectRatio;
  if (sizeOutputAspect && sizeOutputAspect !== 'custom' && sizeOutputAspect !== '') return sizeOutputAspect;
  if (sizeMode === 'follow-reference' || sizeMode === 'auto') {
    if (currentImage && typeof currentImage === 'object') {
      const detected = detectAspectRatioFromImage(currentImage);
      if (detected && detected !== 'auto') return detected;
    }
    return 'auto';
  }
  const selected = api.aspectRatio;
  if (selected && selected !== '' && selected !== 'custom') return selected;
  return 'auto';
}

// ── Size conversion ──

export function toApiImageSize(resolutionPreset) {
  return ({ '1k': '1K', '2k': '2K', '4k': '4K', '1K': '1K', '2K': '2K', '4K': '4K' })[resolutionPreset] || '1K';
}

// ── Validation ──

export function validateNanoBananaPayload(body) {
  const errors = [];
  if (!body.model) errors.push('model 为空');
  if (!body.prompt) errors.push('prompt 为空');
  if (!body.aspectRatio) errors.push('aspectRatio 为空');
  if (!body.imageSize) errors.push('imageSize 为空');
  if (body.webHook !== '-1') errors.push('webHook 必须是 -1');
  if (!Array.isArray(body.urls)) errors.push('urls 必须是数组');
  if ('size' in body) errors.push('Nano Banana 不允许传 size');
  if (errors.length) {
    const error = new Error('Nano Banana 请求参数不完整：' + errors.join('，'));
    error.code = 'INVALID_NANO_BANANA_PAYLOAD';
    error.details = { errors, body };
    throw error;
  }
}

export function sanitizePromptForImageGeneration(prompt) {
  if (!prompt) return '';
  let text = String(prompt);
  text = text.replace(/\bin the style of\s+[\w\s-]+/gi, '');
  text = text.replace(/\b(exact copy|replica|identical to|same as|仿|一模一样|完全复刻|同款)\s+[\w\s-]*/gi, '');
  text = text.replace(/[©®™]/g, '');
  text = text.replace(/\s{2,}/g, ' ').trim();
  return text || prompt;
}
