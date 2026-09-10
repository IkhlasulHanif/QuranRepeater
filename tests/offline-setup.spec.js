import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TOTAL_AYAHS = 6236;
const choiceStatus = {
  state: 'choice', preference: 'ask', completed: 0, total: TOTAL_AYAHS, bytes: 0,
};
const initialStatus = {
  state: 'downloading', preference: 'all', completed: 1234, total: TOTAL_AYAHS, bytes: 512 * 1000 ** 2,
};

/** The real server's durable download lifecycle is covered by server tests.
 * These routes control only the UI's local setup API, without downloading audio.
 */
async function setupStatus(page, initial = initialStatus) {
  const scenario = { status: { ...initial }, polls: 0, actions: [], unavailable: false, actionFailure: false };
  await page.route('**/api/offline-status', async (route) => {
    scenario.polls++;
    if (scenario.unavailable) return route.abort('connectionrefused');
    await route.fulfill({ json: scenario.status });
  });
  await page.route('**/api/offline-download/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    scenario.actions.push({ action, method: route.request().method() });
    if (scenario.actionFailure) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
    const preference = action === 'as-needed' ? 'as-needed' : 'all';
    const state = scenario.status.completed === scenario.status.total ? 'complete'
      : action === 'pause' ? 'paused' : action === 'as-needed' ? 'on-demand' : 'downloading';
    scenario.status = { ...scenario.status, preference, state, error: null };
    await route.fulfill({ json: scenario.status });
  });
  await page.route('**/api/audio-cache', (route) => route.fulfill({ json: { files: [], bytes: 0 } }));
  return scenario;
}

async function openSetup(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Page 1', exact: true })).toBeVisible();
  const banner = page.getByRole('region', { name: 'Offline setup', exact: true });
  await expect(banner).toBeVisible();
  return banner;
}

