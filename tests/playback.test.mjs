import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nextPlayback, selectVerses, audioKey } from '../src/playback.mjs';

test('finite repeats traverse all ayahs exactly three times and stop', () => {
  const visits = [];
  let position = { index: 0, round: 1 };
  while (position) { visits.push(position); position = nextPlayback(7, position.index, position.round, '3'); }
  assert.equal(visits.length, 21);
  assert.deepEqual(visits.at(-1), { index: 6, round: 3 });
});
test('continuous repeat returns to the first ayah while play once stops', () => {
  assert.deepEqual(nextPlayback(4, 3, 20, 'forever'), { index: 0, round: 21 });
  assert.equal(nextPlayback(4, 3, 1, '1'), null);
  assert.equal(nextPlayback(0, 0, 1, 'forever'), null);
});
test('every Quran page and surah is complete, ordered, and generates unique audio keys', async () => {
  const data = JSON.parse(await readFile(new URL('../public/data/quran.json', import.meta.url), 'utf8'));
  assert.equal(data.ayahs.length, 6236);
  assert.equal(data.surahs.length, 114);
  const keys = new Set(data.ayahs.map(audioKey));
  assert.equal(keys.size, 6236);
  let total = 0;
  for (let page = 1; page <= 604; page++) {
    const verses = selectVerses(data, 'page', page);
    assert.ok(verses.length > 0, `Page ${page}`);
    total += verses.length;
    for (let i = 1; i < verses.length; i++) assert.equal(verses[i].number, verses[i - 1].number + 1);
  }
  assert.equal(total, 6236);
  for (const surah of data.surahs) assert.equal(selectVerses(data, 'surah', surah.number).length, surah.numberOfAyahs);
  const lastPage = selectVerses(data, 'page', 604);
  assert.deepEqual([...new Set(lastPage.map(v => v.surah))], [112, 113, 114]);
  assert.equal(audioKey(lastPage.at(-1)), '114006');
});
