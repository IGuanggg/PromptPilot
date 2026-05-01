import { appendLog, initLogService, setLogSettings } from './services/logService.js';
import { loadSettings } from './services/storageService.js';
import { isQuotaExceededError, sanitizePendingImage } from './utils/sanitize.js';
import { notifyImageSentSuccess, notifyImageSentFailed } from './utils/notify.js';

const MENU_ID = 'image-to-prompt';
const PANEL_URL = 'src/sidepanel/sidepanel.html';
const POPUP_WIDTH = 440;
const POPUP_HEIGHT = 720;

let popupWindowId = null;
let currentPanelMode = 'popup'; // 'popup' | 'docked'

// Initialize logging on service worker start
(async () => {
  const settings = await loadSettings();
  setLogSettings(settings);
  await initLogService(settings);
  currentPanelMode = settings?.storage?.panelMode || 'docked';
})();

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '图片转提示词',
    contexts: ['image']
  });

  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  appendLog({
    level: 'info',
    apiType: 'system',
    event: 'EXTENSION_INSTALLED',
    message: '插件已安装/更新'
  });
});

// ── Toolbar icon: Chrome auto-opens side panel (openPanelOnActionClick: true) ──

// ── Right-click context menu ──
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!info.srcUrl) return;

  const srcUrl = info.srcUrl;
  const isBlob = String(srcUrl).startsWith('blob:');

  appendLog({
    level: 'info',
    apiType: 'system',
    event: 'CONTEXT_MENU_CLICKED',
    message: `右键图片: ${isBlob ? 'blob URL' : 'normal URL'}`,
    data: { isBlob, pageUrl: tab?.url }
  });

  const basePayload = {
    srcUrl,
    url: srcUrl,
    tabId: tab?.id || null,
    pageUrl: tab?.url || '',
    pageTitle: tab?.title || '',
    source: 'context-menu',
    createdAt: Date.now()
  };

  // Blob URL handling
  if (isBlob && tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'FETCH_BLOB',
        blobUrl: srcUrl
      });

      if (response?.success && response.dataUrl) {
        const payload = { ...basePayload, dataUrl: response.dataUrl, displayUrl: response.dataUrl, recoverable: true, warning: '' };

        appendLog({
          level: 'info',
          apiType: 'system',
          event: 'BLOB_CONVERTED',
          message: 'Blob URL 已转换为 data URL'
        });

        await savePendingImage(payload);
        // Try to notify open Side Panel immediately
        chrome.runtime.sendMessage({ type: 'PROMPTLENS_CONTEXT_IMAGE_RECEIVED', image: payload }).catch(() => {});
        await openPanel(tab, payload);
        notifyImageSentSuccess();
        return;
      }
    } catch (error) {
      appendLog({
        level: 'warn',
        apiType: 'system',
        event: 'BLOB_FETCH_FAILED',
        message: `Blob URL 获取失败: ${error?.message || ''}`
      });
      notifyImageSentFailed('未能读取该图片数据');
    }
  }

  // Fallback
  const payload = isBlob
    ? { ...basePayload, dataUrl: '', displayUrl: '', recoverable: false, warning: '当前 blob 图片无法直接恢复，请尝试截图粘贴或本地上传' }
    : basePayload;

  try {
    await savePendingImage(payload);

    appendLog({
      level: 'info',
      apiType: 'system',
      event: 'PENDING_IMAGE_SAVED',
      message: '图片已写入 pendingImage'
    });

    // Try to notify open Side Panel immediately
    chrome.runtime.sendMessage({ type: 'PROMPTLENS_CONTEXT_IMAGE_RECEIVED', image: payload }).catch(() => {});
    await openPanel(tab, payload);
    notifyImageSentSuccess();
  } catch (error) {
    appendLog({
      level: 'error',
      apiType: 'system',
      event: 'CONTEXT_MENU_SEND_FAILED',
      message: `右键发送失败: ${error?.message || ''}`
    });
    notifyImageSentFailed(error?.message || '存储写入失败');
  }
});

