import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { createAppServer } from '../server/index.mjs';

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(253, 7)]);

async function fixture(t, fetchImpl = async () => { throw new Error('offline'); }, { dev = false } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'quran-repeater-test-'));
  const cacheDir = join(rootDir, '.cache', 'audio');
  await Promise.all([
    mkdir(join(rootDir, 'dist', 'assets'), { recursive: true }),
    mkdir(join(rootDir, 'public', 'data'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(rootDir, 'dist', 'index.html'), '<!doctype html><title>Quran</title>'),
    writeFile(join(rootDir, 'dist', 'assets', 'app.js'), 'export const app = true;'),
    writeFile(join(rootDir, 'secret.txt'), 'private'),
    writeFile(join(rootDir, 'public', 'data', 'quran.json'), JSON.stringify({
      surahs: [{ number: 1, numberOfAyahs: 7 }],
      ayahs: Array.from({ length: 7 }, (_, i) => ({ surah: 1, numberInSurah: i + 1 })),
    })),
  ]);
  if (dev) {
    await mkdir(join(rootDir, 'node_modules', 'sample-dependency'), { recursive: true });
    await Promise.all([
      writeFile(join(rootDir, 'index.html'), '<!doctype html><title>Dev Quran</title><script type="module" src="/main.js"></script>'),
      writeFile(join(rootDir, 'main.js'), 'import value from "sample-dependency"; console.log(value);'),
      writeFile(join(rootDir, 'node_modules', 'sample-dependency', 'package.json'), JSON.stringify({ name: 'sample-dependency', version: '1.0.0', main: 'index.js' })),
      writeFile(join(rootDir, 'node_modules', 'sample-dependency', 'index.js'), 'export default 42;'),
    ]);
  }
  const server = await createAppServer({ rootDir, cacheDir, fetchImpl, dev });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { rootDir, cacheDir, base, server };
}

function rawGet(base, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(base, { path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the local built app and bundled Quran with appropriate MIME types', async (t) => {
  const { base } = await fixture(t);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, localOnly: true });
  const page = await fetch(base);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await page.text(), /<title>Quran<\/title>/);
  const script = await fetch(`${base}/assets/app.js`);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const data = await fetch(`${base}/data/quran.json`);
  assert.equal(data.status, 200);
  assert.equal((await data.json()).ayahs.length, 7);
  const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
});

test('does not expose traversal paths, symlinks, arbitrary hosts, or cross-site API calls', async (t) => {
  const { base, rootDir } = await fixture(t);
  await symlink(join(rootDir, 'secret.txt'), join(rootDir, 'public', 'leaked.txt'));
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%5c..%5csecret.txt', '/%00.txt', '/.git/config', '/%ZZ']) {
    assert.equal((await rawGet(base, path)).status, 400, path);
  }
  assert.equal((await fetch(`${base}/leaked.txt`)).status, 404);
  assert.equal((await rawGet(base, '/api/health', { Host: 'evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/health`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/health`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});

test('development mode serves optimized dependencies while blocking other hidden paths', async (t) => {
  const { base } = await fixture(t, undefined, { dev: true });
  const page = await fetch(base);
  assert.match(await page.text(), /\/@vite\/client/);
  const main = await fetch(`${base}/main.js`);
  assert.equal(main.status, 200);
  const dependencyPath = (await main.text()).match(/"([^"\n]*\/node_modules\/\.vite\/deps\/sample-dependency\.js[^"\n]*)"/)?.[1];
  assert.ok(dependencyPath, 'Vite transforms the dependency import into an optimized module');
  const dependency = await fetch(new URL(dependencyPath, base));
  assert.equal(dependency.status, 200);
  assert.match(await dependency.text(), /42/);
  assert.equal((await rawGet(base, '/node_modules/.vite/deps/../../.env')).status, 400);
  assert.equal((await rawGet(base, '/node_modules/.vite/.env')).status, 400);
  assert.equal((await rawGet(base, '/.git/config')).status, 400);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('validates verse numbers before contacting the audio source', async (t) => {
  let fetched = 0;
  const { base } = await fixture(t, async () => { fetched++; return new Response(MP3); });
  for (const path of ['/api/audio/1/8', '/api/audio/0/1', '/api/audio/115/1', '/api/audio/1/0', '/api/audio/1/1.mp3', '/api/audio/https:/example.com']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 400, path);
    assert.match((await response.json()).error, /valid surah/);
  }
  assert.equal(fetched, 0);
});

test('downloads each verse once, caches it atomically, and replays it offline', async (t) => {
  let fetched = 0;
  let offline = false;
  const { base, cacheDir } = await fixture(t, async (url) => {
    fetched++;
    if (offline) throw new Error('offline');
    assert.equal(url, 'https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/001001.mp3');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': MP3.length } });
  });
  assert.deepEqual(await (await fetch(`${base}/api/audio-cache`)).json(), { files: [], bytes: 0 });
  const responses = await Promise.all([fetch(`${base}/api/audio/1/1`), fetch(`${base}/api/audio/001/001`)]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP3);
  }
  assert.equal(fetched, 1);
  assert.deepEqual(await readdir(cacheDir), ['001001.mp3']);
  assert.deepEqual(await readFile(join(cacheDir, '001001.mp3')), MP3);
  offline = true;
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/audio/1/1`)).arrayBuffer()), MP3);
  assert.equal(fetched, 1);
  assert.deepEqual(await (await fetch(`${base}/api/audio-cache`)).json(), { files: ['001001'], bytes: MP3.length });
});

test('supports bounded, open-ended, and suffix byte ranges for seeking cached audio', async (t) => {
  const { base, cacheDir } = await fixture(t);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, '001001.mp3'), MP3);
  for (const [range, start, end] of [['bytes=0-2', 0, 2], ['bytes=250-', 250, 255], ['bytes=-4', 252, 255], ['bytes=253-999', 253, 255]]) {
    const response = await fetch(`${base}/api/audio/1/1`, { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/256`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP3.subarray(start, end + 1));
  }
  for (const range of ['bytes=256-', 'bytes=10-1', 'bytes=-0', 'bytes=-', 'bytes=0-2,4-6', 'items=0-2']) {
    const response = await fetch(`${base}/api/audio/1/1`, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */256');
  }
});

test('failed or malformed downloads leave no cache entry and can be retried', async (t) => {
  let attempts = 0;
  const { base, cacheDir } = await fixture(t, async () => {
    attempts++;
    if (attempts === 1) throw new Error('offline');
    if (attempts === 2) return new Response('<html>Error</html>');
    if (attempts === 3) return new Response(MP3, { headers: { 'Content-Length': MP3.length + 1 } });
    return new Response(MP3);
  });
  for (const status of [503, 502, 502]) {
    const response = await fetch(`${base}/api/audio/1/1`);
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.deepEqual(await readdir(cacheDir).catch(() => []), []);
  }
  assert.equal((await fetch(`${base}/api/audio/1/1`)).status, 200);
  assert.deepEqual(await readdir(cacheDir), ['001001.mp3']);
});
