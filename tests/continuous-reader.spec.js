import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAppServer } from '../server/index.mjs';

const quran = JSON.parse(await readFile(new URL('../public/data/quran.json', import.meta.url), 'utf8'));
const selection = (mode, number) => {
  const verses = quran.ayahs.filter(ayah => ayah[mode] === number);
  return {
    audioUrl: `/api/continuous/audio/${mode}/${number}`, duration: verses.length * 5,
    verses: verses.map((ayah, index) => ({
      number: ayah.number, surah: ayah.surah, numberInSurah: ayah.numberInSurah,
      start: index * 5, end: (index + 1) * 5,
    })),
  };
};

async function openReader(page, url = '/') {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: 'Page 1', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Audio format', exact: true })).toHaveValue('continuous');
}

async function goToPage(page, number) {
  await page.getByLabel('Go to Mushaf page').fill(String(number));
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Page ${number}`, exact: true })).toBeVisible();
}

async function selectSurah(page, number) {
  await page.getByRole('group', { name: 'Read and repeat by' }).getByRole('button', { name: 'Surah', exact: true }).click();
  await page.getByLabel('Find a surah').fill(quran.surahs[number - 1].englishName);
  await page.getByRole('navigation', { name: 'Surahs', exact: true }).getByRole('button', { name: new RegExp(`^${String(number).padStart(2, '0')} `) }).click();
  await expect(page.getByRole('heading', { level: 1, name: quran.surahs[number - 1].englishName, exact: true })).toBeVisible();
}

async function mockSetup(page) {
  const actions = [];
  let status = { state: 'choice', preference: 'ask', completed: 0, total: 114, bytes: 0, totalBytes: 1_440_000_000, unit: 'surahs' };
  await page.route('**/api/continuous/offline-status', route => route.fulfill({ json: status }));
  await page.route('**/api/continuous/offline-download/*', route => {
    const action = route.request().url().split('/').at(-1);
    actions.push({ action, method: route.request().method() });
    status = { ...status, state: action === 'as-needed' ? 'on-demand' : 'downloading', preference: action === 'as-needed' ? 'as-needed' : 'all' };
    return route.fulfill({ json: status });
  });
  await page.route('**/api/continuous/audio-cache', route => route.fulfill({ json: { files: [], bytes: 0 } }));
  return actions;
}

/** This clock records every playback operation. Crossing an ayah marker must
 * change only the highlight; a hidden reload or restart is a test failure.
 * Actual decoding and natural ended events are covered separately below. */
async function controlledMedia(page) {
  await page.addInitScript(() => {
    const states = new WeakMap();
    const state = element => {
      if (!states.has(element)) states.set(element, { paused: true, time: 0, load: 0, play: 0, pause: 0, seek: 0 });
      return states.get(element);
    };
    window.mediaState = element => ({ ...state(element), src: element.getAttribute('src') });
    window.tickMedia = (element, time, ended = false) => {
      state(element).time = time;
      element.dispatchEvent(new Event('timeupdate'));
      if (ended) {
        state(element).paused = true;
        element.dispatchEvent(new Event('ended'));
      }
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return state(this).paused; }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      get() { return state(this).time; }, set(value) { state(this).time = value; state(this).seek++; }, configurable: true,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get() { return this.hasAttribute('src') && !window.holdMediaMetadata ? 4 : 0; }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get() { return window.testMediaDuration || 60; }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentSrc', { get() { return this.hasAttribute('src') ? this.src : ''; }, configurable: true });
    HTMLMediaElement.prototype.load = function () { state(this).time = 0; state(this).load++; };
    HTMLMediaElement.prototype.pause = function () { state(this).paused = true; state(this).pause++; };
    HTMLMediaElement.prototype.play = function () {
      state(this).paused = false; state(this).play++;
      // Model a first-time surah download: src is assigned and play() waits,
      // but the browser cannot seek until loadedmetadata eventually arrives.
      if (window.holdMediaMetadata) return new Promise(() => {});
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    };
  });
  const requests = [];
  await page.route('**/api/continuous/selection/*/*', async route => {
    const parts = route.request().url().split('/');
    const result = selection(parts.at(-2), Number(parts.at(-1)));
    requests.push(route.request().url());
    await page.evaluate(duration => { window.testMediaDuration = duration; }, result.duration);
    await route.fulfill({ json: result });
  });
  return requests;
}

async function tick(page, time, ended = false) {
  // A click starts an asynchronous metadata fetch; the clock starts only once
  // the media has actually begun playing, just as a real browser would.
  await expect.poll(() => page.locator('audio').evaluate(audio => !audio.paused && !!audio.getAttribute('src'))).toBe(true);
  await page.locator('audio').evaluate((audio, args) => window.tickMedia(audio, ...args), [time, ended]);
}

const mediaState = page => page.locator('audio').evaluate(audio => window.mediaState(audio));
const operations = state => ({ load: state.load, play: state.play, pause: state.pause, seek: state.seek, src: state.src });
const play = page => page.getByRole('button', { name: 'Play recitation', exact: true }).click();
const pause = page => page.getByRole('button', { name: 'Pause recitation', exact: true }).click();

test('continuous audio is the default and keeps the full-download choice optional', async ({ page }) => {
  const actions = await mockSetup(page);
  await openReader(page);
  const setup = page.getByRole('region', { name: 'Offline setup', exact: true });
  await expect(setup.getByRole('button', { name: 'Download all audio', exact: true })).toBeVisible();
  await expect(setup.getByRole('button', { name: 'Use as needed', exact: true })).toBeVisible();
  expect(actions).toEqual([]);
  await setup.getByRole('button', { name: 'Use as needed', exact: true }).click();
  await expect(setup.getByRole('heading', { name: 'Audio saved as needed', exact: true })).toBeVisible();
  expect(actions).toEqual([{ action: 'as-needed', method: 'POST' }]);
  await page.reload();
  await expect(setup.getByRole('heading', { name: 'Audio saved as needed', exact: true })).toBeVisible();
  await setup.getByRole('button', { name: 'Download all audio', exact: true }).click();
  await expect(setup.getByRole('progressbar', { name: 'Full recitation download' })).toHaveAttribute('max', '114');
  expect(actions).toEqual([{ action: 'as-needed', method: 'POST' }, { action: 'resume', method: 'POST' }]);
});

test('every ayah transition updates the highlight without loading, seeking, pausing or playing again', async ({ page }) => {
  await mockSetup(page);
  const requests = await controlledMedia(page);
  await openReader(page);
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/continuous/audio/page/1');
  await expect(page.locator('.playback-status')).toContainText('Repeat 1');
  const baseline = operations(await mediaState(page));
  for (const verse of selection('page', 1).verses) {
    await tick(page, verse.start + 0.2);
    await expect(page.locator(`#ayah-${verse.number}`)).toHaveClass(/current/);
    expect(operations(await mediaState(page))).toEqual(baseline);
  }
  expect(requests).toHaveLength(1);
});

