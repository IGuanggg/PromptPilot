import { loadSettings } from '../services/storageService.js';
import { checkPromptApiStatus, checkImageApiStatus } from '../adapters/status/healthCheck.js';
import { generatePromptFromImage, enhancePrompt } from '../services/promptService.js';
import { generateImages, generateMultiAngleImages } from '../services/imageService.js';
import { downloadImage, downloadAllImages } from '../services/downloadService.js';
import { clearDraft, restoreDraft, saveDraft } from '../services/draftService.js';
import { clearHistory, createHistoryExportFilename, createHistoryItemFromState, deleteHistoryItem, exportHistory, getHistory, importHistory, saveHistoryItem } from '../services/historyService.js';
import { getLogs, clearLogs, getLastCall, initLogService, setLogSettings, setLogLimit, appendLog } from '../services/logService.js';
import { getOutputSize, migrateResolutionPreset, migrateSizeMode } from '../utils/size.js';
import { statusText } from '../utils/format.js';
import { ERROR_CODES, getErrorMessage, normalizeError, sanitizeErrorLog } from '../utils/errors.js';
import { formatDateTime } from '../utils/date.js';
import { ALLOWED_IMAGE_TYPES } from '../utils/fileSize.js';
import { normalizeImageInput, handleLocalFile, handleDropFile, handlePasteEvent } from '../services/imageInputService.js';
import { saveImageBlob, getImageBlob, createObjectUrlFromBlobId } from '../storage/imageBlobStore.js';
import { createThumbnailBlob } from '../utils/imageThumbnail.js';

const state = {
  currentImage: null,
  apiStatus: {
    prompt: { status: 'unconfigured', message: 'Prompt API 未配置' },
    image: { status: 'unconfigured', message: 'Image API 未配置' }
  },
  prompts: createEmptyPrompts(),
  results: [],
  generateSettings: {},
  lastError: null,
  lastGenerateMode: 'standard',
  settings: null,
  taskStatus: { phase: 'waiting-image', message: '等待右键发送图片' },
  historyItems: [],
  historyFilter: 'all',
  historyQuery: '',
  extraInstruction: '',
  userExtraPrompt: '',
  lastCall: null
};

const $ = (id) => document.getElementById(id);
let draftTimer = null;

async function init() {
  state.settings = await loadSettings();
  await initLogService(state.settings);
  setLogSettings(state.settings);
  setLogLimit(state.settings?.advanced?.debugLogLimit || 200);
  state.lastCall = await getLastCall();

  bindEvents();
  bindImageInputEvents();
  await loadDraft();
  await loadPendingImage();
  await refreshApiStatus();
  renderAll();
}

// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// Core events
// ════════════════════════════════════════════════════════════════

