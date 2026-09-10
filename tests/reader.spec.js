import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createAppServer } from '../server/index.mjs';

const quran = JSON.parse(await readFile(new URL('../public/data/quran.json', import.meta.url), 'utf8'));
const audioPath = (ayah) => `/api/audio/${ayah.surah}/${ayah.numberInSurah}`;

async function openReader(page, url = '/') {
  // Keep the original ayah-file behavior covered now that continuous audio is the default.
  await page.addInitScript(() => {
    const saved = JSON.parse(localStorage.getItem('quran-preferences') || '{}');
    localStorage.setItem('quran-preferences', JSON.stringify({ ...saved, audioMode: 'ayah' }));
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: 'Page 1', exact: true })).toBeVisible();
}

async function goToPage(page, number) {
  await page.getByLabel('Go to Mushaf page').fill(String(number));
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Page ${number}`, exact: true })).toBeVisible();
}

async function renderedAyahs(page) {
  return page.locator('.quran-text .ayah > span:first-child').allTextContents();
}

async function selectSurah(page, number) {
  await page.getByRole('group', { name: 'Read and repeat by' }).getByRole('button', { name: 'Surah', exact: true }).click();
  await page.getByLabel('Find a surah').fill(quran.surahs[number - 1].englishName);
  await page.getByRole('navigation', { name: 'Surahs', exact: true }).getByRole('button', { name: new RegExp(`^${String(number).padStart(2, '0')} `) }).click();
  await expect(page.getByRole('heading', { level: 1, name: quran.surahs[number - 1].englishName, exact: true })).toBeVisible();
}

/**
 * A controlled media clock lets ended-event tests exercise the real React UI
 * without waiting through a full recitation. Decoding real MP3 is verified in
 * the separate live-recitation test below, and disk caching in its own server.
 */
async function useControlledMedia(page) {
  await page.addInitScript(() => {
    const media = new WeakMap();
    const state = (element) => {
      if (!media.has(element)) media.set(element, { paused: true, time: 0 });
      return media.get(element);
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return state(this).paused; }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      get() { return state(this).time; }, set(value) { state(this).time = value; }, configurable: true,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get() { return 60; }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentSrc', { get() { return this.getAttribute('src') ? this.src : ''; }, configurable: true });
    HTMLMediaElement.prototype.load = function () { state(this).time = 0; };
    HTMLMediaElement.prototype.pause = function () { state(this).paused = true; };
    HTMLMediaElement.prototype.play = function () {
      state(this).paused = false;
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    };
  });
}

async function expectAudio(page, ayah) {
  await expect(page.locator('audio')).toHaveAttribute('src', new RegExp(`${audioPath(ayah)}$`));
  await expect(page.locator(`#ayah-${ayah.number}`)).toHaveClass(/current/);
}

async function finishAyah(page) {
  await page.locator('audio').evaluate((audio) => audio.dispatchEvent(new Event('ended')));
}

test('renders the exact bundled Arabic text and the first page boundaries', async ({ page }) => {
  await openReader(page);
  expect(await renderedAyahs(page)).toEqual(quran.ayahs.filter((a) => a.page === 1).map((a) => a.text));
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Tanzil Project', exact: true })).toHaveAttribute('href', 'https://tanzil.net');
  expect(await page.locator('.quran-text').getAttribute('dir')).toBe('rtl');
  expect(await page.locator('.quran-text').getAttribute('lang')).toBe('ar');
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.family.replaceAll('"', '') === 'Amiri Quran').map((face) => face.status);
  })).toEqual(['loaded']);
});

