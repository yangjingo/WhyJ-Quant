import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// CI evidence uses an isolated temporary Host and synthetic market/disclosure fixtures.
export async function captureThesis({ browser, output, root }) {
  const directory = join(output, 'thesis');
  const sourceDir = join(directory, 'sources'), tspDir = join(directory, 'tsp');
  await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(tspDir, { recursive: true })]);
  const child = spawn('bun', ['run', 'tests/app/dev/report-preview-fixture.ts', '--sources', '--tsp'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', exited = false;
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  child.on('error', error => { logs += String(error); });
  let context;
  try {
    let fixture;
    for (let i = 0; i < 300 && !fixture; i++) {
      for (const line of logs.split(/\r?\n/)) {
        try { const value = JSON.parse(line); if (value.origin && value.control && value.sources) fixture = value; } catch { /* Wait for fixture receipt. */ }
      }
      if (exited) throw new Error('Synthetic Host exited: ' + logs);
      if (!fixture) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!fixture) throw new Error('Synthetic Host did not become ready: ' + logs);
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(fixture.origin);
    const run = async name => (0, eval)(await readFile(join(root, 'apps/web/dev', name), 'utf8'));
    const sources = await (await run('thesis-sources-evidence.cjs'))(page, sourceDir);
    const sourceBoundary = await (await run('thesis-sources-boundary-evidence.cjs'))(page, fixture.control, sourceDir);
    const tsp = await (await run('thesis-tsp-evidence.cjs'))(page, tspDir);
    const tspBoundary = await (await run('thesis-tsp-boundary-evidence.cjs'))(page, fixture.control, tspDir);
    return { synthetic: true, sources, sourceBoundary, tsp, tspBoundary };
  } finally {
    await context?.close();
    if (!exited) child.kill('SIGTERM');
    await closed;
  }
}
