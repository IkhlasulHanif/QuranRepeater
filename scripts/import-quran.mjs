#!/usr/bin/env node
/**
 * Fetch the complete Uthmani Quran and independently verify all Madani page/juz
 * boundaries against Tanzil metadata. No npm dependencies; Node.js 20+.
 * Usage: node scripts/import-quran.mjs
 *        node scripts/import-quran.mjs --check  (offline structural validation)
 * Text strings are copied verbatim. In this edition, the basmala is included in
 * the first ayah string of surahs 2–114 except surah 9.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const output = new URL('../public/data/quran.json', import.meta.url);
const textUrl = 'https://api.alquran.cloud/v1/quran/quran-uthmani';
const metadataUrl = 'https://tanzil.net/res/text/metadata/quran-data.js';
const audioBaseUrl = 'https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/';

const copyrightNotice = `Tanzil Quran Text
Copyright (C) 2007-2021 Tanzil Project
License: Creative Commons Attribution 3.0

This copy of the Quran text is carefully produced, highly
verified and continuously monitored by a group of specialists
in Tanzil Project.

TERMS OF USE:

- Permission is granted to copy and distribute verbatim copies
  of this text, but CHANGING IT IS NOT ALLOWED.

- This Quran text can be used in any website or application,
  provided that its source (Tanzil Project) is clearly indicated,
  and a link is made to tanzil.net to enable users to keep
  track of changes.

- This copyright notice shall be included in all verbatim copies
  of the text, and shall be reproduced appropriately in all files
  derived from or containing substantial portion of this text.

Please check updates at: http://tanzil.net/updates/`;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const verseKey = (ayah) => `${ayah.surah}:${ayah.numberInSurah}`;

function validate(quran) {
  assert.equal(quran.surahs.length, 114, 'Must contain 114 surahs');
  assert.equal(quran.ayahs.length, 6236, 'Must contain 6,236 ayahs');
  const pages = new Set();
  const juzs = new Set();
  let position = 0;
  for (const [index, surah] of quran.surahs.entries()) {
    assert.equal(surah.number, index + 1, 'Surah numbers must be contiguous');
    assert.ok(surah.name && surah.englishName && surah.numberOfAyahs > 0);
    for (let ayahInSurah = 1; ayahInSurah <= surah.numberOfAyahs; ayahInSurah++) {
      const ayah = quran.ayahs[position];
      assert.ok(ayah, 'Missing verse');
      assert.equal(ayah.number, position + 1, 'Global verse order is invalid');
      assert.equal(ayah.surah, surah.number, 'Surah assignment is invalid');
      assert.equal(ayah.numberInSurah, ayahInSurah, 'Verse order is invalid');
      assert.ok(typeof ayah.text === 'string' && ayah.text.trim().length > 0);
      assert.ok(Number.isInteger(ayah.page) && ayah.page >= 1 && ayah.page <= 604);
      assert.ok(Number.isInteger(ayah.juz) && ayah.juz >= 1 && ayah.juz <= 30);
      if (position > 0) {
        assert.ok(ayah.page >= quran.ayahs[position - 1].page);
        assert.ok(ayah.juz >= quran.ayahs[position - 1].juz);
      }
      pages.add(ayah.page);
      juzs.add(ayah.juz);
      position++;
    }
  }
  assert.equal(position, 6236);
  assert.equal(pages.size, 604, 'Every page must contain at least one verse');
  assert.equal(juzs.size, 30, 'Every juz must contain at least one verse');
  assert.equal(verseKey(quran.ayahs[0]), '1:1');
  assert.equal(verseKey(quran.ayahs.at(-1)), '114:6');
  assert.equal(quran.ayahs.find((a) => a.page === 2).number, 8);
  assert.equal(verseKey(quran.ayahs.find((a) => a.page === 604)), '112:1');
  if (quran.source.textSha256) {
    assert.equal(hash(quran.ayahs.map((a) => a.text).join('\n')), quran.source.textSha256,
      'Text checksum changed. Do not modify the Arabic corpus.');
  }
  return quran;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function metadataBoundaries(metadata, name, expectedCount) {
  // Parse only numeric pairs from the expected array, never execute fetched JS.
  const section = metadata.match(new RegExp(`QuranData\\.${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  assert.ok(section, `Missing Tanzil ${name} metadata`);
  const pairs = [...section[1].matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
  assert.deepEqual(pairs.pop(), [115, 1], 'Expected metadata end sentinel');
  assert.equal(pairs.length, expectedCount);
  return pairs;
}

if (process.argv.includes('--check')) {
  validate(JSON.parse(await readFile(output, 'utf8')));
  console.log('Valid: 114 surahs, 6,236 consecutive ayahs, 604 nonempty pages, 30 juz, text checksum intact.');
} else {
  const [raw, metadata, audioIndex] = await Promise.all([
    fetchText(textUrl), fetchText(metadataUrl), fetchText(audioBaseUrl),
  ]);
  const response = JSON.parse(raw);
  assert.equal(response.code, 200);
  assert.equal(response.data.edition.identifier, 'quran-uthmani');
  const ayahs = response.data.surahs.flatMap((surah) => surah.ayahs.map((ayah) => ({
    number: ayah.number,
    surah: surah.number,
    numberInSurah: ayah.numberInSurah,
    page: ayah.page,
    juz: ayah.juz,
    text: ayah.text,
  })));
  const quran = validate({
    source: {
      name: 'Tanzil Uthmani Quran via Al Quran Cloud',
      edition: 'quran-uthmani',
      textUrl,
      metadataUrl,
      attributionUrl: 'https://tanzil.net',
      licenseUrl: 'https://tanzil.net/docs/text_license',
      termsUrl: 'https://alquran.cloud/terms-and-conditions',
      copyrightNotice,
      downloadedAt: new Date().toISOString(),
      upstreamSha256: hash(raw),
      metadataSha256: hash(metadata),
      textSha256: hash(ayahs.map((a) => a.text).join('\n')),
      pageConvention: '604-page Madani mushaf (Hafs); text reflows within each page',
      basmalaConvention: 'In the source text, the unnumbered basmala is prefixed to ayah 1 of every surah except 1 and 9. Surah 1:1 is the numbered basmala. Text is stored verbatim.',
      reciter: 'Sheikh Yasser Al-Dosari',
      audioProvider: 'EveryAyah',
      audioBaseUrl,
      audioFilenamePattern: '{surah:03d}{numberInSurah:03d}.mp3',
    },
    surahs: response.data.surahs.map((surah) => ({
      number: surah.number,
      name: surah.name,
      englishName: surah.englishName,
      englishNameTranslation: surah.englishNameTranslation,
      numberOfAyahs: surah.ayahs.length,
      revelationType: surah.revelationType,
    })),
    ayahs,
  });

  const surahSection = metadata.match(/QuranData\.Sura\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(surahSection, 'Missing Tanzil surah metadata');
  const surahCounts = [...surahSection[1].matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*,/g)];
  assert.equal(surahCounts.length, 114);
  for (const [index, match] of surahCounts.entries()) {
    assert.equal(quran.surahs[index].numberOfAyahs, Number(match[2]), `Surah ${index + 1} count differs from Tanzil`);
    assert.equal(quran.ayahs.find((a) => a.surah === index + 1).number, Number(match[1]) + 1,
      `Surah ${index + 1} start differs from Tanzil`);
  }

  for (const [name, field, count] of [['Page', 'page', 604], ['Juz', 'juz', 30]]) {
    const boundaries = metadataBoundaries(metadata, name, count);
    for (const [index, [surah, numberInSurah]] of boundaries.entries()) {
      const first = quran.ayahs.find((ayah) => ayah[field] === index + 1);
      assert.equal(verseKey(first), `${surah}:${numberInSurah}`, `${name} ${index + 1} differs from Tanzil`);
    }
  }
  const audioFiles = new Set(audioIndex.match(/\b\d{6}\.mp3\b/g));
  for (const ayah of ayahs) {
    const filename = `${String(ayah.surah).padStart(3, '0')}${String(ayah.numberInSurah).padStart(3, '0')}.mp3`;
    assert.ok(audioFiles.has(filename), `EveryAyah listing is missing ${filename}`);
  }
  quran.source.validation = {
    ayahs: 6236, surahs: 114, pages: 604, juz: 30,
    allSurahCountsMatchTanzil: true,
    allPageAndJuzBoundariesMatchTanzil: true,
    everyAyahAudioFilesListed: 6236,
    audioListingSha256: hash(audioIndex),
  };
  await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
  await writeFile(output, `${JSON.stringify(quran)}\n`);
  console.log('Imported 114 surahs / 6,236 ayahs. All 604 page and 30 juz boundaries agree with Tanzil; all 6,236 Yasser Al-Dosari MP3 filenames are listed by EveryAyah.');
}
