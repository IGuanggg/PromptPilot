import { IMAGE_API_TYPES } from '../constants.js';
import { buildHeaders, buildUrl, fetchJsonWithTimeout, mapResponse, parseTemplateBody, replaceTemplate, getByPath } from '../utils/customApi.js';
import { ERROR_CODES, createAppError } from '../utils/errors.js';
import { normalizeImageResult, normalizeOpenAIImageResult } from '../utils/imageResult.js';
import { mockImages } from '../utils/mockImages.js';
import { getOutputSize, mapSizeForOpenAIImages, getProviderSize } from '../utils/size.js';
import { createMultiAnglePrompts } from './anglePromptService.js';
import { appendLog } from './logService.js';
import { getImageModelConfig, toApiImageSize, detectAspectRatioFromImage, resolveAspectRatioForNano, validateNanoBananaPayload, getSafeResolutionForModel, modelSupportsResolution } from '../data/imageModels.js';
import { extractTaskId, pollImageResult, normalizeImageTaskFailure } from './imageTaskService.js';

export async function generateImages({
  prompt,
  negativePrompt = '',
  referenceImage = '',
  mode = 'standard',
  count = 4,
  width = 1080,
  height = 1080,
  size = `${width}x${height}`,
  dashscopeSize = `${width}*${height}`,
  outputSize = null,
  settings = {}
}) {
  const api = settings?.imageApi || {};
  const type = api.type || IMAGE_API_TYPES.OPENAI_COMPATIBLE;
  const finalOutputSize = outputSize ? {
    ...outputSize,
    dashscopeSize: outputSize.dashscopeSize || `${outputSize.width}*${outputSize.height}`
  } : getOutputSize({
    sizeMode: api.sizeMode,
    aspectRatio: api.aspectRatio,
    resolutionPreset: api.resolutionPreset,
    customWidth: api.customWidth,
    customHeight: api.customHeight,
    referenceImage
  });
  const adapterInput = {
    prompt,
    negativePrompt,
    referenceImage,
    mode,
    count,
    width: finalOutputSize.width,
    height: finalOutputSize.height,
    size: finalOutputSize.size,
    dashscopeSize: finalOutputSize.dashscopeSize,
    outputSize: finalOutputSize,
    settings
  };

  appendLog({
    level: 'info',
    apiType: 'image',
    event: 'IMAGE_GENERATE_START',
    provider: type,
    message: `Image generate start: ${count} images, ${finalOutputSize.size}`,
    data: {
      mode,
      count,
      width: finalOutputSize.width,
      height: finalOutputSize.height,
      requestedSize: finalOutputSize.size,
      dashscopeSize: finalOutputSize.dashscopeSize,
      sizeMode: finalOutputSize.sizeMode,
      aspectRatio: finalOutputSize.aspectRatio,
      resolutionPreset: finalOutputSize.resolutionPreset,
      hasReference: !!referenceImage
    }
  });

  try {
    let result;
    if (type === IMAGE_API_TYPES.CUSTOM) {
      result = await callCustomImage({ api, ...adapterInput });
    } else {
      result = await callOpenAICompatibleImage({ api, ...adapterInput });
    }

    const images = result.images || [];
    appendLog({
      level: 'info',
      apiType: 'image',
      event: 'IMAGE_GENERATE_SUCCESS',
      provider: type,
      message: `生成完成: ${images.length} 张图片`,
      data: {
        imagesCount: images.length,
        requestedSize: finalOutputSize.size,
        resultSizes: images.map((image) => ({
          id: image.id,
          width: image.width || 0,
          height: image.height || 0,
          resultSize: image.width && image.height ? `${image.width}x${image.height}` : ''
        }))
      }
    });

    return { images };
  } catch (error) {
    appendLog({
      level: 'error',
      apiType: 'image',
      event: 'IMAGE_GENERATE_ERROR',
      provider: type,
      message: `生成失败: ${error?.message || '未知错误'}`,
      data: {
        code: error?.code || '',
        status: error?.status || 0,
        provider: error?.provider || type,
        rawStatus: error?.raw?.status || '',
        rawError: error?.raw?.error || error?.raw?.failure_reason || ''
      }
    });
    throw error;
  }
}

