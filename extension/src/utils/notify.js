const APP_NAME = 'PromptLens';
const ICON = 'assets/icon128.png';

let lastNotifyAt = 0;

function canNotify() {
  const now = Date.now();
  if (now - lastNotifyAt < 1000) return false;
  lastNotifyAt = now;
  return true;
}

async function notifyUser({ id = '', title = APP_NAME, message = '', iconUrl = ICON } = {}) {
  if (!canNotify()) return '';
  try {
    if (!chrome.notifications?.create) {
      console.warn(`[${APP_NAME}] chrome.notifications 不可用`);
      return '';
    }
    const nid = id || `promptlens_${Date.now()}`;
    await chrome.notifications.create(nid, { type: 'basic', iconUrl, title, message, priority: 0 });
    console.log(`[${APP_NAME}] 通知已显示: ${title}`);
    return nid;
  } catch (error) {
    console.warn(`[${APP_NAME}] 通知创建失败`, error?.message);
    return '';
  }
}

export async function notifyImageSentSuccess() {
  return notifyUser({ title: `已发送到 ${APP_NAME}`, message: '图片已接收，请打开侧边栏查看。' });
}

export async function notifyImageSentFailed(reason = '') {
  const msg = reason ? `原因：${reason}` : '未能读取该图片，请尝试上传图片或复制图片后粘贴。';
  return notifyUser({ title: '图片发送失败', message: msg });
}
