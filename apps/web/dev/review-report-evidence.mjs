import { spawn } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Synthetic Host and report: no personal workspace, provider or credentials.
export async function captureReport({ browser, output, root }) {
  const local = join(root, 'output/playwright/report-ui'), directory = join(output, 'report');
  await Promise.all([mkdir(local, { recursive: true }), mkdir(directory, { recursive: true })]);
  const child = spawn('bun', ['run', 'tests/app/dev/report-preview-fixture.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
        try { const value = JSON.parse(line); if (value.origin && value.identity) fixture = value; } catch { /* Wait for the fixture receipt. */ }
      }
      if (exited) throw new Error('Synthetic Host exited: ' + logs);
      if (!fixture) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!fixture) throw new Error('Synthetic Host did not become ready: ' + logs);
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage(); await page.goto(fixture.origin);
    await page.getByRole('button', { name: '研究成果', exact: true }).waitFor();
    await page.getByTitle('展开会话侧栏', { exact: true }).click();
    await page.locator('.session-select').filter({ hasText: '报告体验 · 合成研究' }).click();
    await page.waitForFunction(() => document.querySelector('#sessionTitle')?.textContent?.includes('报告体验 · 合成研究'));
    const run = async name => (0, eval)(await readFile(join(root, 'apps/web/dev', name), 'utf8'));
    const interaction = await (await run('report-interaction-evidence.cjs'))(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.frameLocator('iframe[title="隔离交互报告"]').frameLocator('iframe[title="报告正文"]').locator('body').evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(directory, '00-report-overview.png'), scale: 'css' });
    const security = await (await run('report-security-evidence.cjs'))(page, directory);
    for (const name of ['04-wide-chart.png', '05-medium.png', '06-narrow-chart.png']) await cp(join(local, name), join(directory, name));
    return { synthetic: true, interaction, security };
  } finally {
    await context?.close();
    if (!exited) child.kill('SIGTERM');
    await closed;
  }
}