for (const repeat of ['1', '2', 'forever']) {
  test(`continuous page repeat ${repeat} plays all three surahs on page 604 as one source`, async ({ page }) => {
    await mockSetup(page);
    await controlledMedia(page);
    await openReader(page);
    await goToPage(page, 604);
    const metadata = selection('page', 604);
    expect([...new Set(metadata.verses.map(verse => verse.surah))]).toEqual([112, 113, 114]);
    await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption(repeat);
    await play(page);
    await expect(page.locator('audio')).toHaveAttribute('src', metadata.audioUrl);
    const baseline = await mediaState(page);
    for (let round = 1; round <= (repeat === '1' ? 1 : 2); round++) {
      const beforeRound = operations(await mediaState(page));
      for (const verse of metadata.verses) {
        await tick(page, verse.start + 0.1);
        await expect(page.locator(`#ayah-${verse.number}`)).toHaveClass(/current/);
        expect(operations(await mediaState(page))).toEqual(beforeRound);
      }
      await tick(page, metadata.duration, true);
      if (repeat === 'forever' || round < Number(repeat)) {
        await expect(page.locator('.playback-status')).toContainText(`Repeat ${round + 1}`);
        await expect(page.locator(`#ayah-${metadata.verses[0].number}`)).toHaveClass(/current/);
        expect((await mediaState(page)).time).toBe(0);
      }
    }
    expect((await mediaState(page)).load).toBe(baseline.load);
    if (repeat === 'forever') await expect(page.getByRole('button', { name: 'Pause recitation', exact: true })).toBeVisible();
    else {
      await expect(page.locator('.playback-status')).toHaveText('Selection complete');
      await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
      await expect(page.locator(`#ayah-${metadata.verses.at(-1).number}`)).toHaveClass(/current/);
    }
  });
}

