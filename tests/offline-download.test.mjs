import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/index.mjs';

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(253, 7)]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(getValue, predicate, description = 'expected state') {
  const deadline = Date.now() + 5000;
  let value;
  do {
    value = await getValue();
    if (predicate(value)) return value;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

async function fixture(t, { count = 7, fetchImpl = async () => new Response(MP3), concurrency = 3, retryDelayMs = 30, existing = {}, autoDownload = true, manifest } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'quran-offline-download-'));
  const cacheDir = join(rootDir, '.cache', 'audio');
  await mkdir(join(rootDir, 'public', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(rootDir, 'public', 'data', 'quran.json'), JSON.stringify({
    ayahs: Array.from({ length: count }, (_, index) => ({ surah: 1, numberInSurah: index + 1 })),
  }));
  for (const [filename, bytes] of Object.entries(existing)) await writeFile(join(cacheDir, filename), bytes);
  if (manifest) await writeFile(join(rootDir, 'public', 'data', 'audio-manifest.json'), JSON.stringify(manifest));
  const servers = [];
  async function launch(options = {}) {
    const server = await createAppServer({
      rootDir,
      cacheDir,
      fetchImpl,
      autoDownload,
      offlineDownloadOptions: { concurrency, retryDelayMs, maxRetryDelayMs: 100 },
      ...options,
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      server,
      base,
      status: async () => (await fetch(`${base}/api/offline-status`)).json(),
      control: async (action) => (await fetch(`${base}/api/offline-download/${action}`, { method: 'POST', body: '{}' })).json(),
      async close() {
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        await server.offlineDownload.stop();
      },
    };
  }
  t.after(async () => {
    for (const server of servers) {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      await server.offlineDownload.stop();
    }
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { rootDir, cacheDir, launch, ...await launch() };
}

test('first launch downloads all missing verses with bounded workers and reuses valid audio', async (t) => {
  const requested = [];
  let active = 0;
  let maximumActive = 0;
  const { status, cacheDir } = await fixture(t, {
    existing: { '001001.mp3': MP3, '001002.mp3': Buffer.from('<html>invalid</html>'), '.001004.interrupted.tmp': MP3, '999999.mp3': MP3 },
    fetchImpl: async (url) => {
      requested.push(url.split('/').at(-1));
      active++;
      maximumActive = Math.max(maximumActive, active);
      await delay(15);
      active--;
      return new Response(MP3);
    },
  });
  const complete = await waitFor(status, (value) => value.state === 'complete');
  assert.deepEqual(complete, { state: 'complete', completed: 7, total: 7, bytes: MP3.length * 7 });
  assert.equal(requested.length, 6);
  assert.ok(!requested.includes('001001.mp3'));
  assert.ok(requested.includes('001002.mp3'), 'invalid cached files are repaired');
  assert.equal(maximumActive, 3);
  assert.deepEqual(await readFile(join(cacheDir, '001002.mp3')), MP3);
});

test('offline failures wait, retry automatically, and resume without restarting the app', async (t) => {
  let online = false;
  let attempts = 0;
  const { status } = await fixture(t, {
    concurrency: 1,
    retryDelayMs: 80,
    fetchImpl: async () => {
      attempts++;
      if (!online) throw new Error('offline');
      return new Response(MP3);
    },
  });
  const waiting = await waitFor(status, (value) => value.state === 'waiting');
  assert.equal(waiting.completed, 0);
  assert.match(waiting.error, /internet/);
  const attemptsBefore = attempts;
  await delay(35);
  assert.equal(attempts, attemptsBefore, 'network failures do not cause a tight retry loop');
  online = true;
  const complete = await waitFor(status, (value) => value.state === 'complete');
  assert.equal(complete.completed, 7);
});

test('the source manifest detects a partial MP3 despite a valid header and rejects incomplete upstream audio', async (t) => {
  let attempts = 0;
  const { status, cacheDir, base } = await fixture(t, {
    count: 2,
    concurrency: 1,
    retryDelayMs: 80,
    manifest: { files: { '001001': MP3.length, '001002': MP3.length }, totalBytes: MP3.length * 2 },
    existing: { '001001.mp3': MP3.subarray(0, 128) },
    fetchImpl: async () => {
      attempts++;
      return new Response(attempts === 1 ? MP3.subarray(0, 100) : MP3);
    },
  });
  const waiting = await waitFor(status, (value) => value.state === 'waiting');
  assert.equal(waiting.completed, 0);
  assert.equal(waiting.totalBytes, MP3.length * 2);
  assert.deepEqual(await (await fetch(`${base}/api/audio-cache`)).json(), { files: [], bytes: 0 });
  assert.match(waiting.error, /expected size/);
  const complete = await waitFor(status, (value) => value.state === 'complete');
  assert.equal(complete.completed, 2);
  assert.equal(complete.bytes, complete.totalBytes);
  assert.equal(attempts, 3);
  assert.deepEqual(await readFile(join(cacheDir, '001001.mp3')), MP3);
});

test('pause stops scheduling new work, survives relaunch, and resume continues saved progress', async (t) => {
  let release;
  let attempts = 0;
  let hold = true;
  const item = await fixture(t, {
    concurrency: 1,
    fetchImpl: async () => {
      attempts++;
      if (hold) await new Promise((resolve) => { release = resolve; });
      return new Response(MP3);
    },
  });
  await waitFor(async () => attempts, (value) => value === 1);
  assert.equal((await item.control('pause')).state, 'paused');
  hold = false;
  release();
  await waitFor(item.status, (value) => value.completed === 1);
  await delay(60);
  assert.equal(attempts, 1, 'the active verse finishes but the next one does not start');
  assert.deepEqual(JSON.parse(await readFile(join(item.rootDir, '.cache', 'offline-download.json'), 'utf8')), { paused: true });
  await item.close();
  const restarted = await item.launch();
  assert.equal((await restarted.status()).state, 'paused');
  await delay(40);
  assert.equal(attempts, 1);
  await restarted.control('resume');
  await waitFor(restarted.status, (value) => value.state === 'complete');
  assert.equal(attempts, 7, 'resuming reuses the completed verse');
});

test('interrupted runs resume automatically from disk and disregard stale completed counters', async (t) => {
  let attempts = 0;
  const item = await fixture(t, {
    concurrency: 1,
    retryDelayMs: 100,
    fetchImpl: async () => {
      attempts++;
      if (attempts === 2) throw new Error('network interrupted');
      return new Response(MP3);
    },
  });
  await waitFor(item.status, (value) => value.state === 'waiting' && value.completed === 1);
  await item.close();
  await writeFile(join(item.rootDir, '.cache', 'offline-download.json'), JSON.stringify({ completed: 6236, paused: false }));
  const restarted = await item.launch();
  const complete = await waitFor(restarted.status, (value) => value.state === 'complete');
  assert.equal(complete.completed, 7);
  assert.equal(attempts, 8, 'one successful verse is reused and the interrupted verse is retried');
});

test('completed status is checked against disk and repairs a deleted or damaged verse', async (t) => {
  let attempts = 0;
  const item = await fixture(t, { fetchImpl: async () => { attempts++; await delay(20); return new Response(MP3); } });
  await waitFor(item.status, (value) => value.state === 'complete');
  assert.equal(attempts, 7);
  await unlink(join(item.cacheDir, '001003.mp3'));
  await writeFile(join(item.cacheDir, '001005.mp3'), Buffer.from('broken'));
  const incomplete = await item.status();
  assert.equal(incomplete.state, 'downloading');
  assert.equal(incomplete.completed, 5);
  await waitFor(item.status, (value) => value.state === 'complete');
  assert.equal(attempts, 9);
});

test('default server construction does not download and status includes normal playback caches', async (t) => {
  let attempts = 0;
  const { base, status, cacheDir } = await fixture(t, {
    autoDownload: false,
    fetchImpl: async () => { attempts++; return new Response(MP3); },
  });
  assert.deepEqual(await status(), { state: 'paused', completed: 0, total: 7, bytes: 0 });
  assert.equal(attempts, 0);
  const playback = await fetch(`${base}/api/audio/1/2`);
  assert.equal(playback.status, 200);
  await playback.arrayBuffer();
  assert.deepEqual(await status(), { state: 'paused', completed: 1, total: 7, bytes: MP3.length });
  assert.equal(attempts, 1);
  assert.deepEqual(await readdir(cacheDir), ['001002.mp3']);
});

test('download controls require same-origin POST and bound the request body', async (t) => {
  const { base } = await fixture(t, { autoDownload: false });
  assert.equal((await fetch(`${base}/api/offline-download/resume`)).status, 405);
  assert.equal((await fetch(`${base}/api/offline-download/resume`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/offline-download/resume`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/offline-download/resume`, { method: 'POST', body: 'x'.repeat(1025) })).status, 413);
  const head = await fetch(`${base}/api/offline-status`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('closing a waiting server cancels scheduled retries', async (t) => {
  let attempts = 0;
  const item = await fixture(t, {
    concurrency: 1,
    fetchImpl: async () => { attempts++; throw new Error('offline'); },
  });
  await waitFor(item.status, (value) => value.state === 'waiting');
  await item.close();
  const before = attempts;
  await delay(150);
  assert.equal(attempts, before);
});