function bindEvents() {
  $('openOptionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('refreshStatusBtn').addEventListener('click', refreshApiStatus);
  $('reverseBtn').addEventListener('click', handleReversePrompt);
  $('clearBtn').addEventListener('click', clearCurrentImage);
  $('copyZhBtn').addEventListener('click', () => copyText($('promptZh').value, '已复制中文提示词'));
  $('copyEnBtn').addEventListener('click', () => copyText($('promptEn').value, '已复制英文提示词'));
  $('saveHistoryBtn').addEventListener('click', handleManualSaveHistory);
  $('generateBtn').addEventListener('click', () => handleGenerate(false));
  $('generateMultiAngleBtn').addEventListener('click', handleGenerateMultiAngleImages);
  $('downloadAllBtn').addEventListener('click', () => handleDownloadAll());
  $('regenerateBtn').addEventListener('click', handleRegenerate);
  $('copyErrorBtn').addEventListener('click', handleCopyError);
  $('viewLogsFromErrorBtn').addEventListener('click', openDebugDrawer);
  $('retryGenerateBtn').addEventListener('click', handleRegenerate);
  $('errorOptionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openHistoryBtn').addEventListener('click', openHistoryModal);
  $('closeHistoryBtn').addEventListener('click', closeHistoryModal);
  $('openDebugBtn').addEventListener('click', openDebugDrawer);
  $('closeDebugBtn').addEventListener('click', closeDebugDrawer);
  $('refreshDebugBtn').addEventListener('click', renderDebugLogs);
  $('clearDebugBtn').addEventListener('click', handleClearDebugLogs);
  $('exportDebugBtn').addEventListener('click', handleExportDebugLogs);
  $('debugLevelFilter').addEventListener('change', renderDebugLogs);
  $('debugApiTypeFilter').addEventListener('change', renderDebugLogs);
  $('debugSearchInput').addEventListener('input', renderDebugLogs);
  $('lastCallBadge').addEventListener('click', openDebugDrawer);

  $('historySearch').addEventListener('input', (event) => {
    state.historyQuery = event.target.value;
    renderHistoryList();
  });
  $('historyFilter').addEventListener('change', (event) => {
    state.historyFilter = event.target.value;
    renderHistoryList();
  });
  $('clearHistoryBtn').addEventListener('click', handleClearHistory);
  $('exportHistoryBtn').addEventListener('click', handleExportHistory);

  $('optimizeZhBtn').addEventListener('click', () => handleOptimizePrompt('zh'));
  $('optimizeEnBtn').addEventListener('click', () => handleOptimizePrompt('en'));

  $('extraInstruction').addEventListener('input', () => {
    state.extraInstruction = $('extraInstruction').value;
    queueSaveDraft();
  });

  $('userExtraPrompt').addEventListener('input', () => {
    state.userExtraPrompt = $('userExtraPrompt').value;
    queueSaveDraft();
  });

  $('promptZh').addEventListener('input', () => { state.prompts.zh = $('promptZh').value; renderButtonStates(); queueSaveDraft(); });
  $('promptEn').addEventListener('input', () => { state.prompts.en = $('promptEn').value; renderButtonStates(); queueSaveDraft(); });

  $('imagePreview').addEventListener('error', () => {
    if (state.currentImage && !state.currentImage.dataUrl) {
      $('imagePreviewWrap').classList.add('hidden');
      $('imageErrorPlaceholder').classList.remove('hidden');
    }
  });
  $('imagePreview').addEventListener('load', () => {
    $('imageErrorPlaceholder').classList.add('hidden');
    if (state.currentImage) {
      const img = $('imagePreview');
      const width = img.naturalWidth || 0;
      const height = img.naturalHeight || 0;
      if (width && height && (!state.currentImage.width || !state.currentImage.height)) {
        state.currentImage.width = width;
        state.currentImage.height = height;
        state.currentImage.originalWidth = state.currentImage.originalWidth || width;
        state.currentImage.originalHeight = state.currentImage.originalHeight || height;
        queueSaveDraft();
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'IMAGE_SELECTED') {
      console.log('[PromptLens] IMAGE_SELECTED received via runtime message');
      importImagePayload(message.payload);
      toast('图片已从右键菜单接收');
    }
    if (message.type === 'PROMPTLENS_CONTEXT_IMAGE_RECEIVED' && message.image) {
      console.log('[PromptLens] received context image via runtime message');
      importImagePayload(message.image);
      toast('图片已从右键菜单接收');
      sendResponse?.({ ok: true });
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.settings) refreshApiStatus();
  });
}

// ════════════════════════════════════════════════════════════════
// Image input events (unchanged)
// ════════════════════════════════════════════════════════════════

function bindImageInputEvents() {
  $('uploadBtn').addEventListener('click', () => { $('fileInput').click(); });
  $('fileInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const image = await handleLocalFile(file, 'upload');
      setCurrentImage(image);
      setTaskStatus('idle', '图片已导入，请点击反推');
      renderTaskStatus();
    } catch (error) { toast(error.message || '导入图片失败'); }
  });

  $('pasteBtn').addEventListener('click', async () => {
    console.log('[PromptPilot][CLICK] pasteBtn');
    try {
      const items = await navigator.clipboard.read();
      console.log('[PromptPilot] async clipboard read OK, items:', items.length);
      for (const item of items) {
        for (const type of item.types) {
          console.log('[PromptPilot] clipboard item type:', type);
          if (ALLOWED_IMAGE_TYPES.has(type)) {
            const blob = await item.getType(type);
            const file = new File([blob], 'clipboard.png', { type });
            const image = await handleLocalFile(file, 'paste');
            setCurrentImage(image);
            setTaskStatus('idle', '图片已从剪贴板导入，请点击反推');
            renderTaskStatus();
            console.log('[PromptPilot] paste via async clipboard OK');
            return;
          }
        }
      }
      toast('剪贴板中没有图片');
    } catch (error) {
      console.warn('[PromptPilot] async clipboard.read failed:', error?.name, error?.message);
      toast('请点击插件面板后按 Ctrl+V 粘贴图片');
    }
  });

  document.addEventListener('paste', async (event) => {
    console.log('[PromptPilot][PASTE_EVENT]', { hasClip: !!event.clipboardData, files: event.clipboardData?.files?.length || 0, items: event.clipboardData?.items?.length || 0 });
    const target = event.target;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') { console.log('[PromptPilot] paste ignored — target is input/textarea'); return; }
    try {
      const image = await handlePasteEvent(event);
      console.log('[PromptPilot] paste event image found, setting currentImage');
      setCurrentImage(image);
      setTaskStatus('idle', '图片已从粘贴导入，请点击反推');
      renderTaskStatus();
    } catch (error) {
      if (error.message?.includes('剪贴板中没有图片')) { console.log('[PromptPilot] paste event — no image in clipboard'); return; }
      console.error('[PromptPilot] paste event error:', error);
      toast(error.message || '粘贴图片失败');
    }
  });

  const imageCard = $('imageCard');
  imageCard.addEventListener('dragover', (event) => {
    event.preventDefault(); event.stopPropagation();
    imageCard.classList.add('drag-over');
    if (!state.currentImage) $('imageEmptyState').classList.add('hidden');
    $('imageDropHint').classList.remove('hidden');
    $('imagePreviewWrap').classList.add('hidden');
  });
  imageCard.addEventListener('dragleave', (event) => {
    event.preventDefault(); event.stopPropagation();
    imageCard.classList.remove('drag-over');
    $('imageDropHint').classList.add('hidden');
    if (!state.currentImage) $('imageEmptyState').classList.remove('hidden');
    else $('imagePreviewWrap').classList.remove('hidden');
  });
  imageCard.addEventListener('drop', async (event) => {
    event.preventDefault(); event.stopPropagation();
    imageCard.classList.remove('drag-over');
    $('imageDropHint').classList.add('hidden');
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) { toast('未识别到文件'); return; }
    if (files.length > 1) { toast('第一版只支持单张图片'); return; }
    const file = files[0];
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) { toast('不支持的文件类型'); return; }
    try {
      const image = await handleDropFile(file);
      setCurrentImage(image);
      setTaskStatus('idle', '图片已导入，请点击反推');
      renderTaskStatus();
    } catch (error) { toast(error.message || '导入图片失败'); }
  });
}

// ════════════════════════════════════════════════════════════════
// Pending image / draft loading
// ════════════════════════════════════════════════════════════════

async function loadPendingImage() {
  try {
    const data = await chrome.storage.local.get(['pendingImage', 'promptLensPendingImage', 'promptPilotPendingImage']);
    const pending = data.promptLensPendingImage || data.promptPilotPendingImage || data.pendingImage;
    if (pending) {
      importImagePayload(pending);
      toast('图片已从右键菜单接收');
      console.log('[PromptLens] pendingImage loaded from storage');
      // Clean up all variants
      await chrome.storage.local.remove(['pendingImage', 'promptLensPendingImage', 'promptPilotPendingImage']);
    }
  } catch (e) { console.warn('[PromptLens] loadPendingImage failed', e?.message); }
}

async function loadDraft() {
  if (state.settings?.storage?.autoSaveDraft === false) return;
  const draft = await restoreDraft();
  if (!draft?.currentImage) return;
  state.currentImage = normalizeImageInput(draft.currentImage);
  state.prompts = { ...createEmptyPrompts(), ...(draft.prompts || {}) };
  state.results = draft.results || [];
  state.generateSettings = draft.generateSettings || {};
  state.lastGenerateMode = state.generateSettings?.mode === 'multi-angle' ? 'multi-angle' : 'standard';
  state.extraInstruction = draft.extraInstruction || '';
  state.userExtraPrompt = draft.userExtraPrompt || '';
  state.taskStatus = { phase: 'restored', message: '已恢复上次草稿' };
  $('extraInstruction').value = state.extraInstruction || '';
  $('userExtraPrompt').value = state.userExtraPrompt || '';
}

// ════════════════════════════════════════════════════════════════
// Image import
// ════════════════════════════════════════════════════════════════

function importImagePayload(payload) {
  setCurrentImage(normalizeImageInput(payload));
}

function setCurrentImage(image) {
  state.currentImage = image;
  state.prompts = createEmptyPrompts();
  state.results = [];
  state.generateSettings = {};
  state.lastError = null;
  state.lastGenerateMode = 'standard';
  setTaskStatus('idle', '图片已接收，请点击反推');
  renderAll();
  queueSaveDraft();
  scheduleSaveCurrentImageMeta(image);
  // Persist source blob to IndexedDB for history durability
  persistSourceBlob(image);
}

