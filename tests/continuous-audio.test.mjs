import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { createAppServer } from '../server/index.mjs';
import { buildContinuousSelection } from '../server/continuous-audio.mjs';

const run = promisify(execFile);
const quran = { ayahs: [
  { number: 1, surah: 1, numberInSurah: 1, page: 1 },
  { number: 2, surah: 1, numberInSurah: 2, page: 2 },
  { number: 3, surah: 2, numberInSurah: 1, page: 2 },
] };
const manifest = { source: { audioBaseUrl: 'https://example.com/continuous/' }, surahs: [
  { number: 1, bytes: 256, duration: 1.1, recordingDuration: 2, ayahs: [
    { numberInSurah: 1, start: 0.4, end: 0.7, page: 1 },
    { numberInSurah: 2, start: 0.7, end: 1.1, page: 2 },
  ] },
  { number: 2, bytes: 256, duration: 0.9, recordingDuration: 2.5, ayahs: [
    { numberInSurah: 1, start: 0.3, end: 0.9, page: 2 },
  ] },
] };
const shapedMp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(253, 7)]);

async function fixture(t, { fetchImpl, realAudio = false } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'quran-continuous-test-'));
  const cacheDir = join(rootDir, '.cache/audio');
  await mkdir(join(rootDir, 'public/data'), { recursive: true });
  await mkdir(join(rootDir, '.cache'), { recursive: true });
  const data = structuredClone(manifest);
  const audio = new Map([['001', shapedMp3], ['002', shapedMp3]]);
  if (realAudio) {
    for (const source of data.surahs) {
      const filename = String(source.number).padStart(3, '0');
      const path = join(rootDir, `${filename}.mp3`);
      await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `sine=frequency=${source.number * 440}:sample_rate=44100:duration=${source.recordingDuration}`,
        '-codec:a', 'libmp3lame', '-q:a', '2', path]);
      audio.set(filename, await readFile(path));
      source.bytes = audio.get(filename).length;
    }
  }
  await writeFile(join(rootDir, 'public/data/quran.json'), JSON.stringify(quran));
  await writeFile(join(rootDir, 'public/data/continuous-audio.json'), JSON.stringify(data));
  // A previous decision about ayah downloads is deliberately not inherited.
  await writeFile(join(rootDir, '.cache/offline-download.json'), JSON.stringify({ preference: 'all', paused: false }));
  let requests = 0;
  let offline = false;
  const server = await createAppServer({ rootDir, cacheDir,
    fetchImpl: async (url, options) => {
      requests++;
      if (offline) throw new Error('offline');
      if (fetchImpl) return fetchImpl(url, options);
      assert.match(url, /^https:\/\/example\.com\/continuous\/00[12]\.mp3$/);
      await new Promise(resolve => setTimeout(resolve, 10));
      const bytes = audio.get(url.match(/(\d{3})\.mp3$/)[1]);
      return new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) } });
    }, continuousDownloadOptions: { retryDelayMs: 10_000 },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await server.continuousDownload.stop();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { rootDir, cacheDir, base, audio, manifest: data, server,
    requests: () => requests, disconnect: () => { offline = true; } };
}

test('page metadata retains the opening and final-surah tail, with no cuts at internal ayahs', () => {
  const firstPage = buildContinuousSelection(quran, manifest, 'page', 1);
  assert.equal(firstPage.duration, 0.7);
  assert.deepEqual(firstPage.clips, [{ surah: 1, start: 0, end: 0.7, toEnd: false }]);
  assert.equal(firstPage.verses[0].start, 0);
  const sharedPage = buildContinuousSelection(quran, manifest, 'page', 2);
  assert.equal(sharedPage.duration, 3.8);
  assert.deepEqual(sharedPage.clips, [
    { surah: 1, start: 0.7, end: 2, toEnd: true },
    { surah: 2, start: 0, end: 2.5, toEnd: true },
  ]);
  assert.deepEqual(sharedPage.verses, [
    { number: 2, surah: 1, numberInSurah: 2, start: 0, end: 0.4 },
    { number: 3, surah: 2, numberInSurah: 1, start: 1.3, end: 2.2 },
  ]);
  const surah = buildContinuousSelection(quran, manifest, 'surah', 1);
  assert.equal(surah.duration, 2);
  assert.deepEqual(surah.verses.map(verse => verse.start), [0, 0.7]);
  assert.equal(buildContinuousSelection(quran, manifest, 'page', 3), null);
});

