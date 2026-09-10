import { spawn } from 'node:child_process';
import { createAppServer } from '../server/index.mjs';
const url = 'http://127.0.0.1:5173';
function openBrowser() {
  if (process.argv.includes('--no-open')) {
    console.log(`Open ${url} in your browser.`);
    return;
  }
  const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(program, [url], { stdio: 'ignore' });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
}
let existing = false;
try {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
  const health = await response.json();
  existing = health.ok === true && health.localOnly === true;
} catch { /* Start our own local server. */ }
if (existing) {
  const offline = await fetch(`${url}/api/continuous/offline-status`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  const downloadStatus = offline?.ok ? await offline.json().catch(() => null) : null;
  if (!['ask', 'all', 'as-needed'].includes(downloadStatus?.preference)) {
    console.error('Restart the running Quran Repeater server to use this version: stop it with Control+C, then run npm run init again.');
    process.exit(1);
  }
  console.log(`Quran Repeater is already running at ${url}`);
  openBrowser();
} else {
  const server = await createAppServer({ autoDownload: true });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Port 5173 is in use by another app. Close it, then try again.' : error.message);
    process.exitCode = 1;
  });
  server.listen(5173, '127.0.0.1', () => {
    console.log(`Quran Repeater is ready at ${url}\nKeep this window open while reading. Press Ctrl+C to stop.`);
    openBrowser();
  });
}