async function persistSourceBlob(image) {
  if (!image || image._blobPersisted) return;
  image._blobPersisted = true; // mark early to prevent retries
  // Fire-and-forget: never block the paste/upload flow
  setTimeout(async () => {
    try {
      let blob = null;
      if (image.dataUrl && String(image.dataUrl).startsWith('data:')) {
        const res = await fetch(image.dataUrl);
        blob = await res.blob();
      } else if (image.file) {
        blob = image.file;
      } else if (image.displayUrl && !String(image.displayUrl).startsWith('blob:')) {
        try { const res = await fetch(image.displayUrl); blob = await res.blob(); } catch { /* remote may fail */ }
      }
      if (blob && blob.size > 0) {
        const saved = await saveImageBlob({ blob, mimeType: blob.type || 'image/png', kind: 'source', sourceUrl: image.url || '', width: image.width || 0, height: image.height || 0 });
        if (saved) { image.blobId = saved.id; }
      }
    } catch (e) { console.warn('[PromptLens] blob persist failed (non-blocking)', e?.message); }
  }, 0);
}

async function persistResultBlobs(results) {
  if (!results || results.length === 0) return;
  for (const r of results) {
    if (r.failed || !r.url || r._blobPersisted) continue;
    try {
      const res = await fetch(r.url);
      const blob = await res.blob();
      if (blob && blob.size > 0) {
        const saved = await saveImageBlob({ blob, mimeType: blob.type || 'image/png', kind: 'result', sourceUrl: r.url, width: r.width || 0, height: r.height || 0, expiresAt: Date.now() + 2 * 3600 * 1000 });
        if (saved) { r.blobId = saved.id; r._blobPersisted = true; }
      }
    } catch { /* remote URL may fail */ }
  }
}

function scheduleSaveCurrentImageMeta(image) {
  // Try immediate save if dimensions are already known (upload/paste)
  const w = Number(image?.width || image?.originalWidth || image?.naturalWidth || 0);
  const h = Number(image?.height || image?.originalHeight || image?.naturalHeight || 0);
  if (w > 0 && h > 0) {
    saveCurrentImageMeta(w, h);
    return;
  }
  // For URL images, wait for the preview <img> to load dimensions
  const preview = document.getElementById('imagePreview');
  if (!preview) return;
  const onLoad = () => {
    const pw = preview.naturalWidth || 0;
    const ph = preview.naturalHeight || 0;
    if (pw > 0 && ph > 0) {
      // Update state as well
      if (state.currentImage) {
        state.currentImage.width = state.currentImage.width || pw;
        state.currentImage.height = state.currentImage.height || ph;
        state.currentImage.originalWidth = state.currentImage.originalWidth || pw;
        state.currentImage.originalHeight = state.currentImage.originalHeight || ph;
      }
      saveCurrentImageMeta(pw, ph);
    }
    preview.removeEventListener('load', onLoad);
  };
  preview.addEventListener('load', onLoad);
  // Timeout: if already loaded, fire now
  if (preview.complete && preview.naturalWidth > 0) {
    onLoad();
  }
}

function saveCurrentImageMeta(w, h) {
  console.log('[PromptLens] saveCurrentImageMeta', { width: w, height: h });
  chrome.storage.local.set({
    currentImageMeta: { width: w, height: h, originalWidth: w, originalHeight: h, updatedAt: Date.now() }
  }).catch(() => {});
}

async function clearCurrentImage() {
  state.currentImage = null;
  state.prompts = createEmptyPrompts();
  state.results = [];
  state.generateSettings = {};
  state.lastError = null;
  state.lastGenerateMode = 'standard';
  await chrome.storage.local.remove('pendingImage');
  chrome.storage.local.remove('currentImageMeta').catch(() => {});
  await clearDraft();
  setTaskStatus('waiting-image', '等待右键发送图片');
  renderAll();
}

// ════════════════════════════════════════════════════════════════
// API status
// ════════════════════════════════════════════════════════════════

async function refreshApiStatus() {
  state.apiStatus.prompt = { status: 'checking', message: 'Prompt API 检测中' };
  state.apiStatus.image = { status: 'checking', message: 'Image API 检测中' };
  renderApiStatus();
  state.settings = await loadSettings();
  setLogSettings(state.settings);
  const [prompt, image] = await Promise.all([
    checkPromptApiStatus(state.settings),
    checkImageApiStatus(state.settings)
  ]);
  state.apiStatus.prompt = prompt;
  state.apiStatus.image = image;
  renderApiStatus();
  renderButtonStates();
}

// ════════════════════════════════════════════════════════════════
// Reverse prompt
// ════════════════════════════════════════════════════════════════

async function handleReversePrompt() {
  if (!state.currentImage?.url && !state.currentImage?.dataUrl) {
    toast('请先在网页图片上右键选择"图片转提示词"，或上传/拖拽/粘贴一张图片');
    return;
  }
  if (!isPromptApiAvailable()) { toast('Prompt API 未连接，请先在设置中完成配置'); return; }

  const startedAt = Date.now();
  state.lastError = null;

  setTaskStatus('analyzing', '正在反推提示词...');
  renderTaskStatus();
  renderError();

  // Elapsed time updater
  const timerEl = $('taskStatus');
  const elapsedInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent = `状态：正在反推中... 已耗时 ${sec} 秒`;
  }, 1000);

  try {
    const result = await generatePromptFromImage({
      currentImage: state.currentImage,
      extraInstruction: state.extraInstruction || undefined,
      settings: state.settings
    });
    clearInterval(elapsedInterval);

    state.prompts = {
      tags: result.tags || [],
      zh: result.zh || '',
      en: result.en || '',
      analysis: result.analysis || createEmptyAnalysis()
    };
    $('promptProviderText').textContent = result.provider || '';

    const durationMs = Date.now() - startedAt;
    setTaskStatus('success', `反推完成 (${(durationMs / 1000).toFixed(1)}s)`);
    await persistCurrentHistory();
    await updateLastCallDisplay();
    queueSaveDraft();
    renderAll();
  } catch (error) {
    clearInterval(elapsedInterval);
    state.lastError = normalizeError(error);
    const durationMs = Date.now() - startedAt;

    // HTTP 0 special message
    let errMsg = getErrorMessage(error, '反推失败');
    if ((error?.status || 0) === 0) {
      errMsg = '请求没有获得有效 HTTP 响应，可能是超时、网络中断、CORS、请求被浏览器取消，或接口耗时过长。';
    }

    setTaskStatus('error', errMsg);
    toast(errMsg);
    renderTaskStatus();
    renderError();
    await updateLastCallDisplay();

    // Clear prompts on failure — don't show stale/mock data
    state.prompts = createEmptyPrompts();
    state.results = [];
    $('promptProviderText').textContent = error?.provider || '-';
  }
}