test('page 604 contains all three final surahs and cannot advance past the Quran', async ({ page }) => {
  await openReader(page);
  await goToPage(page, 604);
  const expected = quran.ayahs.filter((a) => a.page === 604);
  expect([...new Set(expected.map((a) => a.surah))]).toEqual([112, 113, 114]);
  expect(await renderedAyahs(page)).toEqual(expected.map((a) => a.text));
  await expect(page.locator('.surah-section')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Page 603', exact: true })).toBeVisible();
  expect(await renderedAyahs(page)).toEqual(quran.ayahs.filter((a) => a.page === 603).map((a) => a.text));
});

test('surah selection renders the complete surah and preserves Quran endpoints', async ({ page }) => {
  await openReader(page);
  await selectSurah(page, 2);
  expect(await renderedAyahs(page)).toEqual(quran.ayahs.filter((a) => a.surah === 2).map((a) => a.text));
  await expect(page.locator('.quran-text .ayah')).toHaveCount(286);
  await selectSurah(page, 114);
  expect(await renderedAyahs(page)).toEqual(quran.ayahs.filter((a) => a.surah === 114).map((a) => a.text));
  await expect(page.getByRole('button', { name: 'Next surah', exact: true })).toBeDisabled();
  await selectSurah(page, 1);
  await expect(page.getByRole('button', { name: 'Previous surah', exact: true })).toBeDisabled();
});

test('Arabic search ignores diacritics and switching to surah keeps the chosen surah on a shared page', async ({ page }) => {
  await openReader(page);
  await page.getByLabel('Find a surah').fill('الفلق');
  const result = page.getByRole('navigation', { name: 'Surahs', exact: true }).getByRole('button', { name: /^113 / });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Page 604', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Read and repeat by' }).getByRole('button', { name: 'Surah', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Al-Falaq', exact: true })).toBeVisible();
  expect(await renderedAyahs(page)).toEqual(quran.ayahs.filter((a) => a.surah === 113).map((a) => a.text));
});

for (const repeat of ['1', '2', 'forever']) {
  test(`page repeat ${repeat} follows every ayah and the correct number of rounds`, async ({ page }) => {
    await useControlledMedia(page);
    await openReader(page);
    await goToPage(page, 604);
    await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption(repeat);
    const verses = quran.ayahs.filter((a) => a.page === 604);
    await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
    const rounds = repeat === '1' ? 1 : 2;
    for (let round = 1; round <= rounds; round++) {
      for (const ayah of verses) {
        await expectAudio(page, ayah);
        await finishAyah(page);
      }
    }
    if (repeat === 'forever') {
      await expectAudio(page, verses[0]);
      await expect(page.locator('.playback-status')).toHaveText('Page 604 · Repeat 3');
      await expect(page.getByRole('button', { name: 'Pause recitation', exact: true })).toBeVisible();
    } else {
      await expect(page.locator('.playback-status')).toHaveText('Selection complete');
      await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
      await expectAudio(page, verses.at(-1));
    }
  });
}

test('surah repeat stays within the selected surah', async ({ page }) => {
  await useControlledMedia(page);
  await openReader(page);
  await selectSurah(page, 112);
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
  const verses = quran.ayahs.filter((a) => a.surah === 112);
  for (let round = 1; round <= 2; round++) {
    for (const ayah of verses) {
      await expectAudio(page, ayah);
      await finishAyah(page);
    }
  }
  await expect(page.locator('.playback-status')).toHaveText('Selection complete');
  await expectAudio(page, verses.at(-1));
});

test('pause, speed, seeking, ayah jumps and changing the selection control the audio', async ({ page }) => {
  await useControlledMedia(page);
  await openReader(page);
  await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
  await expectAudio(page, quran.ayahs[0]);
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('0.75');
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.playbackRate)).toBe(0.75);
  await page.getByLabel('Seek within current ayah').press('End');
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.currentTime)).toBe(60);
  await page.getByRole('button', { name: 'Pause recitation', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.paused)).toBe(true);
  await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.currentTime)).toBe(60);
  await page.getByRole('button', { name: 'Next ayah', exact: true }).click();
  await expectAudio(page, quran.ayahs[1]);
  await page.getByRole('button', { name: 'Previous ayah', exact: true }).click();
  await expectAudio(page, quran.ayahs[0]);
  await goToPage(page, 2);
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  await expect(page.locator('audio')).not.toHaveAttribute('src');
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.paused)).toBe(true);
  await page.locator('audio').evaluate((audio) => {
    audio.dispatchEvent(new Event('ended'));
    audio.dispatchEvent(new Event('playing'));
  });
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  await expect(page.locator('audio')).not.toHaveAttribute('src');
  await page.getByRole('button', { name: 'Play Al-Baqara, ayah 3', exact: true }).click();
  await expectAudio(page, quran.ayahs.find((a) => a.surah === 2 && a.numberInSurah === 3));
});

