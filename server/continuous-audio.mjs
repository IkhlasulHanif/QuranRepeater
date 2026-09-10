import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import { createOfflineDownload } from './offline-download.mjs';

const MAX_SOURCE_BYTES = 160 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const TRANSCODE_TIMEOUT_MS = 2 * 60_000;
const PREFIX = '/api/continuous';
const key = number => String(number).padStart(3, '0');
const seconds = number => Math.round(number * 1_000_000) / 1_000_000;
const mp3Header = bytes => bytes.length >= 3 && (bytes.subarray(0, 3).toString() === 'ID3' ||
  (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));

function limitConcurrency(limit, signal) {
  let running = 0;
  const queue = [];
  function pump() {
    while (running < limit && queue.length) {
      const job = queue.shift();
      if (signal.aborted) { job.reject(new Error('The local server has stopped.')); continue; }
      running++;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { running--; pump(); });
    }
  }
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
}

/** A continuous recording is cut only at the selected page's outer boundaries.
 * Ayah timestamps drive highlighting; they never splice the recording itself.
 */
export function buildContinuousSelection(quran, manifest, mode, number) {
  const selected = quran.ayahs.filter(ayah => mode === 'page' ? ayah.page === number : ayah.surah === number);
  if (!selected.length) return null;
  const sources = new Map(manifest.surahs.map(surah => [surah.number, surah]));
  const groups = [];
  for (const verse of selected) {
    if (groups.at(-1)?.surah !== verse.surah) groups.push({ surah: verse.surah, verses: [] });
    groups.at(-1).verses.push(verse);
  }
  let duration = 0;
  const verses = [];
  const clips = [];
  for (const group of groups) {
    const source = sources.get(group.surah);
    if (!source) throw new Error('The continuous recitation metadata is incomplete.');
    const timings = new Map(source.ayahs.map(ayah => [ayah.numberInSurah, ayah]));
    const first = timings.get(group.verses[0].numberInSurah);
    const last = timings.get(group.verses.at(-1).numberInSurah);
    if (!first || !last) throw new Error('The continuous recitation timings are incomplete.');
    // Include the opening basmala, and keep the natural pause preceding the next page.
    const start = first.numberInSurah === 1 ? 0 : first.start;
    const next = timings.get(last.numberInSurah + 1);
    const end = next?.start ?? source.recordingDuration ?? last.end;
    const offset = mode === 'surah' ? start : duration;
    clips.push({ surah: group.surah, start, end, toEnd: !next });
    for (const verse of group.verses) {
      const timing = timings.get(verse.numberInSurah);
      if (!timing) throw new Error('The continuous recitation timings are incomplete.');
      verses.push({
        number: verse.number, surah: verse.surah, numberInSurah: verse.numberInSurah,
        start: seconds(offset + (verse.numberInSurah === 1 ? 0 : timing.start) - start),
        end: seconds(offset + Math.min(timing.end, end) - start),
      });
    }
    duration += end - start;
  }
  return { audioUrl: `${PREFIX}/audio/${mode}/${number}`, duration: seconds(duration), verses, clips };
}