// ════════════════════════════════════════════════════════════════
// Optimize prompt
// ════════════════════════════════════════════════════════════════

async function handleOptimizePrompt(language) {
  const text = language === 'zh' ? $('promptZh').value.trim() : $('promptEn').value.trim();
  if (!text) { toast(language === 'zh' ? '请先填写中文提示词' : 'Please fill in the English prompt first'); return; }
  if (!isPromptApiAvailable()) { toast('Prompt API 未连接，请先在设置中完成配置'); return; }

  const label = language === 'zh' ? '中文' : '英文';
  const btn = $(`optimize${language === 'zh' ? 'Zh' : 'En'}Btn`);
  btn.disabled = true;
  btn.textContent = '优化中...';
  setTaskStatus('analyzing', `正在优化${label}提示词...`);
  renderTaskStatus();

  try {
    const result = await enhancePrompt({ text, language, settings: state.settings });
    if (language === 'zh') { state.prompts.zh = result.text || text; $('promptZh').value = state.prompts.zh; }
    else { state.prompts.en = result.text || text; $('promptEn').value = state.prompts.en; }
    setTaskStatus('success', `${label}提示词优化完成`);
    queueSaveDraft();
    renderTaskStatus();
  } catch (error) {
    setTaskStatus('error', `优化${label}提示词失败`);
    toast(state.taskStatus.message);
    renderTaskStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = language === 'zh' ? '优化中文' : '优化英文';
    renderButtonStates();
  }
}

// ════════════════════════════════════════════════════════════════
// Image generation
// ════════════════════════════════════════════════════════════════

let _isGenerating = false;

async function handleGenerate() {
  let prompt = $('promptEn').value.trim() || $('promptZh').value.trim();
  if (!prompt) { toast('请先反推或填写提示词'); return; }
  if (!isImageApiAvailable()) { toast('Image API 未连接，请先在设置中完成配置'); return; }

  // Duplicate-click guard: prevent multiple parallel generation requests
  if (_isGenerating) { console.warn('[PromptLens] generation already running, ignoring duplicate click'); toast('正在生成中，请等待完成'); return; }
  _isGenerating = true;
  $('generateBtn').textContent = '生成中...';
  $('generateMultiAngleBtn').textContent = '生成中...';

  state.settings = await loadSettings();
  setLogSettings(state.settings);

  // Merge user extra prompt
  const extra = (state.userExtraPrompt || '').trim();
  if (extra) prompt = `${prompt} ${extra}`;

  const mode = 'standard';
  const count = 4;

  // Compute output size from settings
  const api = state.settings?.imageApi || {};
  const refImg = state.currentImage;
  const previewImg = $('imagePreview');
  const refWidth = refImg?.width || refImg?.originalWidth || previewImg?.naturalWidth || 0;
  const refHeight = refImg?.height || refImg?.originalHeight || previewImg?.naturalHeight || 0;
  const sizeMode = migrateSizeMode(api.sizeMode || 'preset');
  const aspectRatio = api.aspectRatio || api.selectedRatio || '1:1';
  const resolutionPreset = migrateResolutionPreset(api.resolutionPreset || api.quality);
  const outputSize = getOutputSize({
    sizeMode,
    aspectRatio,
    resolutionPreset,
    customWidth: api.customWidth || 1080,
    customHeight: api.customHeight || 1080,
    referenceImage: refWidth && refHeight ? { width: refWidth, height: refHeight } : null
  });
  const width = outputSize.width;
  const height = outputSize.height;
  const size = outputSize.size;
  const dashscopeSize = outputSize.dashscopeSize;
  state.generateSettings = { mode, count, width, height, size, dashscopeSize, sizeMode, aspectRatio: outputSize.aspectRatio, resolutionPreset };

  appendLog({
    level: 'info',
    apiType: 'image',
    event: 'IMAGE_GENERATE_START',
    provider: api.type || 'openai-compatible-image',
    message: `Start image generation: ${size}`,
    data: {
      requestedSize: size,
      width,
      height,
      sizeMode,
      aspectRatio: outputSize.aspectRatio,
      resolutionPreset
    }
  });
  setTaskStatus('generating', `正在生成图片... ${width}x${height}`);
  state.lastError = null;
  renderTaskStatus();
  renderError();

  try {
    // Pass the full image object (dataUrl or displayUrl or url) for reference
    const referenceImage = state.currentImage?.dataUrl || state.currentImage?.displayUrl || state.currentImage?.url || '';
    const result = await generateImages({
      prompt, negativePrompt: '',
      referenceImage, settings: state.settings, mode, count, width, height, size, dashscopeSize, outputSize
    });
    state.results = result.images || [];
    persistResultBlobs(state.results);
    state.lastGenerateMode = mode;
    state.lastError = null;
    setTaskStatus('success', '生成完成');
    await persistCurrentHistory();
    await updateLastCallDisplay();
    queueSaveDraft();
    renderAll();
  } catch (error) {
    state.lastError = normalizeError(error);
    setTaskStatus('error', getErrorMessage(error, '生成失败'));
    toast(state.taskStatus.message);
    renderTaskStatus();
    renderError();
    await updateLastCallDisplay();
  } finally {
    _isGenerating = false;
    $('generateBtn').textContent = '生成图片';
    $('generateMultiAngleBtn').textContent = '生成多角度';
  }
}

