import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Download the complete recitation only after an explicit full-download choice.
 * Completion is always established from the audio files, never from a saved counter.
 */
export function createOfflineDownload({
  getFilenames,
  getCachedFile,
  getTotalBytes = async () => undefined,
  ensureAudio,
  stateFile,
  concurrency = 3,
  retryDelayMs = 15_000,
  maxRetryDelayMs = 5 * 60_000,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('Offline download concurrency must be between 1 and 8.');
  }
  let filenames = [];
  let totalBytes;
  let expected = new Set();
  const completed = new Map();
  const active = new Map();
  let initialized = false;
  let initialization;
  let inventory;
  let preference = 'ask';
  let paused = false;
  let enabled = false;
  let stopped = false;
  let lastError;
  let retryTimer;
  let retryAttempt = 0;
  let generation = 0;
  let verifying = false;
  let verifiedComplete = false;
  let preferenceWrite = Promise.resolve();

  function snapshot() {
    let bytes = 0;
    for (const file of completed.values()) bytes += file.size;
    const state = !initialized ? lastError ? 'waiting' : 'starting'
      : preference === 'ask' ? 'choice'
        : verifiedComplete && completed.size === filenames.length ? 'complete'
          : preference === 'as-needed' ? 'on-demand'
            : paused || !enabled || stopped ? 'paused'
              : lastError || retryTimer ? 'waiting' : 'downloading';
    return {
      state,
      preference,
      completed: completed.size,
      total: filenames.length,
      bytes,
      ...(totalBytes === undefined ? {} : { totalBytes }),
      ...(lastError ? { error: lastError } : {}),
    };
  }

  function noteCached(filename, file) {
    if (!expected.has(filename)) return;
    const previous = completed.get(filename);
    completed.set(filename, { size: file.size, generation: ++generation });
    if (!previous || previous.size !== file.size) verifiedComplete = false;
  }

  // Check files with modest parallelism. Concurrent downloads are merged so an
  // inventory begun before a write cannot erase that newly completed download.
  async function reconcile() {
    if (inventory) return inventory;
    inventory = (async () => {
      const scanGeneration = generation;
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(24, filenames.length) }, async () => {
        while (index < filenames.length) {
          const filename = filenames[index++];
          const file = await getCachedFile(filename);
          if (file) noteCached(filename, file);
          else if ((completed.get(filename)?.generation ?? 0) <= scanGeneration) completed.delete(filename);
        }
      }));
      verifiedComplete = completed.size === filenames.length;
    })().finally(() => { inventory = undefined; });
    return inventory;
  }

  function clearRetry() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function retry(error) {
    lastError = error?.message || 'Connect to the internet to finish saving the recitation.';
    if (retryTimer || preference !== 'all' || paused || !enabled || stopped) return;
    const delay = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** Math.min(retryAttempt++, 8)));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (preference !== 'all' || paused || !enabled || stopped) return;
      lastError = undefined;
      if (!initialized) void initialize().then(pump, retry);
      else pump();
    }, delay);
    retryTimer.unref?.();
  }

  async function initialize() {
    if (initialized) return;
    if (initialization) return initialization;
    initialization = (async () => {
      const saved = await readFile(stateFile, 'utf8').then(JSON.parse).catch((error) => {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
        throw error;
      });
      // Legacy state recorded an automatic download, not consent to one. Ask
      // again unless this file contains the user's explicit current choice.
      preference = ['all', 'as-needed'].includes(saved?.preference) ? saved.preference : 'ask';
      paused = preference === 'all' && saved?.paused === true;
      filenames = [...new Set(await getFilenames())];
      if (!filenames.length) throw new Error('The local Quran text is unavailable. Restore public/data/quran.json.');
      totalBytes = await getTotalBytes(filenames);
      expected = new Set(filenames);
      await reconcile();
      initialized = true;
    })().finally(() => { initialization = undefined; });
    return initialization;
  }

  function pump() {
    if (!initialized || preference !== 'all' || stopped || paused || !enabled || retryTimer || lastError || verifying) return;
    for (const filename of filenames) {
      if (active.size >= concurrency) break;
      if (completed.has(filename) || active.has(filename)) continue;
      const task = Promise.resolve().then(() => ensureAudio(filename))
        .then((file) => {
          noteCached(filename, file);
          // Do not reset a failed batch's backoff because another in-flight
          // request succeeded; the next batch still waits before retrying.
          if (!lastError) retryAttempt = 0;
        }, retry)
        .finally(() => { active.delete(filename); pump(); });
      active.set(filename, task);
    }
    if (active.size === 0 && completed.size === filenames.length && !verifiedComplete) {
      verifying = true;
      void reconcile().catch(retry).finally(() => {
        verifying = false;
        if (!verifiedComplete) pump();
      });
    }
  }

  function savePreference() {
    const value = { preference, paused };
    // Serialize writes so rapidly pressing pause/resume cannot persist the
    // opposite preference when filesystem writes complete out of order.
    preferenceWrite = preferenceWrite.catch(() => {}).then(async () => {
      await mkdir(dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx' });
        await rename(temporary, stateFile);
      } finally {
        await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    });
    return preferenceWrite;
  }

  return {
    noteCached,
    async start({ download = true } = {}) {
      if (stopped) return snapshot();
      // Startup may enable the worker, but only a persisted 'all' choice lets
      // it schedule audio requests. Opening the app never makes that choice.
      enabled = download;
      try {
        await initialize();
        pump();
      } catch (error) {
        retry(error);
      }
      return snapshot();
    },
    async getStatus() {
      if (!initialized) {
        try { await initialize(); } catch (error) { retry(error); }
      }
      // During a download, writes update counters directly. A finished download
      // is rechecked on status requests, including files removed between runs.
      if (initialized && completed.size === filenames.length) {
        try { await reconcile(); } catch (error) { retry(error); }
      }
      pump();
      return snapshot();
    },
    async pause() {
      await initialize();
      paused = true;
      enabled = true;
      clearRetry();
      await savePreference();
      return snapshot();
    },
    async resume() {
      await initialize();
      preference = 'all';
      paused = false;
      enabled = true;
      clearRetry();
      lastError = undefined;
      retryAttempt = 0;
      await savePreference();
      try { await reconcile(); } catch (error) { retry(error); }
      pump();
      return snapshot();
    },
    async asNeeded() {
      await initialize();
      preference = 'as-needed';
      paused = false;
      clearRetry();
      lastError = undefined;
      retryAttempt = 0;
      await savePreference();
      return snapshot();
    },
    async stop() {
      stopped = true;
      clearRetry();
      await Promise.allSettled([...active.values(), preferenceWrite]);
    },
  };
}