export function createContinuousAudio({
  rootDir, cacheDir, fetchImpl, shutdownSignal, HttpError, sendJson, streamFile, consumeSmallBody,
  offlineDownloadOptions = {},
}) {
  const sourceDir = `${cacheDir}-continuous`;
  const stateFile = join(dirname(cacheDir), `${basename(cacheDir) === 'audio' ? '' : `${basename(cacheDir)}-`}continuous-offline-download.json`);
  const pendingSources = new Map();
  const pendingPages = new Map();
  const limitDownloads = limitConcurrency(3, shutdownSignal);
  const limitTranscodes = limitConcurrency(2, shutdownSignal);
  let catalogPromise;
  let offlineDownload;

  async function catalog() {
    if (!catalogPromise) catalogPromise = (async () => {
      const [raw, quranRaw] = await Promise.all([
        readFile(join(rootDir, 'public/data/continuous-audio.json'), 'utf8'),
        readFile(join(rootDir, 'public/data/quran.json'), 'utf8'),
      ]);
      const manifest = JSON.parse(raw);
      const quran = JSON.parse(quranRaw);
      const audioBase = new URL(manifest.source.audioBaseUrl);
      if (audioBase.protocol !== 'https:' || audioBase.username || audioBase.password || !Array.isArray(manifest.surahs) || !manifest.surahs.length) throw new Error('Invalid manifest');
      const sources = new Map();
      for (const source of manifest.surahs) {
        if (!Number.isInteger(source.number) || source.number < 1 || source.number > 114 || sources.has(key(source.number)) ||
            !Number.isSafeInteger(source.bytes) || source.bytes < 3 || source.bytes > MAX_SOURCE_BYTES ||
            !Number.isFinite(source.duration) || source.duration <= 0 || !source.ayahs?.length) throw new Error('Invalid source');
        let previousEnd = 0;
        for (let i = 0; i < source.ayahs.length; i++) {
          const ayah = source.ayahs[i];
          if (ayah.numberInSurah !== i + 1 || !Number.isFinite(ayah.start) || !Number.isFinite(ayah.end) ||
              ayah.start < previousEnd - 0.001 || ayah.end <= ayah.start || ayah.end > source.duration + 0.001) throw new Error('Invalid timings');
          previousEnd = ayah.end;
        }
        sources.set(key(source.number), source);
      }
      for (const ayah of quran.ayahs) if (!sources.get(key(ayah.surah))?.ayahs[ayah.numberInSurah - 1]) throw new Error('Missing ayah');
      return { quran, manifest, sources, audioBase,
        version: createHash('sha256').update(raw).update('\0').update(quranRaw).digest('hex').slice(0, 16) };
    })().catch(() => {
      catalogPromise = undefined;
      throw new HttpError(503, 'The continuous recitation metadata is unavailable. Restore public/data/continuous-audio.json.');
    });
    return catalogPromise;
  }

  async function validMp3(path, expectedSize) {
    let file;
    try {
      file = await open(path, 'r');
      const info = await file.stat();
      if (!info.isFile() || info.size < 3 || (expectedSize !== undefined && info.size !== expectedSize)) return null;
      const header = Buffer.alloc(3);
      await file.read(header, 0, 3, 0);
      return mp3Header(header) ? { path, size: info.size } : null;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
    finally { await file?.close(); }
  }

  async function cachedSource(filename) {
    const source = (await catalog()).sources.get(filename);
    return source ? validMp3(join(sourceDir, `${filename}.mp3`), source.bytes) : null;
  }

  async function downloadSource(filename) {
    const { sources, audioBase } = await catalog();
    const source = sources.get(filename);
    if (!source) throw new HttpError(400, 'Choose a valid surah.');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, shutdownSignal]);
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const temporary = join(sourceDir, `.${filename}.${randomUUID()}.tmp`);
    const destination = join(sourceDir, `${filename}.mp3`);
    try {
      await mkdir(sourceDir, { recursive: true });
      const upstream = await fetchImpl(new URL(`${filename}.mp3`, audioBase).href, { signal, redirect: 'error' });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        throw new HttpError(502, 'The recitation source could not provide this surah. Try again later.');
      }
      const declared = upstream.headers.get('content-length');
      if (declared !== null && Number(declared) !== source.bytes) {
        await upstream.body.cancel();
        throw new HttpError(502, 'The continuous recitation download did not match its expected size.');
      }
      let length = 0;
      const counter = new Transform({ transform(chunk, encoding, callback) {
        length += chunk.length;
        callback(length > source.bytes ? new HttpError(502, 'The continuous recitation download was unexpectedly large.') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(upstream.body), counter, createWriteStream(temporary, { flags: 'wx' }), { signal });
      if (length !== source.bytes || !await validMp3(temporary, source.bytes)) {
        throw new HttpError(502, 'The continuous recitation download was incomplete. Try again.');
      }
      await rename(temporary, destination);
      const file = { path: destination, size: source.bytes };
      offlineDownload.noteCached(filename, file);
      return file;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) throw new HttpError(504, 'Saving this surah took too long. Check your connection and try again.');
      throw new HttpError(503, 'This continuous surah is not saved yet. Connect to the internet to download it.');
    } finally {
      clearTimeout(timeout);
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function ensureSource(filename) {
    const cached = await cachedSource(filename);
    if (cached) { offlineDownload.noteCached(filename, cached); return cached; }
    if (!pendingSources.has(filename)) {
      const task = limitDownloads(() => downloadSource(filename));
      pendingSources.set(filename, task);
      task.then(() => pendingSources.delete(filename), () => pendingSources.delete(filename));
    }
    return pendingSources.get(filename);
  }

  async function selection(mode, number) {
    const { quran, manifest, version } = await catalog();
    const result = buildContinuousSelection(quran, manifest, mode, number);
    if (!result) throw new HttpError(400, 'Choose a valid Quran page or surah.');
    return { ...result, audioUrl: `${result.audioUrl}?v=${version}` };
  }

  function transcode(clips, files, destination) {
    if (!ffmpegPath) throw new HttpError(503, 'The audio processor is unavailable. Run npm run init to restore it.');
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      // Input seeking is accurate when re-encoding and avoids decoding hours of
      // a long surah merely to reach a page near its end.
      args.push('-ss', String(clip.start));
      if (!clip.toEnd) args.push('-t', String(seconds(clip.end - clip.start)));
      args.push('-i', files[i].path);
    }
    const filters = clips.map((clip, i) => `[${i}:a]${clip.toEnd ? '' : `atrim=duration=${seconds(clip.end - clip.start)},`}asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
    filters.push(`${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[out]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-codec:a', 'libmp3lame', '-q:a', '2', '-threads', '1', '-f', 'mp3', destination);
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TRANSCODE_TIMEOUT_MS);
      const child = spawn(ffmpegPath, args, { signal: AbortSignal.any([controller.signal, shutdownSignal]), stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.resume();
      child.once('error', () => { clearTimeout(timeout); reject(new HttpError(503, 'The continuous page could not be prepared. Try again.')); });
      child.once('close', code => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new HttpError(502, 'The continuous page could not be prepared from the saved recording. Try again.'));
      });
    });
  }

  async function ensurePage(number) {
    const { version } = await catalog();
    const directory = join(sourceDir, 'pages', version);
    const destination = join(directory, `${key(number)}.mp3`);
    const metadataPath = `${destination}.json`;
    const existingSize = await readFile(metadataPath, 'utf8').then(JSON.parse).then(value => value.bytes).catch(() => undefined);
    if (Number.isSafeInteger(existingSize)) {
      const existing = await validMp3(destination, existingSize);
      if (existing) return existing;
    }
    if (!pendingPages.has(number)) {
      const task = (async () => {
        const { clips } = await selection('page', number);
        const files = await Promise.all(clips.map(clip => ensureSource(key(clip.surah))));
        return limitTranscodes(async () => {
          await mkdir(directory, { recursive: true });
          const temporary = join(directory, `.${key(number)}.${randomUUID()}.tmp`);
          const temporaryMetadata = `${temporary}.json`;
          try {
            await transcode(clips, files, temporary);
            const file = await validMp3(temporary);
            if (!file) throw new HttpError(502, 'The prepared page audio was incomplete. Try again.');
            await writeFile(temporaryMetadata, JSON.stringify({ bytes: file.size }), { flag: 'wx' });
            await rename(temporary, destination);
            await rename(temporaryMetadata, metadataPath);
            return { path: destination, size: file.size };
          } finally {
            await Promise.all([temporary, temporaryMetadata].map(path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; })));
          }
        });
      })();
      pendingPages.set(number, task);
      task.then(() => pendingPages.delete(number), () => pendingPages.delete(number));
    }
    return pendingPages.get(number);
  }

  offlineDownload = createOfflineDownload({
    ...offlineDownloadOptions,
    getFilenames: async () => [...(await catalog()).sources.keys()],
    getCachedFile: cachedSource,
    getTotalBytes: async () => [...(await catalog()).sources.values()].reduce((total, source) => total + source.bytes, 0),
    ensureAudio: ensureSource,
    stateFile,
  });
  const withUnits = status => ({ ...status, units: 'surahs' });

  return {
    offlineDownload,
    start: options => offlineDownload.start(options),
    async stop() {
      await offlineDownload.stop();
      await Promise.allSettled([...pendingSources.values(), ...pendingPages.values()]);
    },
    async handle(pathname, request, response) {
      if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
      const action = { resume: 'resume', pause: 'pause', 'as-needed': 'asNeeded' }[pathname.slice(`${PREFIX}/offline-download/`.length)];
      if (pathname.startsWith(`${PREFIX}/offline-download/`) && action) {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new HttpError(405, 'Use POST to change the offline download.'); }
        await consumeSmallBody(request);
        sendJson(response, 200, withUnits(await offlineDownload[action]()));
        return true;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'This address accepts only GET or HEAD requests.');
      }
      const head = request.method === 'HEAD';
      if (pathname === `${PREFIX}/offline-status`) sendJson(response, 200, withUnits(await offlineDownload.getStatus()), head);
      else if (pathname === `${PREFIX}/audio-cache`) {
        const { sources } = await catalog();
        const entries = await Promise.all([...sources.keys()].map(async filename => [filename, await cachedSource(filename)]));
        const saved = entries.filter(([, file]) => file);
        sendJson(response, 200, { files: saved.map(([filename]) => filename), bytes: saved.reduce((sum, [, file]) => sum + file.size, 0) }, head);
      } else {
        const match = /^\/api\/continuous\/(selection|audio)\/(page|surah)\/([1-9]\d{0,2})$/.exec(pathname);
        const surahMatch = /^\/api\/continuous\/surah\/([1-9]\d{0,2})$/.exec(pathname);
        if (match) {
          const [, kind, mode, rawNumber] = match;
          const number = Number(rawNumber);
          if (number > (mode === 'page' ? 604 : 114)) throw new HttpError(400, 'Choose a valid Quran page or surah.');
          const result = await selection(mode, number);
          if (kind === 'selection') {
            const { clips, ...metadata } = result;
            sendJson(response, 200, metadata, head);
          } else await streamFile(request, response, mode === 'surah' ? await ensureSource(key(number)) : await ensurePage(number), { audio: true });
        } else if (surahMatch && Number(surahMatch[1]) <= 114) {
          const filename = key(Number(surahMatch[1]));
          if (!(await catalog()).sources.has(filename)) throw new HttpError(400, 'Choose a valid surah.');
          await streamFile(request, response, await ensureSource(filename), { audio: true });
        } else throw new HttpError(400, 'Choose a valid continuous recitation address.');
      }
      return true;
    },
  };
}