async function handleGenerateMultiAngleImages() {
  const promptEn = $('promptEn').value.trim();
  const promptZh = $('promptZh').value.trim();
  const prompt = promptEn || promptZh;
  if (!prompt) { toast('请先反推或填写提示词'); return; }
  if (!isImageApiAvailable()) { toast('Image API 未连接，请先在设置中完成配置'); return; }

  // Duplicate-click guard
  if (_isGenerating) { console.warn('[PromptLens] generation already running'); toast('正在生成中，请等待完成'); return; }
  _isGenerating = true;
  $('generateBtn').textContent = '生成中...';
  $('generateMultiAngleBtn').textContent = '生成中...';

  state.settings = await loadSettings();
  setLogSettings(state.settings);

  const api = state.settings?.imageApi || {};
  const refImg = state.currentImage;
  const previewImg = $('imagePreview');
  const refWidth = refImg?.width || refImg?.originalWidth || previewImg?.naturalWidth || 0;
  const refHeight = refImg?.height || refImg?.originalHeight || previewImg?.naturalHeight || 0;
  const sizeMode = migrateSizeMode(api.sizeMode || 'preset');
  const aspectRatio = api.aspectRatio || api.selectedRatio || '1:1';
  const resolutionPreset = migrateResolutionPreset(api.resolutionPreset || api.quality);
  const outputSize = getOutputSize({
    sizeMode,
    aspectRatio,
    resolutionPreset,
    customWidth: api.customWidth || 1080,
    customHeight: api.customHeight || 1080,
    referenceImage: refWidth && refHeight ? { width: refWidth, height: refHeight } : null
  });

  state.generateSettings = {
    mode: 'multi-angle',
    generateMode: 'multi-angle',
    count: 4,
    width: outputSize.width,
    height: outputSize.height,
    size: outputSize.size,
    dashscopeSize: outputSize.dashscopeSize,
    sizeMode: outputSize.sizeMode,
    aspectRatio: outputSize.aspectRatio,
    resolutionPreset: outputSize.resolutionPreset,
    generationMeta: {
      mode: 'multi-angle',
      angles: ['reference', 'side', 'back', 'top']
    }
  };

  appendLog({
    level: 'info',
    apiType: 'image',
    event: 'MULTI_ANGLE_GENERATE_START',
    provider: api.type || 'openai-compatible-image',
    message: `Start multi-angle generation: ${outputSize.size}`,
    data: {
      requestedSize: outputSize.size,
      width: outputSize.width,
      height: outputSize.height,
      sizeMode: outputSize.sizeMode,
      aspectRatio: outputSize.aspectRatio,
      resolutionPreset: outputSize.resolutionPreset
    }
  });

  setTaskStatus('generating', '正在生成多角度图像...');
  state.lastError = null;
  renderTaskStatus();
  renderError();

  try {
    const referenceImage = state.currentImage?.dataUrl || state.currentImage?.displayUrl || state.currentImage?.url || '';
    const result = await generateMultiAngleImages({
      prompt,
      promptZh,
      promptEn,
      negativePrompt: '',
      referenceImage,
      extraPrompt: state.userExtraPrompt || '',
      settings: state.settings,
      outputSize
    });
    state.results = result.images || [];
    persistResultBlobs(state.results);
    state.lastGenerateMode = 'multi-angle';
    state.lastError = null;
    const failedCount = state.results.filter((image) => image.failed).length;
    setTaskStatus('success', failedCount ? '多角度生成完成，部分失败' : '多角度生成完成');
    await persistCurrentHistory();
    await updateLastCallDisplay();
    queueSaveDraft();
    renderAll();
  } catch (error) {
    state.lastError = normalizeError(error);
    setTaskStatus('error', getErrorMessage(error, '多角度生成失败'));
    toast(state.taskStatus.message);
    renderTaskStatus();
    renderError();
    await updateLastCallDisplay();
  } finally {
    _isGenerating = false;
    $('generateBtn').textContent = '生成图片';
    $('generateMultiAngleBtn').textContent = '生成多角度';
  }
}

function handleRegenerate() {
  if (state.lastGenerateMode === 'multi-angle') {
    return handleGenerateMultiAngleImages();
  }
  return handleGenerate(false);
}

// ════════════════════════════════════════════════════════════════
// Last call display
// ════════════════════════════════════════════════════════════════

async function updateLastCallDisplay() {
  state.lastCall = await getLastCall();
  const badge = $('lastCallBadge');
  if (!state.lastCall) {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  badge.className = `status-badge ${state.lastCall.success ? 'success' : 'error'}`;
  const label = state.lastCall.apiType === 'prompt' ? 'Prompt' : state.lastCall.apiType === 'image' ? 'Image' : state.lastCall.apiType;
  badge.innerHTML = `<span></span>${label}: ${state.lastCall.status} ${state.lastCall.durationMs}ms`;
  badge.title = `${state.lastCall.provider} ${state.lastCall.method} ${state.lastCall.endpoint}\n${state.lastCall.message}`;
}

// ════════════════════════════════════════════════════════════════
// Debug drawer
// ════════════════════════════════════════════════════════════════

async function openDebugDrawer() {
  renderDebugStateSummary();
  renderDebugLastCall();
  $('debugDrawer').classList.remove('hidden');
  await renderDebugLogs();
}

function closeDebugDrawer() {
  $('debugDrawer').classList.add('hidden');
  $('debugLogDetail').classList.add('hidden');
}

function renderDebugStateSummary() {
  const items = [
    ['Prompt API', state.apiStatus.prompt?.status || 'unknown'],
    ['Image API', state.apiStatus.image?.status || 'unknown'],
    ['Current Image', state.currentImage ? '有' : '无'],
    ['Prompt ZH', state.prompts.zh ? `${state.prompts.zh.length} chars` : '空'],
    ['Prompt EN', state.prompts.en ? `${state.prompts.en.length} chars` : '空'],
    ['Results', `${state.results.length} 张`],
    ['Task Phase', state.taskStatus.phase || 'idle'],
    ['Last Error', state.lastError ? state.lastError.code : '无'],
    ['Debug Mode', state.settings?.advanced?.enableDebugMode ? '开' : '关'],
    ['Save Logs', state.settings?.advanced?.saveDebugLogs ? '开' : '关']
  ];
  $('debugStateGrid').innerHTML = items.map(([k, v]) =>
    `<div class="debug-state-item"><dt>${k}</dt><dd>${v}</dd></div>`
  ).join('');
}

async function renderDebugLastCall() {
  const call = await getLastCall();
  const el = $('debugLastCall');
  if (!call) { el.innerHTML = '<span class="muted">暂无调用</span>'; return; }
  const icon = call.success ? '✓' : '✗';
  const cls = call.success ? 'success' : 'error';
  el.innerHTML = `<span class="${cls}">${icon} ${call.apiType} | ${call.provider} | ${call.method} ${call.endpoint} | HTTP ${call.status} | ${call.durationMs}ms</span>
    <br><small class="muted">${call.message} · ${new Date(call.createdAt).toLocaleTimeString()}</small>`;
}

async function renderDebugLogs() {
  const level = $('debugLevelFilter').value;
  const apiType = $('debugApiTypeFilter').value;
  const keyword = $('debugSearchInput').value.trim();

  const filters = {};
  if (level !== 'all') filters.level = level;
  if (apiType !== 'all') filters.apiType = apiType;
  if (keyword) filters.keyword = keyword;

  const logs = await getLogs(filters);
  const list = $('debugLogList');
  if (!logs.length) {
    list.innerHTML = '<div class="empty-state"><p>暂无日志</p></div>';
    return;
  }

  list.innerHTML = logs.map((log) => `
    <div class="debug-log-row" data-id="${log.id}">
      <span class="log-lvl ${log.level}">${log.level}</span>
      <span class="log-time">${formatTimeShort(log.createdAt)}</span>
      <span class="log-msg" title="${escapeHtml(log.message)}">${escapeHtml(log.message)}</span>
      <span class="log-type">${escapeHtml(log.apiType || '')}</span>
    </div>
  `).join('');

  list.querySelectorAll('.debug-log-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const entry = logs.find((l) => l.id === id);
      if (entry) showLogDetail(entry, row);
    });
  });
}