test('continuous surah playback supports speed, page-independent seeking, ayah jumps and pause/resume', async ({ page }) => {
  await mockSetup(page);
  const requests = await controlledMedia(page);
  await openReader(page);
  await selectSurah(page, 112);
  await play(page);
  const metadata = selection('surah', 112);
  await expect(page.locator('audio')).toHaveAttribute('src', metadata.audioUrl);
  const baseline = await mediaState(page);
  await tick(page, 7.3);
  await pause(page);
  expect((await mediaState(page)).paused).toBe(true);
  await play(page);
  expect((await mediaState(page)).time).toBe(7.3);
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('0.75');
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.playbackRate)).toBe(0.75);
  await page.getByLabel('Seek within current surah', { exact: true }).press('End');
  expect((await mediaState(page)).time).toBe(metadata.duration);
  await expect(page.locator(`#ayah-${metadata.verses.at(-1).number}`)).toHaveClass(/current/);
  await page.getByRole('button', { name: 'Previous ayah', exact: true }).click();
  expect((await mediaState(page)).time).toBe(metadata.verses[2].start);
  await page.getByRole('button', { name: 'Next ayah', exact: true }).click();
  expect((await mediaState(page)).time).toBe(metadata.verses[3].start);
  await page.getByRole('button', { name: 'Play Al-Ikhlaas, ayah 2', exact: true }).click();
  expect((await mediaState(page)).time).toBe(metadata.verses[1].start);
  expect((await mediaState(page)).load).toBe(baseline.load);
  expect(requests).toHaveLength(1);
});

test('a repeat gap can be paused and resumed at the start of the next whole page', async ({ page }) => {
  await mockSetup(page);
  await controlledMedia(page);
  await openReader(page);
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('2');
  await page.getByRole('combobox', { name: 'Repeat pause', exact: true }).selectOption('1');
  await play(page);
  await tick(page, selection('page', 1).duration, true);
  await expect(page.locator('.playback-status')).toHaveText('Pausing 1s before repeat…');
  await pause(page);
  const paused = operations(await mediaState(page));
  await page.waitForTimeout(1100);
  expect(operations(await mediaState(page))).toEqual(paused);
  await play(page);
  await expect(page.locator('.playback-status')).toHaveText('Page 1 · Repeat 2 of 2');
  expect((await mediaState(page)).time).toBe(0);
  expect((await mediaState(page)).load).toBe(paused.load);
});

test('changing the repeat limit during a continuous-page gap cancels the extra round', async ({ page }) => {
  await mockSetup(page);
  await controlledMedia(page);
  await openReader(page);
  await page.getByRole('combobox', { name: 'Repeat pause', exact: true }).selectOption('1');
  await play(page);
  await tick(page, selection('page', 1).duration, true);
  await expect(page.locator('.playback-status')).toHaveText('Pausing 1s before repeat…');
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('1');
  await expect(page.locator('.playback-status')).toHaveText('Selection complete');
  const finished = operations(await mediaState(page));
  await page.waitForTimeout(1100);
  expect(operations(await mediaState(page))).toEqual(finished);
});

test('late media events cannot restart a paused page or a discarded selection', async ({ page }) => {
  await mockSetup(page);
  await controlledMedia(page);
  await openReader(page);
  await play(page);
  await tick(page, 6.2);
  await pause(page);
  await page.locator('audio').evaluate(audio => {
    audio.dispatchEvent(new Event('ended'));
    audio.dispatchEvent(new Event('playing'));
  });
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  expect((await mediaState(page)).paused).toBe(true);
  expect((await mediaState(page)).time).toBe(6.2);
  await goToPage(page, 2);
  await page.locator('audio').evaluate(audio => {
    audio.dispatchEvent(new Event('ended'));
    audio.dispatchEvent(new Event('playing'));
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.dispatchEvent(new Event('error'));
  });
  await expect(page.locator('audio')).not.toHaveAttribute('src');
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  expect((await mediaState(page)).paused).toBe(true);
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/continuous/audio/page/2');
});

