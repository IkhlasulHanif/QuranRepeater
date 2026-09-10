import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const dataUrl = new URL('../public/data/', import.meta.url);
const quran = JSON.parse(await readFile(new URL('quran.json', dataUrl), 'utf8'));
const expected = new Set(quran.ayahs.map(ayah => `${String(ayah.surah).padStart(3, '0')}${String(ayah.numberInSurah).padStart(3, '0')}`));
const url = 'https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/';
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`Recitation index returned HTTP ${response.status}`);
const html = await response.text();
const files = {};
for (const match of html.matchAll(/<tr class="file">([\s\S]*?)<\/tr>/g)) {
  const filename = /<span class="name">(\d{6})\.mp3<\/span>/.exec(match[1]);
  const length = /<td data-order="(\d+)">/.exec(match[1]);
  if (filename && length && expected.has(filename[1])) {
    const size = Number(length[1]);
    if (!Number.isSafeInteger(size) || size < 3) throw new Error(`Invalid file size for ${filename[1]}`);
    files[filename[1]] = size;
  }
}
if (expected.size !== 6236 || Object.keys(files).length !== expected.size || [...expected].some(key => !files[key])) {
  throw new Error('Audio index is incomplete. Existing manifest has not been changed.');
}
const totalBytes = Object.values(files).reduce((total, bytes) => total + bytes, 0);
const manifest = {
  source: { url, retrievedAt: new Date().toISOString(), listingSha256: createHash('sha256').update(html).digest('hex') },
  totalBytes, files,
};
await writeFile(new URL('audio-manifest.json', dataUrl), JSON.stringify(manifest) + '\n');
console.log(`Verified ${expected.size} recordings, ${totalBytes.toLocaleString()} bytes. Audio manifest saved.`);