export async function generateMultiAngleImages({
  prompt = '',
  promptZh = '',
  promptEn = '',
  negativePrompt = '',
  referenceImage = '',
  extraPrompt = '',
  settings = {},
  outputSize = null
}) {
  const api = settings?.imageApi || {};
  const provider = api.type || IMAGE_API_TYPES.OPENAI_COMPATIBLE;
  const finalOutputSize = outputSize || getOutputSize({
    sizeMode: api.sizeMode,
    aspectRatio: api.aspectRatio,
    resolutionPreset: api.resolutionPreset,
    customWidth: api.customWidth,
    customHeight: api.customHeight,
    referenceImage
  });

  appendLog({
    level: 'info',
    apiType: 'image',
    event: 'MULTI_ANGLE_GENERATE_START',
    provider,
    message: `Multi-angle generation start: ${finalOutputSize.size}`,
    data: {
      requestedSize: finalOutputSize.size,
      width: finalOutputSize.width,
      height: finalOutputSize.height,
      aspectRatio: finalOutputSize.aspectRatio,
      resolutionPreset: finalOutputSize.resolutionPreset
    }
  });

  const anglePrompts = createMultiAnglePrompts({
    basePrompt: prompt,
    promptZh,
    promptEn,
    referenceImage,
    extraPrompt
  });

  appendLog({
    level: 'info',
    apiType: 'image',
    event: 'MULTI_ANGLE_PROMPT_CREATED',
    provider,
    message: 'Created multi-angle prompts',
    data: {
      count: anglePrompts.length,
      angles: anglePrompts.map((item) => item.key)
    }
  });

  const images = [];
  const raw = {};

  for (const angle of anglePrompts) {
    const anglePrompt = angle.anglePromptEn || angle.anglePromptZh;
    appendLog({
      level: 'info',
      apiType: 'image',
      event: 'MULTI_ANGLE_IMAGE_START',
      provider,
      message: `Generating ${angle.label}`,
      data: {
        angleKey: angle.key,
        label: angle.label,
        promptPreview: anglePrompt.slice(0, 240),
        requestedSize: finalOutputSize.size,
        provider
      }
    });

    try {
      const result = await generateImages({
        prompt: anglePrompt,
        negativePrompt,
        referenceImage,
        mode: 'multi-angle',
        count: 1,
        width: finalOutputSize.width,
        height: finalOutputSize.height,
        size: finalOutputSize.size,
        dashscopeSize: finalOutputSize.dashscopeSize,
        outputSize: finalOutputSize,
        settings
      });
      const image = (result.images || [])[0];
      if (!image) throw new Error(`${angle.label} 未返回图片`);

      images.push({
        ...image,
        label: angle.label,
        angleKey: angle.key,
        prompt: anglePrompt
      });
      raw[angle.key] = result.raw || null;

      appendLog({
        level: 'info',
        apiType: 'image',
        event: 'MULTI_ANGLE_IMAGE_SUCCESS',
        provider,
        message: `${angle.label} generated`,
        data: {
          angleKey: angle.key,
          label: angle.label,
          requestedSize: finalOutputSize.size,
          provider
        }
      });
    } catch (error) {
      const failed = createFailedAngleResult(angle, anglePrompt, provider, finalOutputSize, error);
      images.push(failed);
      raw[angle.key] = serializeAngleError(error);

      appendLog({
        level: 'error',
        success: false,
        apiType: 'image',
        event: 'MULTI_ANGLE_IMAGE_ERROR',
        provider,
        message: `${angle.label} failed: ${error?.message || 'unknown error'}`,
        data: {
          angleKey: angle.key,
          label: angle.label,
          promptPreview: anglePrompt.slice(0, 240),
          requestedSize: finalOutputSize.size,
          provider
        }
      });
    }
  }

  const failedCount = images.filter((image) => image.failed).length;
  const successCount = images.length - failedCount;
  appendLog({
    level: failedCount ? 'warn' : 'info',
    success: failedCount === 0,
    apiType: 'image',
    event: failedCount ? 'MULTI_ANGLE_GENERATE_ERROR' : 'MULTI_ANGLE_GENERATE_SUCCESS',
    provider,
    message: failedCount ? `Multi-angle completed with ${failedCount} failed` : 'Multi-angle generation completed',
    data: {
      requestedSize: finalOutputSize.size,
      successCount,
      failedCount,
      angles: images.map((image) => ({ angleKey: image.angleKey, label: image.label, failed: !!image.failed }))
    }
  });

  if (successCount === 0) {
    const hint = createMultiAngleFailureHint({ api, outputSize: finalOutputSize });
    throw createAppError({
      code: ERROR_CODES.TASK_FAILED,
      message: hint ? `多角度生成全部失败。${hint}` : '多角度生成全部失败',
      provider,
      raw: {
        requestedSize: finalOutputSize.size,
        providerSize: getProviderSize({
          requestedSize: finalOutputSize.size,
          dashscopeSize: finalOutputSize.dashscopeSize,
          sizeFormat: api.sizeFormat || 'x'
        }),
        sizeFormat: api.sizeFormat || 'x',
        hint,
        failedCount,
        angles: images.map((image) => ({
          angleKey: image.angleKey,
          label: image.label,
          errorMessage: image.errorMessage || ''
        })),
        responses: raw
      },
      retryable: false
    });
  }

  return {
    images,
    provider,
    mode: 'multi-angle',
    raw
  };
}

