import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('Please install Node.js 22.12 or newer from https://nodejs.org, then run npm run init again.');
  process.exit(1);
}

async function runNpm(args) {
  await new Promise((done, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Setup stopped (${signal || `exit ${code}`}). Run npm run init to try again.`)));
  });
}

try {
  const required = ['react', 'react-dom', '@phosphor-icons/react', 'vite', '@vitejs/plugin-react'];
  const installed = await Promise.all(required.map(name => access(resolve(root, 'node_modules', name, 'package.json')).then(() => true, () => false)));
  if (installed.some(value => !value)) {
    console.log('First-time setup: installing dependencies. This step requires internet.');
    await runNpm(['ci']);
  }
  await runNpm(['run', 'build']);
  console.log('The complete recitation downloads automatically on first launch. Watch its progress in the reader.');
  await import('./launch.mjs');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
