import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { createOfflineDownload } from './offline-download.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_BASE_URL = 'https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/';
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 60_000;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body, head = false) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
  });
  response.end(head ? undefined : encoded);
}

function safeRequestPath(requestUrl, dev = false) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.split('?')[0]);
  } catch {
    throw new HttpError(400, 'The requested address is invalid.');
  }
  const parts = pathname.split('/');
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') ||
      parts.some((part, index) => part.startsWith('.') && !(dev && part === '.vite' &&
        index === 2 && parts[1] === 'node_modules' && parts[3] === 'deps'))) {
    throw new HttpError(400, 'The requested address is invalid.');
  }
  return pathname;
}

function trustedRequest(request, pathname) {
  let host;
  try {
    host = new URL(`http://${request.headers.host}`);
  } catch {
    return false;
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || host.username || host.password) {
    return false;
  }
  if (pathname.startsWith('/api/')) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (request.headers.origin && request.headers.origin !== host.origin) return false;
  }
  return true;
}

function isWithin(root, path) {
  const difference = relative(root, path);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

async function findStaticFile(directory, pathname) {
  const candidate = resolve(directory, `.${pathname}`);
  if (!isWithin(directory, candidate)) return null;
  try {
    const [actualRoot, actualFile] = await Promise.all([realpath(directory), realpath(candidate)]);
    if (!isWithin(actualRoot, actualFile)) return null;
    const info = await stat(actualFile);
    return info.isFile() ? { path: actualFile, size: info.size } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return null;
    throw error;
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function streamFile(request, response, file, { audio = false } = {}) {
  const headers = {
    'Content-Type': audio ? 'audio/mpeg' : MIME_TYPES[extname(file.path)] || 'application/octet-stream',
    'Cache-Control': audio ? 'private, max-age=31536000, immutable' : 'no-cache',
  };
  let range;
  if (audio) {
    headers['Accept-Ranges'] = 'bytes';
    range = parseRange(request.headers.range, file.size);
    if (range === false) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}`, 'Content-Length': 0 });
      response.end();
      return;
    }
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else {
    headers['Content-Length'] = file.size;
  }
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await pipeline(createReadStream(file.path, range || {}), response);
}

function looksLikeMp3(bytes) {
  return bytes.length >= 3 && (bytes.subarray(0, 3).equals(Buffer.from('ID3')) ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
}

async function downloadAudio(url, fetchImpl, shutdownSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);
  try {
    const upstream = await fetchImpl(url, { signal: AbortSignal.any([controller.signal, shutdownSignal]), redirect: 'error' });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      throw new HttpError(502, 'The recitation source could not provide this verse. Please try again later.');
    }
    const declaredLength = Number(upstream.headers.get('content-length'));
    if (declaredLength > MAX_AUDIO_BYTES) {
      await upstream.body.cancel();
      throw new HttpError(502, 'The recitation download was unexpectedly large. Please try again later.');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of upstream.body) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_AUDIO_BYTES) {
        controller.abort();
        throw new HttpError(502, 'The recitation download was unexpectedly large. Please try again later.');
      }
      chunks.push(bytes);
    }
    const result = Buffer.concat(chunks, length);
    if (!looksLikeMp3(result) || (declaredLength > 0 && declaredLength !== length)) {
      throw new HttpError(502, 'The recitation download was incomplete. Please try again.');
    }
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) {
      throw new HttpError(504, 'The recitation download took too long. Check your connection and try again.');
    }
    throw new HttpError(503, 'This verse is not saved yet. Connect to the internet to download its recitation.');
  } finally {
    clearTimeout(timeout);
  }
}

/** Create the local app server without listening, so callers can choose a free test port. */
export async function createAppServer({
  rootDir = PROJECT_ROOT,
  cacheDir = join(rootDir, '.cache', 'audio'),
  fetchImpl = globalThis.fetch,
  dev = false,
  autoDownload = false,
  offlineDownloadOptions = {},
} = {}) {
  rootDir = resolve(rootDir);
  cacheDir = resolve(cacheDir);
  const pendingDownloads = new Map();
  const shutdown = new AbortController();
  let verseIds;
  let audioManifest;
  let vite;
  let offlineDownload;

  async function loadVerseIds() {
    if (verseIds) return verseIds;
    let data;
    try {
      data = JSON.parse(await readFile(join(rootDir, 'public', 'data', 'quran.json'), 'utf8'));
    } catch {
      throw new HttpError(503, 'The local Quran text is unavailable. Please restore public/data/quran.json.');
    }
    verseIds = new Set();
    for (const ayah of data.ayahs || []) {
      verseIds.add(`${ayah.surah}:${ayah.numberInSurah}`);
    }
    if (!verseIds.size) {
      for (const surah of data.surahs || []) {
        for (let ayah = 1; ayah <= surah.numberOfAyahs; ayah++) verseIds.add(`${surah.number}:${ayah}`);
      }
    }
    if (!verseIds.size) {
      verseIds = undefined;
      throw new HttpError(503, 'The local Quran text could not be read. Please restore public/data/quran.json.');
    }
    return verseIds;
  }

  async function cachedAudio(filename) {
    const path = join(cacheDir, `${filename}.mp3`);
    let file;
    try {
      file = await open(path, 'r');
      const info = await file.stat();
      if (!info.isFile() || info.size < 3 || info.size > MAX_AUDIO_BYTES) return null;
      const expectedSize = (await loadAudioManifest())?.files?.[filename];
      if (expectedSize !== undefined && info.size !== expectedSize) return null;
      const header = Buffer.alloc(3);
      await file.read(header, 0, header.length, 0);
      if (looksLikeMp3(header)) return { path, size: info.size };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      await file?.close();
    }
    return null;
  }

  function loadAudioManifest() {
    if (!audioManifest) {
      audioManifest = readFile(join(rootDir, 'public', 'data', 'audio-manifest.json'), 'utf8')
        .then(JSON.parse).catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw new HttpError(503, 'The recitation manifest could not be read. Restore public/data/audio-manifest.json.');
        });
    }
    return audioManifest;
  }

  async function ensureAudio(filename) {
    const existing = await cachedAudio(filename);
    if (existing) {
      offlineDownload?.noteCached(filename, existing);
      return existing;
    }
    if (!pendingDownloads.has(filename)) {
      const download = (async () => {
        const bytes = await downloadAudio(`${AUDIO_BASE_URL}${filename}.mp3`, fetchImpl, shutdown.signal);
        const expectedSize = (await loadAudioManifest())?.files?.[filename];
        if (expectedSize !== undefined && bytes.length !== expectedSize) {
          throw new HttpError(502, 'The recitation download did not match its expected size. Please try again later.');
        }
        await mkdir(cacheDir, { recursive: true });
        const temporary = join(cacheDir, `.${filename}.${randomUUID()}.tmp`);
        const destination = join(cacheDir, `${filename}.mp3`);
        try {
          await writeFile(temporary, bytes, { flag: 'wx' });
          await rename(temporary, destination);
        } finally {
          await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
        const file = { path: destination, size: bytes.length };
        offlineDownload?.noteCached(filename, file);
        return file;
      })();
      pendingDownloads.set(filename, download);
      download.then(() => pendingDownloads.delete(filename), () => pendingDownloads.delete(filename));
    }
    return pendingDownloads.get(filename);
  }

  offlineDownload = createOfflineDownload({
    ...offlineDownloadOptions,
    getFilenames: async () => [...await loadVerseIds()].map((id) => id.split(':').map((part) => part.padStart(3, '0')).join('')),
    getCachedFile: cachedAudio,
    getTotalBytes: async (filenames) => {
      const manifest = await loadAudioManifest();
      if (!manifest || !filenames.every((filename) => Number.isSafeInteger(manifest.files?.[filename]) && manifest.files[filename] > 0)) return undefined;
      return filenames.reduce((total, filename) => total + manifest.files[filename], 0);
    },
    ensureAudio,
    stateFile: join(dirname(cacheDir), 'offline-download.json'),
  });

  async function consumeSmallBody(request) {
    let bytes = 0;
    if (Number(request.headers['content-length']) > 1024) throw new HttpError(413, 'This request is too large.');
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024) throw new HttpError(413, 'This request is too large.');
    }
  }

  async function handler(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const pathname = safeRequestPath(request.url || '/', dev);
      if (!trustedRequest(request, pathname)) {
        throw new HttpError(403, 'This app is available only from its local address.');
      }
      if (pathname === '/api/offline-download/pause' || pathname === '/api/offline-download/resume') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          throw new HttpError(405, 'Use POST to change the offline download.');
        }
        await consumeSmallBody(request);
        const action = pathname.endsWith('/pause') ? 'pause' : 'resume';
        sendJson(response, 200, await offlineDownload[action]());
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'This address accepts only GET or HEAD requests.');
      }
      if (pathname === '/api/health') {
        sendJson(response, 200, { ok: true, localOnly: true }, request.method === 'HEAD');
        return;
      }
      if (pathname === '/api/offline-status') {
        sendJson(response, 200, await offlineDownload.getStatus(), request.method === 'HEAD');
        return;
      }
      if (pathname === '/api/audio-cache') {
        const entries = await readdir(cacheDir).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        const files = [];
        let bytes = 0;
        for (const entry of entries.sort()) {
          if (!/^\d{6}\.mp3$/.test(entry)) continue;
          const cached = await cachedAudio(entry.slice(0, 6));
          if (cached) {
            files.push(entry.slice(0, 6));
            bytes += cached.size;
          }
        }
        sendJson(response, 200, { files, bytes }, request.method === 'HEAD');
        return;
      }
      if (pathname.startsWith('/api/audio/')) {
        const parts = /^\/api\/audio\/(\d{1,3})\/(\d{1,3})$/.exec(pathname);
        if (!parts || !((await loadVerseIds()).has(`${Number(parts[1])}:${Number(parts[2])}`))) {
          throw new HttpError(400, 'Choose a valid surah and verse from the Quran.');
        }
        const filename = `${parts[1].padStart(3, '0')}${parts[2].padStart(3, '0')}`;
        await streamFile(request, response, await ensureAudio(filename), { audio: true });
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        throw new HttpError(404, 'This local API address does not exist.');
      }
      if (vite) {
        vite.middlewares(request, response, (error) => {
          if (error) sendJson(response, 500, { error: 'The development page could not be loaded.' });
          else sendJson(response, 404, { error: 'This page does not exist.' });
        });
        return;
      }
      const filePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      let file = await findStaticFile(join(rootDir, 'dist'), filePath) ||
        await findStaticFile(join(rootDir, 'public'), filePath);
      if (!file && !extname(pathname)) file = await findStaticFile(join(rootDir, 'dist'), '/index.html');
      if (!file) {
        throw new HttpError(404, pathname === '/' ? 'Build the website first with npm run build.' : 'This file does not exist.');
      }
      await streamFile(request, response, file);
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      sendJson(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : 'The local server could not complete this request. Please try again.',
      }, request.method === 'HEAD');
    }
  }

  const server = createServer(handler);
  server.offlineDownload = offlineDownload;
  server.once('listening', () => { void offlineDownload.start({ download: autoDownload }); });
  server.once('close', () => {
    shutdown.abort();
    void offlineDownload.stop();
  });
  if (dev) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      root: rootDir,
      appType: 'spa',
      server: { middlewareMode: true, ws: { server } },
    });
    server.once('close', () => { void vite.close(); });
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port');
  const port = Number(portFlag === -1 ? process.env.PORT || 5173 : process.argv[portFlag + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
  const server = await createAppServer({ dev: process.argv.includes('--dev'), autoDownload: true });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Open http://127.0.0.1:${port} or choose another port with --port.`
      : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Quran Repeater is ready at http://127.0.0.1:${port}`);
    console.log('The website is available on this computer only. Press Ctrl+C to stop.');
  });
  const stop = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