// ── Provider implementations ──

async function callOpenAICompatibleImage({ api, prompt, count, width, height, size, dashscopeSize, outputSize }) {
  if (!api.baseUrl || !api.apiKey || !api.model) {
    return mockImages('openai-compatible-image-mock', count || 4, width, height);
  }

  const requestedSize = size || outputSize?.size || `${width}x${height}`;
  const sizeFormat = api.sizeFormat || 'x';
  const providerSize = getProviderSize({ requestedSize, dashscopeSize, sizeFormat });
  if (sizeFormat === 'openai-mapped' && providerSize !== requestedSize) {
    appendLog({
      level: 'info',
      apiType: 'image',
      event: 'IMAGE_SIZE_MAPPED',
      provider: 'openai-compatible-image',
      message: `Image size mapped: ${requestedSize} -> ${providerSize}`,
      data: {
        requestedSize,
        providerSize,
        provider: 'openai-compatible-image',
        reason: 'Provider only supports fixed image sizes'
      }
    });
  }
  appendLog({
    level: 'info',
    apiType: 'image',
    event: 'IMAGE_PAYLOAD_SIZE',
    provider: 'openai-compatible-image',
    message: `Image payload size: ${providerSize}`,
    data: { requestedSize, providerSize, width, height, sizeFormat, provider: 'openai-compatible-image' }
  });
  const url = buildUrl(api.baseUrl, api.endpoint || '/v1/images/generations');
  const body = JSON.stringify({
    model: api.model,
    prompt,
    n: count,
    size: providerSize,
    response_format: api.responseFormat || 'url'
  });

  const raw = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
    body
  }, 60000, { apiType: 'image', provider: 'openai-compatible-image' });

  return normalizeOpenAIImageResult(raw, 'openai-compatible-image', { width, height });
}

// ── Draw API: channel-aware submit + async poll ──