function showLogDetail(entry, rowEl) {
  document.querySelectorAll('.debug-log-row.selected').forEach((r) => r.classList.remove('selected'));
  rowEl.classList.add('selected');
  const detail = $('debugLogDetail');
  detail.classList.remove('hidden');
  $('debugLogDetailPre').textContent = JSON.stringify(entry, null, 2);
}

async function handleClearDebugLogs() {
  if (!confirm('确定清空全部调试日志吗？')) return;
  await clearLogs();
  await renderDebugLogs();
  toast('调试日志已清空');
}

async function handleExportDebugLogs() {
  const logs = await getLogs();
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `promptlens-debug-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${logs.length} 条日志`);
}

// ════════════════════════════════════════════════════════════════
// Download, History, etc.
// ════════════════════════════════════════════════════════════════

async function handleDownloadAll() {
  if (!state.results.length) return;
  const downloadable = state.results.filter((image) => !image.failed && (image.url || image.thumbUrl));
  if (!downloadable.length) { toast('没有可下载的生成结果'); return; }
  const results = await downloadAllImages(downloadable);
  const failed = results.find((item) => !item.success);
  if (failed) { state.lastError = failed.error; renderError(); toast('部分图片下载失败'); }
  else { toast('已开始下载全部图片'); }
}

async function handleCopyError() {
  if (!state.lastError) return;
  await navigator.clipboard.writeText(sanitizeErrorLog(state.lastError));
  toast('已复制错误日志');
}

async function openHistoryModal() {
  state.historyItems = await getHistory();
  $('historyModal').classList.remove('hidden');
  renderHistoryList();
}

function closeHistoryModal() { $('historyModal').classList.add('hidden'); }

function renderHistoryList() {
  const list = getFilteredHistory();
  const wrap = $('historyList');
  wrap.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无历史记录';
    wrap.appendChild(empty);
    return;
  }

  list.forEach((item) => {
    const row = document.createElement('article');
    row.className = 'history-item';
    const thumb = item.results?.[0]?.thumbUrl || item.results?.[0]?.url || item.image?.displayUrl || item.image?.url || '';
    row.innerHTML = `
      <div class="history-main">
        ${thumb ? `<img class="history-thumb" src="${escapeAttr(thumb)}" alt="" onerror="this.parentElement.innerHTML='<div class=history-thumb-missing>图片缓存丢失</div>'">` : '<div class="history-thumb history-thumb-missing">图片缓存丢失</div>'}
        <div>
          <div class="history-title">${escapeHtml(item.title || '未命名记录')}</div>
          <div class="history-meta">${formatDateTime(item.createdAt)} · ${escapeHtml(item.image?.pageTitle || '未知页面')} · ${item.results?.length || 0} 张结果</div>
          <div class="history-tags">${(item.prompts?.tags || []).slice(0, 8).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
      </div>
      <div class="history-prompt">中：${escapeHtml(truncate(item.prompts?.zh || '', 60))}</div>
      <div class="history-prompt">EN：${escapeHtml(truncate(item.prompts?.en || '', 80))}</div>
      <div class="history-actions">
        <button class="secondary-btn" data-action="restore">恢复</button>
        <button class="secondary-btn" data-action="delete">删除</button>
        <button class="secondary-btn" data-action="copy-en">复制英文</button>
        <button class="secondary-btn" data-action="download">下载结果</button>
      </div>
    `;
    row.querySelector('[data-action="restore"]').addEventListener('click', () => restoreHistoryItem(item));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => handleDeleteHistoryItem(item.id));
    row.querySelector('[data-action="copy-en"]').addEventListener('click', () => copyText(item.prompts?.en || '', '已复制英文提示词'));
    // Async: try loading from IndexedDB blob for better durability
    loadHistoryThumbFromBlob(item, row);

    row.querySelector('[data-action="download"]').addEventListener('click', async () => {
      const downloadable = (item.results || []).filter((image) => !image.failed && (image.url || image.thumbUrl));
      if (!downloadable.length) return toast('该记录没有可下载的生成结果');
      await downloadAllImages(downloadable);
      toast('已开始下载历史结果');
    });
    wrap.appendChild(row);
  });
}

function getFilteredHistory() {
  const query = state.historyQuery.trim().toLowerCase();
  return [...state.historyItems]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .filter((item) => {
      if (state.historyFilter === 'prompt-only' && item.results?.length) return false;
      if (state.historyFilter === 'with-results' && !item.results?.length) return false;
      if (state.historyFilter === 'with-error' && !item.meta?.errorCount) return false;
      if (!query) return true;
      return [item.prompts?.zh, item.prompts?.en, item.image?.pageTitle, ...(item.prompts?.tags || [])].join(' ').toLowerCase().includes(query);
    });
}

async function loadHistoryThumbFromBlob(item, row) {
  if (!item || !row) return;
  // Priority: thumbnail blob > source blob > first result blob
  const blobIds = [
    item.thumbnailBlobId,
    item.sourceImageBlobId,
    item.image?.blobId,
    item.results?.[0]?.blobId
  ].filter(Boolean);

  console.log('[PromptPilot][HISTORY_THUMB_DEBUG]', { id: item.id, candidateBlobIds: blobIds });

  for (const blobId of blobIds) {
    try {
      const url = await createObjectUrlFromBlobId(blobId);
      if (url) {
        const img = row.querySelector('.history-thumb');
        if (img) { img.src = url; img.dataset.blobSource = blobId; }
        console.log('[PromptPilot][HISTORY_THUMB_LOADED]', { id: item.id, blobId });
        return;
      }
    } catch (e) { console.warn('[PromptPilot][HISTORY_BLOB_MISSING]', { id: item.id, blobId, error: e?.message }); }
  }

  // Fallback: remote URLs
  const fallbackUrl = item.image?.displayUrl || item.image?.url || item.results?.[0]?.url || item.results?.[0]?.thumbUrl;
  if (fallbackUrl && !String(fallbackUrl).startsWith('data:')) {
    const img = row.querySelector('.history-thumb');
    if (img) { img.src = fallbackUrl; img.dataset.blobSource = 'remote-fallback'; }
    console.log('[PromptPilot][HISTORY_IMAGE_FALLBACK_USED]', { id: item.id, fallbackUrl: fallbackUrl.slice(0, 80) });
    return;
  }

  console.warn('[PromptPilot][HISTORY_THUMB_ALL_FAILED]', { id: item.id });
}