test('first launch offers both download choices and makes no choice automatically', async ({ page }) => {
  const scenario = await setupStatus(page, choiceStatus);
  const banner = await openSetup(page);
  await expect(banner.getByRole('heading', { name: 'Choose how to listen', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toBeVisible();
  await expect(banner).toContainText('1.5 GB');
  await expect(banner.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('.quran-text .ayah')).toHaveCount(7);
  expect(scenario.actions).toEqual([]);
  await page.reload();
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toBeVisible();
  expect(scenario.actions).toEqual([]);
  expect(scenario.polls).toBeGreaterThan(1);
});

test('choosing download all starts the full download and shows progress', async ({ page }) => {
  const scenario = await setupStatus(page, choiceStatus);
  const banner = await openSetup(page);
  await banner.getByRole('button', { name: 'Download all audio', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  await expect(banner.getByRole('progressbar', { name: 'Full recitation download' })).toHaveAttribute('value', '0');
  await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toBeEnabled();
  expect(scenario.actions).toEqual([{ action: 'resume', method: 'POST' }]);
  expect(scenario.status.preference).toBe('all');
});

test('use as needed persists through reload and lets the user download all later', async ({ page }) => {
  const scenario = await setupStatus(page, choiceStatus);
  const banner = await openSetup(page);
  await banner.getByRole('button', { name: 'Use as needed', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Audio saved as needed', exact: true })).toBeVisible();
  await expect(banner).toContainText('Only the ayahs you play or choose to save are downloaded. Unsaved audio needs internet.');
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeEnabled();
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toHaveCount(0);
  await expect(banner.getByRole('progressbar')).toHaveCount(0);
  expect(scenario.actions).toEqual([{ action: 'as-needed', method: 'POST' }]);
  expect(scenario.status.preference).toBe('as-needed');
  await page.reload();
  await expect(banner.getByRole('heading', { name: 'Audio saved as needed', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeEnabled();
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toHaveCount(0);
  await expect(page.locator('.quran-text .ayah')).toHaveCount(7);
  expect(scenario.actions).toHaveLength(1);
  await banner.getByRole('button', { name: 'Download all audio', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  expect(scenario.actions).toEqual([{ action: 'as-needed', method: 'POST' }, { action: 'resume', method: 'POST' }]);
});

test('an opted-in full download displays progress while the Quran stays readable', async ({ page }) => {
  const scenario = await setupStatus(page);
  const banner = await openSetup(page);
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  await expect(banner).toContainText('Downloading Yasser Al-Dosari’s complete recitation (about 1.5 GB). You can read now.');
  await expect(banner).toContainText('1,234 / 6,236 ayahs');
  await expect(banner).toContainText('512 MB saved');
  await expect(banner.getByRole('progressbar', { name: 'Full recitation download' })).toHaveAttribute('max', '6236');
  await expect(banner.getByRole('progressbar', { name: 'Full recitation download' })).toHaveAttribute('value', '1234');
  await expect(page.locator('.quran-text .ayah')).toHaveCount(7);
  expect(scenario.actions).toEqual([]);

  scenario.status.completed = 1250;
  await expect(banner.getByRole('progressbar', { name: 'Full recitation download' })).toHaveAttribute('value', '1250');
  expect(scenario.polls).toBeGreaterThan(1);
});

for (const state of ['downloading', 'paused', 'waiting']) {
  test(`a download in ${state} state can switch to as needed without losing saved audio`, async ({ page }) => {
    const scenario = await setupStatus(page, { ...initialStatus, state });
    const banner = await openSetup(page);
    await banner.getByRole('button', { name: 'Use as needed', exact: true }).click();
    await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeEnabled();
    await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toHaveCount(0);
    await expect(banner.getByRole('button', { name: 'Resume download', exact: true })).toHaveCount(0);
    await expect(banner).toContainText('1,234 / 6,236 ayahs');
    await expect(banner).toContainText('512 MB saved');
    await expect(banner.getByRole('progressbar')).toHaveCount(0);
    expect(scenario.actions).toEqual([{ action: 'as-needed', method: 'POST' }]);
  });
}

test('pause and resume update the download without losing saved progress', async ({ page }) => {
  const scenario = await setupStatus(page);
  const banner = await openSetup(page);
  await banner.getByRole('button', { name: 'Pause download', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Offline download paused', exact: true })).toBeVisible();
  await expect(banner).toContainText('1,234 / 6,236 ayahs');
  await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toHaveCount(0);
  await banner.getByRole('button', { name: 'Resume download', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toBeEnabled();
  expect(scenario.actions).toEqual([{ action: 'pause', method: 'POST' }, { action: 'resume', method: 'POST' }]);
});

test('interrupted downloads offer immediate retry and can recover through polling', async ({ page }) => {
  const scenario = await setupStatus(page, {
    ...initialStatus, state: 'waiting', error: 'Connection lost. Saved ayahs are kept; the download will retry.',
  });
  const banner = await openSetup(page);
  await expect(banner.getByRole('heading', { name: 'Offline download will retry', exact: true })).toBeVisible();
  await expect(banner).toContainText('Connection lost. Saved ayahs are kept');
  await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toBeEnabled();
  await banner.getByRole('button', { name: 'Retry download now', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  expect(scenario.actions).toEqual([{ action: 'resume', method: 'POST' }]);

  scenario.status = { ...scenario.status, state: 'waiting', error: 'Connection interrupted again.' };
  await expect(banner.getByRole('heading', { name: 'Offline download will retry', exact: true })).toBeVisible();
  scenario.status = { ...scenario.status, state: 'downloading', completed: 1235, error: null };
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  await expect(banner).toContainText('1,235 / 6,236 ayahs');
  expect(scenario.actions).toHaveLength(1);
});

test('an unavailable local status reconnects automatically without preventing reading', async ({ page }) => {
  const scenario = await setupStatus(page);
  scenario.unavailable = true;
  const banner = await openSetup(page);
  await expect(banner.getByRole('heading', { name: 'Download status unavailable', exact: true })).toBeVisible();
  await expect(page.locator('.quran-text .ayah')).toHaveCount(7);
  await expect(banner.getByRole('button')).toHaveCount(0);
  scenario.unavailable = false;
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toBeEnabled();
  expect(scenario.actions).toEqual([]);
});

test('failed pause remains retryable and reports an accessible action error', async ({ page }) => {
  const scenario = await setupStatus(page);
  scenario.actionFailure = true;
  const banner = await openSetup(page);
  await banner.getByRole('button', { name: 'Pause download', exact: true }).click();
  await expect(banner.getByRole('alert')).toContainText('Could not update the download. Please try again.');
  await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toBeEnabled();
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  scenario.actionFailure = false;
  await banner.getByRole('button', { name: 'Pause download', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Offline download paused', exact: true })).toBeVisible();
  await expect(banner.getByRole('alert')).toHaveCount(0);
});

test('a failed initial choice stays retryable without committing a preference', async ({ page }) => {
  const scenario = await setupStatus(page, choiceStatus);
  scenario.actionFailure = true;
  const banner = await openSetup(page);
  await banner.getByRole('button', { name: 'Use as needed', exact: true }).click();
  await expect(banner.getByRole('alert')).toContainText('Could not update the download. Please try again.');
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toBeEnabled();
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeEnabled();
  expect(scenario.status.preference).toBe('ask');
  scenario.actionFailure = false;
  await banner.getByRole('button', { name: 'Use as needed', exact: true }).click();
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toHaveCount(0);
  await expect(banner.getByRole('alert')).toHaveCount(0);
  expect(scenario.status.preference).toBe('as-needed');
});

test('a completed download confirms offline listening and remembers its preference', async ({ page }) => {
  const scenario = await setupStatus(page);
  const banner = await openSetup(page);
  await expect(banner.getByRole('heading', { name: 'Preparing your offline Quran', exact: true })).toBeVisible();
  scenario.status = { state: 'complete', preference: 'all', completed: TOTAL_AYAHS, total: TOTAL_AYAHS, bytes: 1500 * 1000 ** 2 };
  await expect(banner.getByRole('heading', { name: 'Your Quran is ready offline', exact: true })).toBeVisible();
  await expect(banner).toContainText('All 114 surahs are saved on this computer. Reading and listening now work without internet.');
  await expect(banner).toContainText('6,236 / 6,236 ayahs');
  await expect(banner).toContainText('1.50 GB saved');
  await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Resume download', exact: true })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toBeEnabled();
  await expect(banner.getByRole('progressbar')).toHaveCount(0);
  await page.reload();
  await expect(banner.getByRole('heading', { name: 'Your Quran is ready offline', exact: true })).toBeVisible();
  expect(scenario.actions).toEqual([]);
  await banner.getByRole('button', { name: 'Use as needed', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Your Quran is ready offline', exact: true })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeEnabled();
  await expect(banner).toContainText('6,236 / 6,236 ayahs');
  await page.reload();
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeEnabled();
  expect(scenario.actions).toEqual([{ action: 'as-needed', method: 'POST' }]);
});

test('a previously complete cache still offers the first choice and keeps every saved ayah', async ({ page }) => {
  const scenario = await setupStatus(page, {
    ...choiceStatus, completed: TOTAL_AYAHS, bytes: 1500 * 1000 ** 2,
  });
  const banner = await openSetup(page);
  await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeEnabled();
  await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toBeEnabled();
  expect(scenario.actions).toEqual([]);
  await banner.getByRole('button', { name: 'Use as needed', exact: true }).click();
  await expect(banner.getByRole('heading', { name: 'Your Quran is ready offline', exact: true })).toBeVisible();
  await expect(banner).toContainText('6,236 / 6,236 ayahs');
  await expect(banner).toContainText('1.50 GB saved');
  await expect(banner.getByRole('progressbar')).toHaveCount(0);
  expect(scenario.status.preference).toBe('as-needed');
  expect(scenario.actions).toEqual([{ action: 'as-needed', method: 'POST' }]);
});

for (const [theme, viewport] of [
  ['light', { width: 1440, height: 1000 }],
  ['dark', { width: 1440, height: 1000 }],
  ['light', { width: 390, height: 844 }],
  ['dark', { width: 390, height: 844 }],
]) {
  test(`offline setup controls are accessible in ${theme} theme at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const scenario = await setupStatus(page, choiceStatus);
    const banner = await openSetup(page);
    await expect(banner.getByRole('button', { name: 'Use as needed', exact: true })).toBeVisible();
    if (theme === 'dark') {
      await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    }
    for (const state of ['choice', 'on-demand', 'waiting']) {
      if (state !== 'choice') {
        scenario.status = { ...initialStatus, state, preference: state === 'on-demand' ? 'as-needed' : 'all' };
        await page.reload();
      }
      if (state === 'waiting') {
        await expect(banner.getByRole('button', { name: 'Pause download', exact: true })).toBeVisible();
        await expect(banner.getByRole('button', { name: 'Retry download now', exact: true })).toBeVisible();
      } else {
        await expect(banner.getByRole('button', { name: 'Download all audio', exact: true })).toBeVisible();
      }
      const results = await new AxeBuilder({ page }).include('.offline-setup').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const bounds = await banner.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    }
  });
}