async function callDrawApi({ api, prompt, referenceImage, width, height, dashscopeSize, outputSize, modelConfig, settings }) {
  const baseUrl = (api.baseUrl || '').replace(/\/+$/, '');
  const submitUrl = `${baseUrl}${modelConfig.submitEndpoint}`;
  const resultEp = api.resultEndpoint || modelConfig.resultEndpoint || '/v1/draw/result';
  const channel = modelConfig.channel;
  const resolutionPreset = outputSize?.resolutionPreset || api.resolutionPreset || '1k';

  // Resolve reference image URLs
  const refUrl = typeof referenceImage === 'string' ? referenceImage :
    (referenceImage?.dataUrl || referenceImage?.displayUrl || referenceImage?.url || '');
  const urls = refUrl ? [refUrl] : [];

  // Build payload per official API doc
  let payload;
  if (channel === 'nano-banana') {
    // Nano Banana: aspectRatio + imageSize (no size field)
    const imageSize = toApiImageSize(resolutionPreset);
    // Use outputSize (from getOutputSize) as primary aspect ratio source, with Nano-aware fallback
    const resolvedAspectRatio = resolveAspectRatioForNano({ settings: settings || {}, currentImage: referenceImage, outputSize });
    const finalAspectRatio = resolvedAspectRatio || outputSize?.aspectRatio || api.aspectRatio || 'auto';

    // Capability check: ensure resolution is within model's supported range
    const safeRes = getSafeResolutionForModel(api.model, resolutionPreset);
    if (safeRes !== resolutionPreset) {
      appendLog({ level: 'warn', apiType: 'image', event: 'IMAGE_MODEL_CAPABILITY_ADJUSTED', provider: 'draw-api', message: `Resolution adjusted for ${api.model}`, data: { model: api.model, fromResolution: resolutionPreset, toResolution: safeRes, reason: `model only supports: ${(getImageModelConfig(api.model)?.supportsResolutions || []).join(', ')}` } });
    }
    const finalImageSize = toApiImageSize(safeRes);

    payload = {
      model: api.model, prompt,
      aspectRatio: finalAspectRatio,
      imageSize: finalImageSize,
      urls, webHook: '-1', shutProgress: false
    };

    // Pre-submit validation
    validateNanoBananaPayload(payload);

    appendLog({ level: 'info', apiType: 'image', event: 'IMAGE_REQUEST_BUILD', provider: 'draw-api', message: `Nano Banana request: ${finalAspectRatio} ${finalImageSize}`,
      data: { model: api.model, channel, endpoint: submitUrl, sizeMode: api.sizeMode, sourceImageWidth: referenceImage?.width || 0, sourceImageHeight: referenceImage?.height || 0, detectedAspectRatio: finalAspectRatio, aspectRatio: finalAspectRatio, resolutionPreset, imageSize: finalImageSize, urlsCount: urls.length, webHook: '-1' } });
  } else {
    // Image channel: aspectRatio + quality (no size, no imageSize)
    const aspectRatio = outputSize?.sizeMode === 'custom' ? `${width}x${height}` :
      (outputSize?.aspectRatio || api.aspectRatio || '1:1');

    payload = {
      model: api.model, prompt,
      aspectRatio,
      quality: 'auto',
      urls, webHook: '-1', shutProgress: false
    };

    appendLog({ level: 'info', apiType: 'image', event: 'IMAGE_REQUEST_BUILD', provider: 'draw-api', message: `Image request: ${aspectRatio}`,
      data: { model: api.model, channel, endpoint: submitUrl, aspectRatio, quality: 'auto', urlsCount: urls.length, webHook: '-1' } });
  }

  // Validate single-model consistency
  const selectedModel = api.model;
  if (payload.model !== selectedModel) {
    throw createAppError({
      code: ERROR_CODES.MODEL_MISMATCH,
      message: `模型不一致：选择的是 ${selectedModel}，实际请求是 ${payload.model}`,
      provider: 'draw-api',
      raw: { selectedModel, payloadModel: payload.model },
      retryable: false
    });
  }

  // Model-endpoint validation: if user overrides endpoint, verify it matches the model's expected endpoint
  if (api.customEndpointOverride && api.endpoint && api.endpoint !== modelConfig.submitEndpoint) {
    appendLog({ level: 'warn', apiType: 'image', event: 'MODEL_ENDPOINT_MISMATCH', provider: 'draw-api', message: `Endpoint mismatch`, data: { model: api.model, channel, endpoint: api.endpoint, expectedEndpoint: modelConfig.submitEndpoint } });
    throw createAppError({
      code: ERROR_CODES.MODEL_MISMATCH,
      message: `当前模型 ${api.model} 与接口 ${api.endpoint} 不匹配。预期接口：${modelConfig.submitEndpoint}。请关闭自定义 Endpoint 或切换正确模型。`,
      provider: 'draw-api', raw: { model: api.model, endpoint: api.endpoint, expectedEndpoint: modelConfig.submitEndpoint }, retryable: false
    });
  }

  appendLog({ level: 'info', apiType: 'image', event: 'IMAGE_MODEL_ROUTE', provider: 'draw-api', message: `Route: ${channel}`, data: { selectedModel, channel, endpoint: submitUrl, resultEndpoint: resultEp, customEndpointOverride: api.customEndpointOverride || false } });
  appendLog({ level: 'info', apiType: 'image', event: 'IMAGE_PAYLOAD_BUILT', provider: 'draw-api', message: `Payload: ${channel}`, data: { channel, ...payload } });

  // Submit
  const submitTimeout = 60000;
  const headers = { 'Content-Type': 'application/json' };
  if (api.apiKey) headers.Authorization = `Bearer ${api.apiKey}`;

  const submitRaw = await fetchJsonWithTimeout(submitUrl, {
    method: 'POST', headers, body: JSON.stringify(payload)
  }, submitTimeout, { apiType: 'image', provider: 'draw-api' });

  const taskId = extractTaskId(submitRaw);
  if (!taskId) {
    // Fallback: parse direct result (might have inline images)
    return normalizeImageResult(submitRaw, 'draw-api', { width, height, requireImages: true });
  }

  appendLog({ level: 'info', apiType: 'image', event: 'IMAGE_TASK_SUBMITTED', provider: 'draw-api', message: `Task: ${taskId}`, data: { taskId, model: api.model, channel } });

  // Poll
  const pollResult = await pollImageResult({
    taskId, baseUrl, resultEndpoint: resultEp,
    apiKey: api.apiKey,
    pollIntervalMs: api.pollIntervalMs || 3000,
    maxPollCount: api.maxPollCount || 240,
    provider: 'draw-api'
  });

  return { images: pollResult.images || [], provider: 'draw-api', raw: pollResult.raw || {} };
}