// ── Message listeners ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Blob conversion relay
  if (message.type === 'BLOB_CONVERTED' && message.payload) {
    savePendingImage(message.payload).catch(() => {});
    chrome.runtime.sendMessage({ type: 'IMAGE_SELECTED', payload: message.payload }).catch(() => {});
  }

  // Panel mode toggle from UI
  if (message.type === 'TOGGLE_PANEL_MODE') {
    handleTogglePanelMode(sender).catch(() => {});
  }
});

// ── Track popup window close ──
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// ── Open panel (popup or docked based on mode) ──
async function openPanel(tab, payload) {
  // Refresh settings to get latest panelMode
  try {
    const settings = await loadSettings();
    currentPanelMode = settings?.storage?.panelMode || 'docked';
  } catch {}

  if (currentPanelMode === 'docked') {
    await openDockedPanel(tab, payload);
  } else {
    await openPopupPanel(payload);
  }
}

async function openDockedPanel(tab, payload) {
  // If popup is already open, close it
  if (popupWindowId !== null) {
    try { await chrome.windows.remove(popupWindowId); } catch {}
    popupWindowId = null;
  }

  try {
    await chrome.sidePanel.open({ tabId: tab?.id });
    if (payload) {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'IMAGE_SELECTED', payload }).catch(() => {});
      }, 300);
    }
    appendLog({
      level: 'info',
      apiType: 'system',
      event: 'SIDE_PANEL_OPENED',
      message: '侧边栏已打开 (docked)'
    });
  } catch (error) {
    appendLog({
      level: 'error',
      apiType: 'system',
      event: 'SIDE_PANEL_OPEN_FAILED',
      message: `侧边栏打开失败: ${error?.message || ''}`
    });
  }
}

async function openPopupPanel(payload) {
  // If already open, focus it
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      if (payload) {
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'IMAGE_SELECTED', payload }).catch(() => {});
        }, 300);
      }
      return;
    } catch {
      popupWindowId = null;
    }
  }

  try {
    const storage = await chrome.storage.local.get('popupPosition');
    const pos = storage.popupPosition || {};

    const win = await chrome.windows.create({
      url: PANEL_URL,
      type: 'popup',
      width: pos.width || POPUP_WIDTH,
      height: pos.height || POPUP_HEIGHT,
      left: pos.left,
      top: pos.top,
      focused: true
    });

    popupWindowId = win.id;

    appendLog({
      level: 'info',
      apiType: 'system',
      event: 'POPUP_OPENED',
      message: `浮动窗口已打开 (id: ${win.id})`
    });
  } catch (error) {
    appendLog({
      level: 'error',
      apiType: 'system',
      event: 'POPUP_OPEN_FAILED',
      message: `浮动窗口打开失败: ${error?.message || ''}`
    });
  }
}

// ── Toggle panel mode ──
async function handleTogglePanelMode(sender) {
  const newMode = currentPanelMode === 'popup' ? 'docked' : 'popup';
  currentPanelMode = newMode;

  // Save preference
  try {
    const settings = await loadSettings();
    settings.storage = settings.storage || {};
    settings.storage.panelMode = newMode;
    await chrome.storage.local.set({ settings });
  } catch {}

  // Notify the panel of mode change
  chrome.runtime.sendMessage({ type: 'PANEL_MODE_CHANGED', mode: newMode }).catch(() => {});

  appendLog({
    level: 'info',
    apiType: 'system',
    event: 'PANEL_MODE_TOGGLED',
    message: `面板模式切换为: ${newMode}`
  });
}

async function savePendingImage(payload) {
  try {
    await chrome.storage.local.set({ pendingImage: payload });
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    await chrome.storage.local.remove('promptpilotLogs').catch(() => {});
    const reduced = sanitizePendingImage(payload);
    await chrome.storage.local.set({ pendingImage: reduced });
    appendLog({
      level: 'warn',
      apiType: 'system',
      event: 'PENDING_IMAGE_REDUCED',
      message: 'pendingImage 过大，已移除内联图片数据以避免存储配额溢出'
    });
  }
}
