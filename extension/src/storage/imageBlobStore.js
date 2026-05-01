import { createId } from '../utils/id.js';
import { appendLog } from '../services/logService.js';

const DB_NAME = 'PromptLensDB';
const DB_VERSION = 1;
const STORE_NAME = 'imageBlobs';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, fn) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const result = fn(store, db);
      if (result instanceof Promise) {
        result.then(resolve).catch(reject);
      } else if (result && typeof result.then === 'function') {
        result.then(resolve).catch(reject);
      }
      tx.oncomplete = () => { if (!result || !result.then) resolve(result); };
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * Save an image blob to IndexedDB.
 * @returns {Promise<{id: string}>}
 */
export async function saveImageBlob({ blob, mimeType = 'image/png', width = 0, height = 0, kind = 'source', sourceUrl = '', expiresAt = 0 }) {
  if (!blob || blob.size === 0) {
    appendLog({ level: 'warn', apiType: 'system', event: 'IMAGE_BLOB_SAVE_FAILED', provider: 'db', message: 'Empty blob skipped' });
    return null;
  }
  const id = createId('blob');
  const record = {
    id, blob, mimeType, width, height, kind, sourceUrl, expiresAt,
    sizeBytes: blob.size,
    createdAt: Date.now()
  };
  try {
    await withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
    appendLog({ level: 'info', apiType: 'system', event: 'IMAGE_BLOB_SAVED', provider: 'db', message: `Blob saved: ${id}`, data: { blobId: id, sizeBytes: blob.size, mimeType, kind } });
    return { id, sizeBytes: blob.size, mimeType, width, height };
  } catch (error) {
    appendLog({ level: 'error', apiType: 'system', event: 'IMAGE_BLOB_SAVE_FAILED', provider: 'db', message: error.message, data: { sizeBytes: blob.size, kind } });
    return null;
  }
}

/**
 * Get an image blob by ID. Returns null if not found.
 */
export async function getImageBlob(id) {
  if (!id) return null;
  try {
    const record = await withStore('readonly', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    if (!record) {
      appendLog({ level: 'warn', apiType: 'system', event: 'IMAGE_BLOB_LOAD_FAILED', provider: 'db', message: `Blob not found: ${id}` });
      return null;
    }
    return record;
  } catch (error) {
    appendLog({ level: 'error', apiType: 'system', event: 'IMAGE_BLOB_LOAD_FAILED', provider: 'db', message: error.message, data: { blobId: id } });
    return null;
  }
}

/**
 * Delete a single blob.
 */
export async function deleteImageBlob(id) {
  if (!id) return;
  try {
    await withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  } catch { /* ignore */ }
}

/**
 * Delete multiple blobs at once.
 */
export async function deleteImageBlobs(ids) {
  if (!ids || ids.length === 0) return;
  await Promise.all(ids.map((id) => deleteImageBlob(id)));
}

/**
 * Create an Object URL from a blob ID. Caller must revoke when done.
 */
export async function createObjectUrlFromBlobId(id) {
  const record = await getImageBlob(id);
  if (!record || !record.blob) return null;
  return URL.createObjectURL(record.blob);
}

/**
 * List all blob metadata (without blob data for performance).
 */
export async function listImageBlobs() {
  try {
    const records = await withStore('readonly', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
    return records.map((r) => ({ id: r.id, kind: r.kind, sizeBytes: r.sizeBytes, mimeType: r.mimeType, createdAt: r.createdAt }));
  } catch {
    return [];
  }
}

/**
 * Get total size of all stored blobs.
 */
export async function getTotalBlobSize() {
  const blobs = await listImageBlobs();
  return blobs.reduce((sum, b) => sum + (b.sizeBytes || 0), 0);
}

/**
 * Clean up old/orphaned blobs. Keeps the most recent items up to maxBytes.
 */
export async function cleanupBlobs({ maxBytes = 100 * 1024 * 1024, referencedIds = new Set() } = {}) {
  const all = await withStore('readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });

  // Sort oldest first
  all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  let totalBytes = all.reduce((s, b) => s + (b.sizeBytes || 0), 0);
  const deleted = [];

  for (const record of all) {
    if (!referencedIds.has(record.id) && totalBytes > maxBytes) {
      await deleteImageBlob(record.id);
      totalBytes -= record.sizeBytes || 0;
      deleted.push(record.id);
    }
  }

  // Also delete unreferenced blobs regardless of size
  for (const record of all) {
    if (!referencedIds.has(record.id) && !deleted.includes(record.id)) {
      await deleteImageBlob(record.id);
      deleted.push(record.id);
    }
  }

  if (deleted.length > 0) {
    appendLog({ level: 'info', apiType: 'system', event: 'HISTORY_CLEANUP_DONE', provider: 'db', message: `Cleaned ${deleted.length} blobs`, data: { deletedCount: deleted.length } });
  }
  return deleted;
}

/**
 * Clear all blobs from the store.
 */
export async function clearAllBlobs() {
  await withStore('readwrite', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}