function restoreHistoryItem(item) {
  state.currentImage = normalizeImageInput(item.image || {});
  state.prompts = { ...createEmptyPrompts(), ...(item.prompts || {}) };
  state.generateSettings = { ...(item.generateSettings || {}), generationMeta: item.generationMeta || item.generateSettings?.generationMeta || null };
  state.lastGenerateMode = state.generateSettings?.mode === 'multi-angle' ? 'multi-angle' : 'standard';
  state.results = item.results || [];
  state.lastError = null;
  if (item.templateMeta) {
    state.extraInstruction = item.templateMeta.extraInstruction || '';
    $('extraInstruction').value = state.extraInstruction || '';
  }
  setTaskStatus('restored', '已从历史恢复');
  closeHistoryModal();
  renderAll();
  queueSaveDraft();
}

async function handleDeleteHistoryItem(id) {
  await deleteHistoryItem(id);
  state.historyItems = await getHistory();
  renderHistoryList();
}

async function handleClearHistory() {
  if (!confirm('确定清空全部历史记录吗？')) return;
  await clearHistory();
  state.historyItems = [];
  renderHistoryList();
  toast('历史记录已清空');
}

async function handleExportHistory() {
  const payload = await exportHistory();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = createHistoryExportFilename(); link.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, message) {
  if (!text.trim()) { toast('没有可复制的内容'); return; }
  await navigator.clipboard.writeText(text);
  toast(message);
}

async function persistCurrentHistory() {
  if (state.settings?.storage?.enableHistory === false) return;
  try {
    const historyItem = createHistoryItemFromState(state);
    if (state.settings?.storage?.saveResults === false) historyItem.results = [];
    const saved = await saveHistoryItem(historyItem);
    if (saved?.reduced) toast('该记录过大，仅保存可恢复的 Prompt 信息');
  } catch (error) {
    appendLog({
      level: 'warn',
      apiType: 'system',
      event: 'HISTORY_SAVE_SKIPPED',
      message: `历史保存失败，已跳过: ${error?.message || ''}`
    });
    toast('历史缓存空间不足，本次仅显示结果不写入历史');
  }
}

async function handleManualSaveHistory() {
  if (!state.currentImage && !state.prompts.zh && !state.prompts.en) { toast('没有可保存的内容'); return; }
  await persistCurrentHistory();
  toast('已保存到历史');
}

function queueSaveDraft() {
  if (state.settings?.storage?.autoSaveDraft === false) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { saveDraft(state).catch((error) => console.warn('Failed to save draft:', error)); }, 800);
}

function setTaskStatus(phase, message) { state.taskStatus = { phase, message }; }

// ════════════════════════════════════════════════════════════════
// Rendering
// ════════════════════════════════════════════════════════════════

function renderAll() {
  renderCurrentImage();
  renderPromptResult();
  renderApiStatus();
  renderResults();
  renderError();
  renderButtonStates();
  renderTaskStatus();
  updateLastCallDisplay();
}

function renderCurrentImage() {
  const image = state.currentImage;
  const hasImage = Boolean(image && (image.displayUrl || image.url || image.dataUrl));
  const useUrl = image?.displayUrl || image?.dataUrl || image?.url || '';
  $('imageDropHint').classList.add('hidden');
  $('imageErrorPlaceholder').classList.add('hidden');
  $('imageWarning').classList.add('hidden');
  $('imageEmptyState').classList.toggle('hidden', hasImage);
  $('imagePreviewWrap').classList.toggle('hidden', !hasImage);
  if (hasImage) {
    $('imagePreview').src = useUrl;
    if (image.warning) { $('imageWarning').textContent = image.warning; $('imageWarning').classList.remove('hidden'); }
  }
}

function renderPromptResult() {
  $('promptZh').value = state.prompts.zh || '';
  $('promptEn').value = state.prompts.en || '';
  $('tagsWrap').innerHTML = '';
  state.prompts.tags.forEach((tag) => { const el = document.createElement('span'); el.className = 'tag'; el.textContent = tag; $('tagsWrap').appendChild(el); });
}

function renderApiStatus() {
  updateBadge($('promptStatusBadge'), state.apiStatus.prompt.status, statusText(state.apiStatus.prompt.status, 'prompt'));
  updateBadge($('imageStatusBadge'), state.apiStatus.image.status, statusText(state.apiStatus.image.status, 'image'));
}

function updateBadge(el, status, text) { el.className = `status-badge ${status}`; el.innerHTML = '<span></span>' + text; el.title = text; }

function renderResults() {
  $('resultsGrid').innerHTML = '';
  state.results.forEach((image, index) => {
    const card = document.createElement('article');
    card.className = `result-card${image.failed ? ' failed' : ''}`;
    const label = image.label || `结果 ${index + 1}`;
    if (image.failed) {
      card.innerHTML = `<div class="result-failed-placeholder"><strong>${escapeHtml(label)}</strong><span>该角度生成失败</span><small>${escapeHtml(image.errorMessage || '')}</small></div>`;
      $('resultsGrid').appendChild(card);
      return;
    }
    card.innerHTML = `<img src="${image.url || image.thumbUrl}" alt="${escapeAttr(label)}"><div class="result-card-body"><div class="result-card-title">${escapeHtml(label)}</div><div class="result-size-warning hidden">输出比例与设置不一致，可能是当前模型或接口不支持该尺寸。</div><div class="result-actions"><button class="secondary-btn" data-action="download">下载图片 ${index + 1}</button></div></div>`;
    const imgEl = card.querySelector('img');
    imgEl.addEventListener('load', async () => {
      const actual = await getImageNaturalSize(imgEl.src);
      if (!actual.width || !actual.height) return;
      image.width = actual.width;
      image.height = actual.height;
      const requestedWidth = Number(state.generateSettings?.width || 0);
      const requestedHeight = Number(state.generateSettings?.height || 0);
      const resultSize = `${actual.width}x${actual.height}`;
      appendLog({
        level: 'info',
        apiType: 'image',
        event: 'IMAGE_RESULT_SIZE',
        provider: image.provider || state.settings?.imageApi?.type || '',
        message: `Image result size: ${resultSize}`,
        data: {
          requestedSize: state.generateSettings?.size || '',
          resultSize,
          width: actual.width,
          height: actual.height
        }
      });
      if (requestedWidth && requestedHeight && !isSameAspectRatio(requestedWidth, requestedHeight, actual.width, actual.height)) {
        card.querySelector('.result-size-warning')?.classList.remove('hidden');
        appendLog({
          level: 'warn',
          apiType: 'image',
          event: 'IMAGE_RESULT_RATIO_MISMATCH',
          provider: image.provider || state.settings?.imageApi?.type || '',
          message: `Result ratio mismatch: requested ${requestedWidth}x${requestedHeight}, got ${resultSize}`,
          data: {
            requestedSize: state.generateSettings?.size || '',
            resultSize,
            width: actual.width,
            height: actual.height
          }
        });
      }
    }, { once: true });
    card.querySelector('[data-action="download"]').addEventListener('click', async () => {
      const result = await downloadImage(image, index + 1);
      if (!result.success) { state.lastError = result.error; renderError(); toast(result.error?.message || '下载失败'); }
      else { toast('已开始下载图片'); }
    });
    $('resultsGrid').appendChild(card);
  });
}