test('a slow metadata response from an earlier page cannot replace a newer selection', async ({ page }) => {
  await mockSetup(page);
  await controlledMedia(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  await page.route('**/api/continuous/selection/page/1', async route => {
    started();
    await pending;
    await route.fulfill({ json: selection('page', 1) }).catch(() => {});
  });
  await openReader(page);
  await play(page);
  await requested;
  await goToPage(page, 2);
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/continuous/audio/page/2');
  const latest = operations(await mediaState(page));
  release();
  await page.waitForTimeout(100);
  expect(operations(await mediaState(page))).toEqual(latest);
  await expect(page.locator('.playback-status')).toContainText('Page 2');
});

test('failed continuous metadata remains retryable without requesting individual ayah files', async ({ page }) => {
  await mockSetup(page);
  const requests = await controlledMedia(page);
  let failure = true;
  const individualRequests = [];
  await page.route('**/api/audio/*/*', route => { individualRequests.push(route.request().url()); return route.abort(); });
  await page.route('**/api/continuous/selection/page/1', route => failure
    ? route.fulfill({ status: 503, json: { error: 'Offline' } }) : route.fallback());
  await openReader(page);
  await play(page);
  await expect(page.getByText(/Continuous audio could not play/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  await expect(page.locator('audio')).not.toHaveAttribute('src');
  failure = false;
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/continuous/audio/page/1');
  await expect(page.getByText(/Continuous audio could not play/)).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(individualRequests).toEqual([]);
});

test('a media error can be retried and a paused page can seek without starting playback', async ({ page }) => {
  await mockSetup(page);
  await controlledMedia(page);
  await openReader(page);
  await play(page);
  await tick(page, 6);
  await page.locator('audio').evaluate(audio => audio.dispatchEvent(new Event('error')));
  await expect(page.getByText(/Continuous audio is unavailable/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play recitation', exact: true })).toBeVisible();
  expect((await mediaState(page)).paused).toBe(true);
  await play(page);
  await tick(page, 7.5);
  await expect(page.getByText(/Continuous audio is unavailable/)).toHaveCount(0);
  await pause(page);
  const baseline = await mediaState(page);
  await page.getByLabel('Seek within current page', { exact: true }).press('End');
  const sought = await mediaState(page);
  expect(sought.time).toBe(selection('page', 1).duration);
  expect(sought.paused).toBe(true);
  expect(sought.play).toBe(baseline.play);
  expect(sought.load).toBe(baseline.load);
  await expect(page.locator(`#ayah-${quran.ayahs[6].number}`)).toHaveClass(/current/);
  await play(page);
  expect((await mediaState(page)).time).toBe(selection('page', 1).duration);
});

test('an ayah jump while the first recording loads survives late metadata after pause', async ({ page }) => {
  await mockSetup(page);
  await controlledMedia(page);
  await openReader(page);
  await page.evaluate(() => { window.holdMediaMetadata = true; });
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/continuous/audio/page/1');
  await expect.poll(() => page.locator('audio').evaluate(audio => window.mediaState(audio).play)).toBe(1);
  await pause(page);
  await page.getByRole('button', { name: 'Next ayah', exact: true }).click();
  await expect(page.locator('.now-playing strong')).toHaveText('Al-Faatiha · Ayah 2');
  const beforeMetadata = await mediaState(page);
  expect(beforeMetadata.time).toBe(0);
  await page.locator('audio').evaluate(audio => {
    window.holdMediaMetadata = false;
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('.now-playing strong')).toHaveText('Al-Faatiha · Ayah 2');
  const afterMetadata = await mediaState(page);
  expect(afterMetadata.time).toBe(selection('page', 1).verses[1].start);
  expect(afterMetadata.paused).toBe(true);
  expect(afterMetadata.play).toBe(beforeMetadata.play);
  expect(afterMetadata.load).toBe(beforeMetadata.load);
  await play(page);
  expect((await mediaState(page)).time).toBe(selection('page', 1).verses[1].start);
  await expect(page.locator(`#ayah-${quran.ayahs[1].number}`)).toHaveClass(/current/);
});

test('switching to individual ayah files stops continuous playback and preserves the preference', async ({ page }) => {
  await mockSetup(page);
  await controlledMedia(page);
  await openReader(page);
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/continuous/audio/page/1');
  await page.getByRole('combobox', { name: 'Audio format', exact: true }).selectOption('ayah');
  await expect(page.locator('audio')).not.toHaveAttribute('src');
  expect((await mediaState(page)).paused).toBe(true);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Audio format', exact: true })).toHaveValue('ayah');
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/audio/1/1');
  await page.getByRole('combobox', { name: 'Audio format', exact: true }).selectOption('continuous');
  await expect(page.locator('audio')).not.toHaveAttribute('src');
  await play(page);
  await expect(page.locator('audio')).toHaveAttribute('src', '/api/continuous/audio/page/1');
});

test('real continuous MP3 crosses an ayah boundary naturally and repeats only at the page end', async ({ page, request }) => {
  test.setTimeout(120_000);
  const metadataResponse = await request.get('/api/continuous/selection/page/1');
  expect(metadataResponse.ok()).toBe(true);
  const metadata = await metadataResponse.json();
  const audioResponse = await request.get(metadata.audioUrl, { timeout: 90_000 });
  expect(audioResponse.ok()).toBe(true);
  expect(audioResponse.headers()['content-type']).toContain('audio/mpeg');
  await openReader(page);
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('2');
  await play(page);
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0);
  await page.locator('audio').evaluate((audio, start) => {
    window.realMediaCalls = { load: 0, play: 0, pause: 0 };
    for (const operation of Object.keys(window.realMediaCalls)) {
      const native = audio[operation].bind(audio);
      audio[operation] = (...args) => { window.realMediaCalls[operation]++; return native(...args); };
    }
    audio.currentTime = start - 0.3;
  }, metadata.verses[1].start);
  await expect(page.locator(`#ayah-${metadata.verses[1].number}`)).toHaveClass(/current/);
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(metadata.verses[1].start + 0.15);
  expect(await page.evaluate(() => window.realMediaCalls)).toEqual({ load: 0, play: 0, pause: 0 });
  await expect(page.locator('audio')).toHaveAttribute('src', metadata.audioUrl);
  for (let round = 1; round <= 2; round++) {
    await page.locator('audio').evaluate(audio => { audio.currentTime = audio.duration - 0.1; });
    if (round === 1) {
      await expect(page.locator('.playback-status')).toHaveText('Page 1 · Repeat 2 of 2');
      await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBeLessThan(2);
    }
  }
  await expect(page.locator('.playback-status')).toHaveText('Selection complete');
  expect(await page.locator('audio').evaluate(audio => audio.error)).toBeNull();
  expect(await page.evaluate(() => window.realMediaCalls.load)).toBe(0);
});

test('a saved continuous page decodes and crosses an ayah boundary with server internet disabled', async ({ page, request }) => {
  test.setTimeout(120_000);
  const warmed = await request.get('/api/continuous/audio/page/1', { timeout: 90_000 });
  expect(warmed.ok()).toBe(true);
  let upstreamCalls = 0;
  const server = await createAppServer({
    rootDir: resolve('.'), cacheDir: resolve('.cache/audio'),
    fetchImpl: async () => { upstreamCalls++; throw new Error('Internet disabled'); },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort('internetdisconnected'));
    await openReader(page, `http://127.0.0.1:${server.address().port}`);
    await play(page);
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0);
    const metadata = await page.evaluate(async () => (await fetch('/api/continuous/selection/page/1')).json());
    await page.locator('audio').evaluate((audio, start) => { audio.currentTime = start - 0.3; }, metadata.verses[1].start);
    await expect(page.locator(`#ayah-${metadata.verses[1].number}`)).toHaveClass(/current/);
    expect(await page.locator('audio').evaluate(audio => audio.error)).toBeNull();
    expect(upstreamCalls).toBe(0);
  } finally {
    await page.goto('about:blank');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const [theme, width, height] of [['light', 1440, 1000], ['dark', 390, 844]]) {
  test(`continuous audio controls are accessible in ${theme} theme at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mockSetup(page);
    await openReader(page);
    if (theme === 'dark') await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