async function callCustomImage({ api, prompt, negativePrompt, referenceImage, mode, count, width, height, size, dashscopeSize, outputSize, settings }) {
  const custom = api.custom || {};

  // ── Channel-aware routing for known models ──
  const modelConfig = getImageModelConfig(api.model);
  if (modelConfig && modelConfig.channel) {
    return callDrawApi({ api, prompt, referenceImage, width, height, dashscopeSize, outputSize, modelConfig, settings });
  }

  // ── Legacy custom API flow ──
  if (!api.baseUrl || !api.endpoint) {
    return mockImages('custom-image-mock', count || 4, width, height);
  }

  const requestedSize = size || outputSize?.size || `${width}x${height}`;
  const finalDashscopeSize = dashscopeSize || outputSize?.dashscopeSize || `${width}*${height}`;
  const sizeFormat = api.sizeFormat || 'x';
  const providerSize = getProviderSize({ requestedSize, dashscopeSize: finalDashscopeSize, sizeFormat });
  appendLog({
    level: 'info',
    apiType: 'image',
    event: 'IMAGE_PAYLOAD_SIZE',
    provider: 'custom-image',
    message: `Custom image payload size: ${providerSize}`,
    data: { requestedSize, providerSize, width, height, sizeFormat, provider: 'custom-image' }
  });
  const variables = {
    ...custom,
    model: api.model || '',
    prompt,
    negativePrompt,
    referenceImage,
    width,
    height,
    size: requestedSize,
    dashscopeSize: finalDashscopeSize,
    providerSize,
    aspectRatio: outputSize?.aspectRatio || api.aspectRatio || '',
    resolutionPreset: outputSize?.resolutionPreset || api.resolutionPreset || '',
    sizeMode: outputSize?.sizeMode || api.sizeMode || '',
    count,
    mode
  };

  const generateUrl = buildUrl(api.baseUrl, api.endpoint, variables);
  const method = custom.method || 'POST';

  const raw = await fetchJsonWithTimeout(generateUrl, {
    method,
    headers: buildHeaders({ ...custom, apiKey: api.apiKey }),
    body: method.toUpperCase() === 'GET' ? undefined : parseTemplateBody(custom.requestTemplate || '', variables)
  }, 60000, { apiType: 'image', provider: 'custom-image' });

  // Handle async polling
  const finalRaw = custom.requestMode === 'async'
    ? await pollCustomImage(raw, api, custom, variables)
    : raw;

  return normalizeImageResult(finalRaw, 'custom-image', {
    width,
    height,
    responseMap: custom.responseMap || {},
    requireImages: true
  });
}