function renderError() {
  const hasError = Boolean(state.lastError);
  $('errorCard').classList.toggle('hidden', !hasError);
  if (!hasError) return;
  const error = state.lastError;
  const isModeration = error.code === ERROR_CODES.IMAGE_MODERATION_FAILED;
  const isInputModeration = error.code === ERROR_CODES.IMAGE_INPUT_MODERATION_FAILED;

  // Friendly titles
  if (isModeration) { $('errorCodeText').textContent = '图片生成被安全审核拦截'; }
  else if (isInputModeration) { $('errorCodeText').textContent = '输入内容被安全审核拦截'; }
  else { $('errorCodeText').textContent = error.code || ERROR_CODES.UNKNOWN_ERROR; }

  $('errorRetryableText').textContent = error.retryable ? '可重试' : '不可重试';

  const httpStatus = error.status || 0;
  const rawStatus = error.raw?.status || error.raw?.data?.status || '';
  const rawReason = error.raw?.error || error.raw?.failure_reason || error.raw?.message || error.raw?.data?.error || error.raw?.data?.failure_reason || '';
  const shouldUseNoResponseMessage = httpStatus === 0 &&
    [ERROR_CODES.NETWORK_ERROR, ERROR_CODES.TIMEOUT].includes(error.code);

  let msg = error.message || '操作失败';
  if (isModeration) {
    const sanitizerOn = state.settings?.promptApi?.enablePromptSanitizer !== false;
    const sanitizerHint = sanitizerOn
      ? '已启用 Prompt 净化，但仍触发审核。请进一步删除具体人物、IP、品牌、艺术家姓名或"完全复刻""同款"等表达。'
      : '你已关闭"生成前自动净化 Prompt"。可以在 Prompt API 设置中开启，以降低审核失败概率。';
    msg = `图像服务认为生成结果可能违反内容安全策略。\n\n建议：删除具体人物/明星/IP/品牌/艺术家姓名；降低"写实肖像""完全复刻""同款"等表达；改成描述主体、构图、光线、色彩和氛围。\n\n${sanitizerHint}\n\n服务商可能已返还积分，请以后台记录为准。`;
  } else if (isInputModeration) {
    const sanitizerOn = state.settings?.promptApi?.enablePromptSanitizer !== false;
    const sanitizerHint = sanitizerOn
      ? '已启用 Prompt 净化，但仍触发输入审核。请进一步修改 Prompt 或更换参考图。'
      : '你已关闭"生成前自动净化 Prompt"。可以在 Prompt API 设置中开启。';
    msg = `提示词或参考图可能触发了输入安全策略，请修改 Prompt 或更换参考图。\n\n${sanitizerHint}`;
  } else if (shouldUseNoResponseMessage) {
    msg = '请求没有获得有效 HTTP 响应，可能是超时、网络中断、CORS、请求被浏览器取消，或接口耗时过长。';
  } else if (rawStatus || rawReason) {
    msg = `${msg}\n接口状态：${rawStatus || '-'}；原因：${rawReason || '-'}`;
  }
  $('errorMessageText').textContent = msg;
  $('errorProviderText').textContent = `Provider: ${error.provider || '-'}`;
  $('errorStatusText').textContent = httpStatus === 0 ? 'HTTP: 0（接口未返回 HTTP 状态码）' : `HTTP: ${httpStatus}`;
}

function renderButtonStates() {
  const hasImage = Boolean(state.currentImage && (state.currentImage.url || state.currentImage.dataUrl));
  const hasPrompt = Boolean(($('promptEn').value || $('promptZh').value || state.prompts.en || state.prompts.zh).trim());
  const canUsePromptApi = isPromptApiAvailable();
  const canUseImageApi = isImageApiAvailable();
  $('reverseBtn').disabled = !hasImage || !canUsePromptApi;
  $('generateBtn').disabled = !hasPrompt || !canUseImageApi;
  $('generateMultiAngleBtn').disabled = !hasPrompt || !canUseImageApi;
  const hasDownloadableResults = state.results.some((image) => !image.failed && (image.url || image.thumbUrl));
  $('downloadAllBtn').disabled = !hasDownloadableResults;
  $('regenerateBtn').disabled = !hasPrompt || !state.results.length || !canUseImageApi;
  $('clearBtn').disabled = !hasImage;
  $('optimizeZhBtn').disabled = !hasPrompt || !canUsePromptApi;
  $('optimizeEnBtn').disabled = !hasPrompt || !canUsePromptApi;
}

function renderTaskStatus() { $('taskStatus').textContent = `状态：${state.taskStatus.message}`; }
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 2200); }

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

function createEmptyPrompts() { return { tags: [], zh: '', en: '', analysis: createEmptyAnalysis() }; }
function createEmptyAnalysis() { return { subject: '', scene: '', style: '', color: '', composition: '', camera: '', lighting: '', details: '' }; }
function isPromptApiAvailable() { return ['connected', 'unconfigured'].includes(state.apiStatus.prompt.status); }
function isImageApiAvailable() { return ['connected', 'unconfigured'].includes(state.apiStatus.image.status); }
function isSameAspectRatio(expectedWidth, expectedHeight, actualWidth, actualHeight) {
  const expected = Number(expectedWidth) / Number(expectedHeight);
  const actual = Number(actualWidth) / Number(actualHeight);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return true;
  return Math.abs(expected - actual) <= 0.08;
}
function getImageNaturalSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}
function truncate(value, max) { const text = String(value || ''); return text.length > max ? `${text.slice(0, max)}...` : text; }
function escapeHtml(value) { return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function escapeAttr(value) { return escapeHtml(value).replaceAll("'", '&#39;'); }
function formatTimeShort(ts) { const d = new Date(ts || Date.now()); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function pad2(v) { return String(v).padStart(2, '0'); }

init().catch((error) => {
  console.error(error);
  toast(getErrorMessage(error, '初始化失败'));
});