test('a repeat pause can be paused and resumed without losing the next round', async ({ page }) => {
  await useControlledMedia(page);
  await openReader(page);
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('2');
  await page.getByRole('combobox', { name: 'Repeat pause', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Play Al-Faatiha, ayah 7', exact: true }).click();
  await finishAyah(page);
  await expect(page.locator('.playback-status')).toHaveText('Pausing 1s before repeat…');
  await page.getByRole('button', { name: 'Pause recitation', exact: true }).click();
  await page.waitForTimeout(1100);
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  await expectAudio(page, quran.ayahs[6]);
  await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
  await expectAudio(page, quran.ayahs[0]);
  await expect(page.locator('.playback-status')).toHaveText('Page 1 · Repeat 2 of 2');
});

test('late ended and playing events do not restart audio after pause', async ({ page }) => {
  await useControlledMedia(page);
  await openReader(page);
  await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
  await expectAudio(page, quran.ayahs[0]);
  await page.getByRole('button', { name: 'Pause recitation', exact: true }).click();
  await page.locator('audio').evaluate((audio) => {
    audio.dispatchEvent(new Event('ended'));
    audio.dispatchEvent(new Event('playing'));
  });
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  await expectAudio(page, quran.ayahs[0]);
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.paused)).toBe(true);
});

test('changing Repeat to Play once during a gap cancels the pending extra round', async ({ page }) => {
  await useControlledMedia(page);
  await openReader(page);
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('forever');
  await page.getByRole('combobox', { name: 'Repeat pause', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Play Al-Faatiha, ayah 7', exact: true }).click();
  await finishAyah(page);
  await expect(page.locator('.playback-status')).toHaveText('Pausing 1s before repeat…');
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('1');
  await expect(page.locator('.playback-status')).toHaveText('Selection complete');
  await page.waitForTimeout(1100);
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  await expectAudio(page, quran.ayahs[6]);
});

test('the complete local reader reloads with all external browser requests blocked', async ({ page }) => {
  const attemptedExternal = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    attemptedExternal.push(url.href);
    return route.abort('internetdisconnected');
  });
  await openReader(page);
  await goToPage(page, 604);
  await page.getByRole('button', { name: 'Increase Arabic text size', exact: true }).click();
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Page 604', exact: true })).toBeVisible();
  expect(await renderedAyahs(page)).toEqual(quran.ayahs.filter((a) => a.page === 604).map((a) => a.text));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('Arabic text size: 38 pixels', { exact: true })).toBeAttached();
  expect(attemptedExternal).toEqual([]);
});

test('live Yasser Al-Dosari audio decodes and starts playing', async ({ page, request }) => {
  test.setTimeout(75_000);
  const response = await request.get('/api/audio/1/1', { timeout: 65_000 });
  test.skip(!response.ok(), `Live audio provider unavailable: HTTP ${response.status()}`);
  expect(response.headers()['content-type']).toContain('audio/mpeg');
  expect((await response.body()).length).toBeGreaterThan(1000);
  await openReader(page);
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.duration)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.currentTime)).toBeGreaterThan(0);
  expect(await page.locator('audio').evaluate((audio) => audio.error)).toBeNull();
  await page.getByRole('button', { name: 'Pause recitation', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.paused)).toBe(true);
});

test('real MP3 ended events advance through a surah, repeat it and stop after round two', async ({ page, request }) => {
  test.setTimeout(90_000);
  const verses = quran.ayahs.filter((a) => a.surah === 112);
  for (const ayah of verses) {
    const response = await request.get(audioPath(ayah), { timeout: 65_000 });
    expect(response.ok(), `Recitation ${ayah.surah}:${ayah.numberInSurah} is available`).toBe(true);
    expect(response.headers()['content-type']).toContain('audio/mpeg');
  }
  await openReader(page);
  await selectSurah(page, 112);
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
  for (let round = 1; round <= 2; round++) {
    for (const ayah of verses) {
      await expectAudio(page, ayah);
      await expect.poll(() => page.locator('audio').evaluate((audio) => Number.isFinite(audio.duration) && audio.duration > 0 && !audio.paused)).toBe(true);
      // Seek near the end, then let Chrome emit its own natural ended event.
      await page.locator('audio').evaluate((audio) => { audio.currentTime = Math.max(0, audio.duration - 0.08); });
      if (ayah !== verses.at(-1)) await expectAudio(page, verses[verses.indexOf(ayah) + 1]);
      else if (round === 1) {
        await expectAudio(page, verses[0]);
        await expect(page.locator('.playback-status')).toHaveText('Al-Ikhlaas · Repeat 2 of 2');
      }
    }
  }
  await expect(page.locator('.playback-status')).toHaveText('Selection complete');
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('audio').evaluate((audio) => audio.paused)).toBe(true);
  expect(await page.locator('audio').evaluate((audio) => audio.error)).toBeNull();
});