async function pollCustomImage(initialRaw, api, custom, variables) {
  const responseMap = custom.responseMap || {};
  const taskId = getByPath(initialRaw, responseMap.taskId || 'id');
  const statusPath = custom.statusEndpoint;
  if (!taskId || !statusPath) return initialRaw;

  const maxPolls = 60;
  const interval = 1500;
  for (let i = 0; i < maxPolls; i++) {
    await wait(interval);
    const statusEndpoint = replaceTemplate(statusPath, { ...variables, id: taskId, taskId });
    const statusUrl = buildUrl(api.baseUrl, statusEndpoint, { ...variables, id: taskId, taskId });
    const raw = await fetchJsonWithTimeout(statusUrl, {
      method: 'GET',
      headers: buildHeaders({ ...custom, apiKey: api.apiKey })
    }, 60000, { apiType: 'image', provider: 'custom-image' });
    const status = String(getByPath(raw, responseMap.status || 'status') || '').toLowerCase();
    if (['succeeded', 'success', 'completed', 'done', 'finished'].includes(status)) return raw;
    if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) {
      const failureReason = getByPath(raw, responseMap.failureReason || 'failure_reason') || raw?.failure_reason || '';
      const errorMsg = getByPath(raw, responseMap.error || 'error') || raw?.error || '';
      throw normalizeImageTaskFailure({ failure_reason: failureReason, error: errorMsg, status }, 'custom-image');
    }
  }

  throw createAppError({
    code: ERROR_CODES.TIMEOUT,
    message: 'Image task polling timeout',
    provider: 'custom-image',
    retryable: true
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFailedAngleResult(angle, prompt, provider, outputSize, error) {
  return {
    id: `failed_${angle.key}_${Date.now()}`,
    url: '',
    thumbUrl: '',
    label: angle.label,
    angleKey: angle.key,
    provider,
    width: outputSize.width,
    height: outputSize.height,
    prompt,
    failed: true,
    errorMessage: error?.message || '该角度生成失败'
  };
}

function serializeAngleError(error) {
  return {
    error: error?.message || 'unknown error',
    code: error?.code || '',
    status: Number(error?.status || 0),
    rawStatus: error?.raw?.status || error?.raw?.data?.status || '',
    rawError: error?.raw?.error || error?.raw?.failure_reason || error?.raw?.message || error?.raw?.data?.error || error?.raw?.data?.failure_reason || ''
  };
}

function createMultiAngleFailureHint({ api, outputSize }) {
  const sizeFormat = api.sizeFormat || 'x';
  if (api.type !== IMAGE_API_TYPES.CUSTOM && sizeFormat !== 'openai-mapped') {
    const mapped = mapSizeForOpenAIImages(outputSize.size);
    if (mapped !== outputSize.size) {
      return `当前请求尺寸为 ${outputSize.size}，OpenAI 兼容接口通常不支持该尺寸；请在设置中把 Image API 的 Size Format 改为 OpenAI mapped，或改用 1K/1:1 后重试。`;
    }
  }
  if (sizeFormat === 'openai-mapped' && ['2k', '4k'].includes(outputSize.resolutionPreset)) {
    return '当前为高清多角度连续生成，请尝试切换到 1K 或确认模型支持当前比例的图像生成。';
  }
  return '';
}