test('every bundled page and surah matches the canonical Quran with complete bounded audio timings', async () => {
  const [bundledQuran, bundledManifest] = await Promise.all([
    readFile(new URL('../public/data/quran.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../public/data/continuous-audio.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const sources = new Map(bundledManifest.surahs.map(source => [source.number, source]));
  const epsilon = 0.000001;
  assert.equal(bundledManifest.surahs.length, 114);
  for (const [mode, count] of [['page', 604], ['surah', 114]]) {
    const visited = [];
    for (let number = 1; number <= count; number++) {
      const label = `${mode} ${number}`;
      const expected = bundledQuran.ayahs.filter(verse => mode === 'page' ? verse.page === number : verse.surah === number);
      const selection = buildContinuousSelection(bundledQuran, bundledManifest, mode, number);
      assert.ok(selection && expected.length > 0, label);
      assert.deepEqual(selection.verses.map(verse => verse.number), expected.map(verse => verse.number), `${label} has every canonical ayah exactly once`);
      assert.ok(Number.isFinite(selection.duration) && selection.duration > 0, `${label} duration`);
      let previousStart = -1;
      let previousEnd = -1;
      for (let index = 0; index < selection.verses.length; index++) {
        const verse = selection.verses[index];
        assert.equal(verse.surah, expected[index].surah, label);
        assert.equal(verse.numberInSurah, expected[index].numberInSurah, label);
        assert.ok(Number.isFinite(verse.start) && Number.isFinite(verse.end), `${label} ayah ${verse.number} finite timestamps`);
        assert.ok(verse.start >= -epsilon && verse.start >= previousStart - epsilon && verse.start >= previousEnd - epsilon,
          `${label} ayah ${verse.number} ordered without overlap`);
        assert.ok(verse.end > verse.start && verse.end <= selection.duration + epsilon,
          `${label} ayah ${verse.number} stays within the actual selection duration`);
        previousStart = verse.start;
        previousEnd = verse.end;
        visited.push(verse.number);
      }
      let clipDuration = 0;
      for (const clip of selection.clips) {
        const source = sources.get(clip.surah);
        const group = expected.filter(verse => verse.surah === clip.surah);
        const first = source.ayahs[group[0].numberInSurah - 1];
        const next = source.ayahs[group.at(-1).numberInSurah];
        assert.equal(clip.start, first.numberInSurah === 1 ? 0 : first.start, `${label} preserves the opening or starts exactly at its first ayah`);
        assert.equal(clip.toEnd, !next, `${label} clips only intermediate page boundaries`);
        assert.equal(clip.end, next ? next.start : source.recordingDuration, `${label} ends at the next ayah or the full original recording's EOF`);
        assert.ok(clip.end > clip.start && clip.end <= source.recordingDuration + epsilon, `${label} valid source bounds`);
        clipDuration += clip.end - clip.start;
      }
      assert.ok(Math.abs(selection.duration - clipDuration) <= epsilon, `${label} duration equals its complete source spans`);
    }
    assert.equal(visited.length, 6236, `Every ayah is included when reading by ${mode}`);
    assert.equal(new Set(visited).size, 6236, `No ayah is duplicated when reading by ${mode}`);
    assert.deepEqual(visited, bundledQuran.ayahs.map(verse => verse.number), `${mode} traversal follows the canonical Quran order`);
  }
});

test('selection metadata and initial choice make no audio request, even with a legacy all-download preference', async t => {
  const app = await fixture(t);
  await app.server.continuousDownload.start({ download: true });
  const response = await fetch(`${app.base}/api/continuous/selection/page/2`);
  assert.equal(response.status, 200);
  const selected = await response.json();
  assert.match(selected.audioUrl, /^\/api\/continuous\/audio\/page\/2\?v=[a-f0-9]{16}$/);
  assert.equal(selected.duration, 3.8);
  assert.equal(selected.clips, undefined);
  const status = await (await fetch(`${app.base}/api/continuous/offline-status`)).json();
  assert.deepEqual(status, { state: 'choice', preference: 'ask', completed: 0, total: 2, bytes: 0, totalBytes: 512, units: 'surahs' });
  assert.equal(app.requests(), 0);
  for (const path of ['/selection/page/0', '/audio/page/605', '/selection/surah/115', '/audio/page/3', '/surah/999', '/audio/ayah/1']) {
    assert.equal((await fetch(`${app.base}/api/continuous${path}`)).status, 400, path);
  }
  assert.equal(app.requests(), 0);
  assert.equal((await fetch(`${app.base}/api/continuous/offline-download/resume`)).status, 405);
  assert.equal((await fetch(`${app.base}/api/continuous/offline-download/resume`, {
    method: 'POST', headers: { Origin: 'https://example.com' },
  })).status, 403);
  assert.equal((await fetch(`${app.base}/api/continuous/offline-download/as-needed`, { method: 'POST', body: 'x'.repeat(1025) })).status, 413);
});

test('a full original recording downloads once, supports seeking and remains playable offline', async t => {
  const app = await fixture(t);
  const responses = await Promise.all([
    fetch(`${app.base}/api/continuous/surah/1`),
    fetch(`${app.base}/api/continuous/audio/surah/1`),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), shapedMp3);
  }
  assert.equal(app.requests(), 1);
  assert.deepEqual(await readdir(`${app.cacheDir}-continuous`), ['001.mp3']);
  app.disconnect();
  const range = await fetch(`${app.base}/api/continuous/audio/surah/1`, { headers: { Range: 'bytes=0-2' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'ID3');
  assert.equal((await fetch(`${app.base}/api/continuous/audio/surah/1`, { headers: { Range: 'bytes=256-' } })).status, 416);
  const head = await fetch(`${app.base}/api/continuous/surah/1`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.deepEqual(await (await fetch(`${app.base}/api/continuous/audio-cache`)).json(), { files: ['001'], bytes: 256 });
  assert.equal(app.requests(), 1);
});

test('switching to as-needed remembers the new choice without downloading the entire collection', async t => {
  const app = await fixture(t);
  const response = await fetch(`${app.base}/api/continuous/offline-download/as-needed`, { method: 'POST' });
  assert.equal((await response.json()).preference, 'as-needed');
  await fetch(`${app.base}/api/continuous/surah/1`);
  assert.equal(app.requests(), 1);
  assert.deepEqual(JSON.parse(await readFile(join(app.rootDir, '.cache/continuous-offline-download.json'), 'utf8')), { preference: 'as-needed', paused: false });
  const legacy = JSON.parse(await readFile(join(app.rootDir, '.cache/offline-download.json'), 'utf8'));
  assert.equal(legacy.preference, 'all');
  const status = await (await fetch(`${app.base}/api/continuous/offline-status`)).json();
  assert.equal(status.state, 'on-demand');
  assert.equal(status.completed, 1);
});

test('the explicit full-download choice saves every source and reports surah progress', async t => {
  const app = await fixture(t);
  const first = await fetch(`${app.base}/api/continuous/offline-download/resume`, { method: 'POST' });
  assert.equal((await first.json()).preference, 'all');
  let status;
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await (await fetch(`${app.base}/api/continuous/offline-status`)).json();
    if (status.state === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.state, 'complete');
  assert.equal(status.completed, 2);
  assert.equal(status.units, 'surahs');
  assert.equal(app.requests(), 2);
});

test('malformed or truncated source downloads leave no cache entry and can be retried', async t => {
  let attempt = 0;
  const app = await fixture(t, { fetchImpl: async () => {
    attempt++;
    if (attempt === 1) return new Response(Buffer.alloc(256));
    if (attempt === 2) return new Response(shapedMp3.subarray(0, 255));
    if (attempt === 3) return new Response(shapedMp3, { headers: { 'content-length': '257' } });
    return new Response(shapedMp3);
  } });
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${app.base}/api/continuous/surah/1`);
    assert.equal(response.status, 502);
    assert.deepEqual(await readdir(`${app.cacheDir}-continuous`), []);
  }
  assert.equal((await fetch(`${app.base}/api/continuous/surah/1`)).status, 200);
});

test('real page audio is one decodable clip, preserves final tails across surahs and is derived offline', async t => {
  const app = await fixture(t, { realAudio: true });
  // Download the original sources first, as the save-for-offline control does.
  for (const number of [1, 2]) assert.equal((await fetch(`${app.base}/api/continuous/surah/${number}`)).status, 200);
  app.disconnect();
  const responses = await Promise.all([
    fetch(`${app.base}/api/continuous/audio/page/2`),
    fetch(`${app.base}/api/continuous/audio/page/2`),
  ]);
  const bytes = [];
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    bytes.push(Buffer.from(await response.arrayBuffer()));
  }
  assert.deepEqual(bytes[0], bytes[1]);
  const pagePath = join(app.rootDir, 'page2.mp3');
  await writeFile(pagePath, bytes[0]);
  const { stdout } = await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', pagePath,
    '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '1', '-ar', '8000', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  const duration = stdout.length / 4 / 8000;
  assert.ok(Math.abs(duration - 3.8) < 0.05, `Whole page duration ${duration} retains both recordings' tails`);
  let tailEnergy = 0;
  for (let offset = stdout.length - 8000; offset < stdout.length; offset += 4) tailEnergy += stdout.readFloatLE(offset) ** 2;
  assert.ok(tailEnergy > 0.1, 'The final audible tail is preserved beyond the final ayah timestamp');
  const firstPage = await fetch(`${app.base}/api/continuous/audio/page/1`);
  assert.equal(firstPage.status, 200);
  const range = await fetch(`${app.base}/api/continuous/audio/page/2`, { headers: { Range: 'bytes=0-2' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'ID3');
  assert.equal(app.requests(), 2, 'Derived pages need no upstream requests after the sources are saved');
  const versions = await readdir(`${app.cacheDir}-continuous/pages`);
  assert.equal(versions.length, 1);
  assert.deepEqual((await readdir(join(`${app.cacheDir}-continuous/pages`, versions[0]))).sort(), ['001.mp3', '001.mp3.json', '002.mp3', '002.mp3.json']);
});