test('an actual saved MP3 decodes with every server-side upstream request disabled', async ({ page, request }) => {
  test.setTimeout(75_000);
  const cached = await request.get('/api/audio/1/1', { timeout: 65_000 });
  expect(cached.ok()).toBe(true);
  let upstreamCalls = 0;
  const server = await createAppServer({
    rootDir: resolve('.'), cacheDir: resolve('.cache/audio'),
    fetchImpl: async () => { upstreamCalls++; throw new Error('Internet disabled for this server'); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort('internetdisconnected'));
    // A different port provides a fresh HTTP-cache origin. The media comes from
    // the same persisted disk cache with the upstream fetch function disabled.
    await openReader(page, url);
    await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('1');
    await page.getByRole('button', { name: 'Play recitation', exact: true }).click();
    await expect.poll(() => page.locator('audio').evaluate((audio) => Number.isFinite(audio.duration) && audio.duration > 0 && audio.currentTime > 0)).toBe(true);
    expect(await page.locator('audio').evaluate((audio) => audio.error)).toBeNull();
    await page.getByRole('button', { name: 'Pause recitation', exact: true }).click();
    expect(upstreamCalls).toBe(0);
  } finally {
    await page.goto('about:blank');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('saved audio survives reload and is served from disk when the provider is offline', async ({ page }) => {
  test.setTimeout(60_000);
  // Cache semantics use unique MP3-shaped payloads with the exact published file
  // sizes. Actual MP3 decoding is tested separately above, using real recitation.
  const manifest = JSON.parse(await readFile(new URL('../public/data/audio-manifest.json', import.meta.url), 'utf8'));
  function fixtureAudio(filename) {
    expect(manifest.files[filename]).toBeGreaterThan(3);
    const bytes = Buffer.alloc(manifest.files[filename], Number(filename) % 251);
    bytes.write('ID3');
    return bytes;
  }
  const firstAyah = fixtureAudio('001001');
  const cacheDir = await mkdtemp(join(tmpdir(), 'quran-reader-e2e-'));
  let upstreamCalls = 0;
  let offline = false;
  const server = await createAppServer({
    rootDir: resolve('.'), cacheDir, dev: true,
    fetchImpl: async (url) => {
      upstreamCalls++;
      if (offline) throw new Error('Network is disconnected');
      const filename = new URL(url).pathname.match(/(\d{6})\.mp3$/)?.[1];
      const bytes = fixtureAudio(filename);
      return new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) } });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await useControlledMedia(page);
    await openReader(page, url);
    await page.getByRole('button', { name: 'Save audio offline', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved for offline', exact: true })).toBeDisabled();
    await expect(page.getByText('Page 1 saved for offline listening.', { exact: true })).toBeVisible();
    expect(upstreamCalls).toBe(7);
    offline = true;
    await page.reload();
    await expect(page.getByRole('button', { name: 'Saved for offline', exact: true })).toBeDisabled();
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/audio/1/1', { cache: 'reload' });
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return {
        status: response.status, bytes: bytes.byteLength,
        sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
    });
    expect(result).toEqual({ status: 200, bytes: firstAyah.length, sha256: createHash('sha256').update(firstAyah).digest('hex') });
    expect(upstreamCalls).toBe(7);
    await goToPage(page, 2);
    await page.getByRole('button', { name: 'Save audio offline', exact: true }).click();
    await expect(page.getByText(/Download interrupted/)).toBeVisible();
    await goToPage(page, 1);
    await expect(page.getByRole('button', { name: 'Saved for offline', exact: true })).toBeDisabled();
  } finally {
    await page.goto('about:blank');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(cacheDir, { recursive: true, force: true });
  }
});

for (const theme of ['light', 'dark']) {
  test(`desktop ${theme} theme has no detectable WCAG A/AA violations`, async ({ page }) => {
    await openReader(page);
    if (theme === 'dark') {
      await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.locator('.surah-item.selected').evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    }
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('390px mobile reader and open navigation are accessible and do not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReader(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  let results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
  await page.getByRole('button', { name: 'Open surah list', exact: true }).click();
  await expect(page.getByLabel('Find a surah')).toBeVisible();
  results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
  await goToPage(page, 604);
  await expect(page.getByRole('button', { name: 'Open surah list', exact: true })).toBeVisible();
  expect(await renderedAyahs(page)).toEqual(quran.ayahs.filter((a) => a.page === 604).map((a) => a.text));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
