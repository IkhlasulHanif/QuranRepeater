import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const dataUrl = new URL('../public/data/', import.meta.url);
const quran = JSON.parse(await readFile(new URL('quran.json', dataUrl), 'utf8'));
const audioBaseUrl = 'https://server11.mp3quran.net/yasser/';
const timingBaseUrl = 'https://mp3quran.net/api/v3/ayat_timing';
const read = 92;
const sha256 = text => createHash('sha256').update(text).digest('hex');

async function request(url, options = {}) {
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      return response;
    } catch (cause) { error = cause; }
  }
  throw error;
}

async function range(url, start, end) {
  const response = await request(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`${url}: the server did not honor a bounded audio byte request.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function frameHeader(buffer, index) {
  if (index + 4 > buffer.length) return null;
  const bits = buffer.readUInt32BE(index);
  const version = (bits >>> 19) & 3;
  const bitrateIndex = (bits >>> 12) & 15;
  const sampleRateIndex = (bits >>> 10) & 3;
  if ((bits >>> 21) !== 2047 || version === 1 || ((bits >>> 17) & 3) !== 1 ||
      bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const bitrates = version === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrate = bitrates[bitrateIndex];
  const sampleRate = [44100, 48000, 32000][sampleRateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((bits >>> 9) & 1);
  const mono = ((bits >>> 6) & 3) === 3;
  return { version, bitrate, sampleRate, samples, length, sideInfo: version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17) };
}

async function recordingInfo(url, bytes) {
  let prefix = await range(url, 0, Math.min(bytes - 1, 65535));
  let offset = 0;
  if (prefix.toString('ascii', 0, 3) === 'ID3') {
    offset = 10 + ((prefix[6] & 127) << 21) + ((prefix[7] & 127) << 14) + ((prefix[8] & 127) << 7) + (prefix[9] & 127);
  }
  let base = 0;
  if (offset + 4096 > prefix.length) {
    base = offset;
    prefix = await range(url, offset, Math.min(bytes - 1, offset + 8191));
  }
  let frame;
  let index = offset - base;
  for (; index < prefix.length - 4; index++) {
    const candidate = frameHeader(prefix, index);
    if (candidate && frameHeader(prefix, index + candidate.length)) { frame = candidate; break; }
  }
  if (!frame) throw new Error(`${url}: no verified MPEG layer III audio frames.`);
  const xing = index + 4 + frame.sideInfo;
  const tag = prefix.toString('ascii', xing, xing + 4);
  if (tag === 'Xing' || tag === 'Info') {
    const flags = prefix.readUInt32BE(xing + 4);
    if (flags & 1) {
      const frames = prefix.readUInt32BE(xing + 8);
      if (frames > 0) return { recordingDuration: frames * frame.samples / frame.sampleRate, recordingDurationMethod: 'MP3 Xing frame count' };
    }
  }
  const vbri = index + 36;
  if (prefix.toString('ascii', vbri, vbri + 4) === 'VBRI') {
    const frames = prefix.readUInt32BE(vbri + 14);
    if (frames > 0) return { recordingDuration: frames * frame.samples / frame.sampleRate, recordingDurationMethod: 'MP3 VBRI frame count' };
  }
  let cursor = index;
  for (let count = 0; count < 5; count++) {
    const nextFrame = frameHeader(prefix, cursor);
    if (!nextFrame || nextFrame.bitrate !== frame.bitrate || nextFrame.sampleRate !== frame.sampleRate) {
      throw new Error(`${url}: variable bitrate audio requires a frame-count header.`);
    }
    cursor += nextFrame.length;
  }
  const tail = await range(url, Math.max(0, bytes - 160), bytes - 1);
  const id3v1 = tail.toString('ascii', tail.length - 128, tail.length - 125) === 'TAG' ? 128 : 0;
  const payloadBytes = bytes - (base + index) - id3v1;
  const frameSeconds = frame.samples / frame.sampleRate;
  // A byte-length CBR estimate can differ by a fraction of one padded frame.
  // Round upwards so a page ending with this surah never trims its final tail.
  const duration = payloadBytes * 8 / (frame.bitrate * 1000);
  return { recordingDuration: Math.ceil(duration / frameSeconds) * frameSeconds, recordingDurationMethod: 'CBR byte-length estimate, rounded up to an MP3 frame' };
}

if (quran.surahs.length !== 114 || quran.ayahs.length !== 6236) throw new Error('The local Quran is incomplete.');
const listing = await (await request(audioBaseUrl)).text();
const sizes = new Map();
for (const match of listing.matchAll(/href="(\d{3})\.mp3"[^\n]*?\s(\d+)\r?$/gm)) {
  sizes.set(Number(match[1]), Number(match[2]));
}
if (sizes.size !== 114) throw new Error('The continuous audio directory must contain all 114 surahs.');

const pageDifferences = [];
const timingGaps = [];
const durationOverruns = [];
const surahs = new Array(114);
let next = 0;
async function worker() {
  while (next < quran.surahs.length) {
    const surah = quran.surahs[next++];
    const number = surah.number;
    const url = `${timingBaseUrl}?surah=${number}&read=${read}`;
    const audioUrl = `${audioBaseUrl}${String(number).padStart(3, '0')}.mp3`;
    const [timingResponse, audioResponse] = await Promise.all([request(url), request(audioUrl, { method: 'HEAD' })]);
    const rawTimings = await timingResponse.text();
    const timings = JSON.parse(rawTimings);
    const expected = quran.ayahs.filter(ayah => ayah.surah === number);
    const bytes = Number(audioResponse.headers.get('content-length'));
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes !== sizes.get(number)) {
      throw new Error(`Surah ${number}: the audio Content-Length does not match its directory entry.`);
    }
    if (!audioResponse.headers.get('content-type')?.startsWith('audio/')) {
      throw new Error(`Surah ${number}: the provider did not return audio.`);
    }
    if (!Array.isArray(timings) || timings.length !== expected.length || expected.length !== surah.numberOfAyahs) {
      throw new Error(`Surah ${number}: the timing count does not match the Quran.`);
    }
    const ayahs = timings.map((timing, index) => {
      const ayah = expected[index];
      if (timing.ayah !== ayah.numberInSurah || timing.ayah !== index + 1) {
        throw new Error(`Surah ${number}: missing, duplicate, or misordered ayah at position ${index + 1}.`);
      }
      const start = timing.start_time;
      const end = timing.end_time;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
        throw new Error(`Surah ${number}:${timing.ayah}: invalid timing interval.`);
      }
      if (index && start < timings[index - 1].end_time) {
        throw new Error(`Surah ${number}:${timing.ayah}: overlapping timing intervals.`);
      }
      if (index && start > timings[index - 1].end_time) {
        timingGaps.push({ surah: number, afterAyah: index, milliseconds: start - timings[index - 1].end_time });
      }
      const sourcePage = Number(/\/(\d+)\.svg$/.exec(timing.page ?? '')?.[1]);
      if (!Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > 604) {
        throw new Error(`Surah ${number}:${timing.ayah}: invalid provider page reference.`);
      }
      if (sourcePage !== ayah.page) {
        pageDifferences.push({ surah: number, ayah: timing.ayah, sourcePage, page: ayah.page });
      }
      // Keep the reader's independently checked Tanzil page mapping. The provider's
      // SVG layout sometimes assigns an ayah to a different printed page.
      return { numberInSurah: timing.ayah, start: start / 1000, end: end / 1000, page: ayah.page };
    });
    const recording = await recordingInfo(audioUrl, bytes);
    if (recording.recordingDuration + 1 < ayahs.at(-1).end) {
      throw new Error(`Surah ${number}: final ayah ends after its actual recording (${ayahs.at(-1).end} > ${recording.recordingDuration}).`);
    }
    if (recording.recordingDuration < ayahs.at(-1).end) {
      // Source end markers can extend slightly past EOF. Retain the unmodified
      // marker and report it; playback of a surah's final segment must use EOF.
      durationOverruns.push({ surah: number, end: ayahs.at(-1).end, recordingDuration: recording.recordingDuration });
    }
    surahs[number - 1] = {
      number, bytes,
      // This is the end of the selected Quran recitation, not the MP3's duration.
      // Files may contain silence or other recording material after the last ayah.
      duration: ayahs.at(-1).end,
      ...recording,
      timingSha256: sha256(rawTimings),
      ayahs,
    };
    if (surahs.filter(Boolean).length % 20 === 0) console.log(`Verified ${surahs.filter(Boolean).length} of 114 surahs.`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const count = surahs.reduce((total, surah) => total + surah.ayahs.length, 0);
if (count !== 6236 || surahs.some((surah, index) => surah.number !== index + 1)) {
  throw new Error('The continuous audio timing collection is incomplete.');
}
pageDifferences.sort((a, b) => a.surah - b.surah || a.ayah - b.ayah);
timingGaps.sort((a, b) => a.surah - b.surah || a.afterAyah - b.afterAyah);
durationOverruns.sort((a, b) => a.surah - b.surah);
const manifest = {
  source: {
    name: 'MP3Quran — Sheikh Yasser Al-Dosari, Hafs an Asim',
    url: 'https://www.mp3quran.net/eng/api',
    rightsUrl: 'https://www.mp3quran.net/eng/privacy',
    audioBaseUrl, timingBaseUrl, read,
    retrievedAt: new Date().toISOString(),
    listingSha256: sha256(listing),
    timestampUnit: 'seconds',
    durationMeaning: 'End of the final ayah; not the complete MP3 duration.',
    pageMapping: 'quran.json (Tanzil/Al Quran Cloud 604-page Madani mapping)',
    pageDifferences,
    timingGaps,
    durationOverruns,
  },
  totalBytes: surahs.reduce((total, surah) => total + surah.bytes, 0),
  surahs,
};
const destination = new URL('continuous-audio.json', dataUrl);
const temporary = new URL('continuous-audio.json.tmp', dataUrl);
await writeFile(temporary, JSON.stringify(manifest) + '\n');
await rename(temporary, destination);
console.log(`Saved ${surahs.length} surahs, ${count} ayah timings, ${manifest.totalBytes.toLocaleString()} audio bytes.`);
console.log(`Provider differences preserved for review: ${pageDifferences.length} page assignments, ${timingGaps.length} timing gaps, and ${durationOverruns.length} final markers extending less than one second beyond EOF.`);
