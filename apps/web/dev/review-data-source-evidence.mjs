import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function captureDataSource({ browser, output, root }) {
  const directory = join(output, 'data-source'); await mkdir(directory, { recursive: true });
  const child = spawn('bun', ['run', 'tests/app/dev/data-source-settings-fixture.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', exited = false; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  child.on('error', error => { logs += String(error); });
  let context;
  try {
    let fixture;
    for (let i = 0; i < 300 && !fixture; i++) {
      for (const line of logs.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.origin && value.control && value.synthetic) fixture = value; } catch { /* Wait for fixture receipt. */ } }
      if (exited) throw new Error('Synthetic data Host exited: ' + logs);
      if (!fixture) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!fixture) throw new Error('Synthetic data Host did not become ready: ' + logs);
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(directory, 'video') } });
    const page = await context.newPage(); await page.goto(fixture.origin);
    const run = (0, eval)(await readFile(join(root, 'apps/web/dev/data-source-settings-evidence.cjs'), 'utf8'));
    return await run({ page, control: fixture.control, output: directory });
  } finally {
    await context?.close(); if (!exited) child.kill('SIGTERM'); await closed;
  }
}
