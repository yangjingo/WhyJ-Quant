import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

// Seed first: bun run tests/app/dev/report-preview-fixture.ts --desktop.
// Only the fixture's temporary home/storage is used; never the user's Desktop profile.
const root = resolve(import.meta.dirname, '../../..');
const fixture = JSON.parse(readFileSync(join(root, 'output/127/desktop-fixture.json'), 'utf8'));
const output = join(root, 'output/playwright/report-desktop');
mkdirSync(output, { recursive: true });
const env = { ...process.env, WHYJ_DESKTOP_HOME: fixture.desktopHome, OHQUANT_DIR: fixture.root,
  WHYJ_RESOURCE_LEASE_ROOT: join(fixture.root, 'leases'), OHQUANT_SKILLS_DIR: join(fixture.root, 'skills') };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await electron.launch({ args: [join(root, 'apps/desktop')], env, timeout: 60_000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '研究成果', exact: true }).waitFor({ timeout: 45_000 });
  console.log('Desktop workbench connected');
  await page.getByTitle('展开会话侧栏', { exact: true }).click();
  await page.locator('.session-select').filter({ hasText: '报告体验 · 合成研究' }).click();
  await page.getByRole('combobox', { name: '研究问题', exact: true }).fill('Desktop 报告验收草稿');
  await page.getByRole('button', { name: '研究成果', exact: true }).click();
  await page.getByRole('tab', { name: '报告版本', exact: true }).click();
  await page.getByRole('button', { name: '打开交互报告', exact: true }).first().click();
  console.log('Report requested');
  await page.getByRole('status').filter({ hasText: '隔离交互预览' }).waitFor({ timeout: 25_000 });
  assert.equal(await page.evaluate(() => location.origin), 'app://desktop');
  const report = page.frameLocator('iframe[title="隔离交互报告"]').frameLocator('iframe[title="报告正文"]');
  const originalTheme = await report.locator('html').getAttribute('data-theme');
  await report.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  assert.notEqual(await report.locator('html').getAttribute('data-theme'), originalTheme);
  await report.getByRole('button', { name: 'Trajectory', exact: true }).click();
  await report.getByRole('heading', { name: '合成轨迹', exact: true }).waitFor();
  await report.getByRole('button', { name: 'Dashboard', exact: true }).click();
  assert.ok(await report.locator('canvas').count());
  await page.screenshot({ path: join(output, 'report.png') });
  const downloaded = join(output, 'original.html');
  // Electron owns DownloadItem and its native save dialog, not Playwright's Page download event.
  await application.evaluate(({ session }, destination) => {
    globalThis.reportDownload = { state: 'waiting' };
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(destination);
      item.once('done', (_event, state) => { globalThis.reportDownload = { state }; });
    });
  }, downloaded);
  await page.getByRole('button', { name: '下载原始 HTML', exact: true }).click();
  let downloadState = 'waiting';
  for (let attempt = 0; attempt < 100 && downloadState === 'waiting'; attempt++) {
    await new Promise(done => setTimeout(done, 100));
    downloadState = await application.evaluate(() => globalThis.reportDownload.state);
  }
  assert.equal(downloadState, 'completed');
  const stored = JSON.parse(readFileSync(join(fixture.root, 'artifacts/synthetic-report.report.json'), 'utf8'));
  const hash = createHash('sha256').update(readFileSync(downloaded)).digest('hex');
  assert.equal(hash, createHash('sha256').update(stored.html).digest('hex'));
  await page.getByRole('button', { name: '返回研究工作区', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '研究问题', exact: true }).inputValue(), 'Desktop 报告验收草稿');
  assert.equal(await page.locator('#sessionTitle').evaluate(element => element === document.activeElement), true);
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: '研究成果', exact: true }).click();
  await page.getByRole('tab', { name: '报告版本', exact: true }).click();
  await page.getByRole('button', { name: '打开交互报告', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '隔离交互预览' }).waitFor();
  const security = await runInThisContext('(' + readFileSync(join(root, 'apps/web/dev/report-security-evidence.cjs'), 'utf8') + ')')(page, output);
  const result = { synthetic: true, origin: 'app://desktop', theme: true, trajectory: true, chart: true,
    originalSha256: hash, draftPreserved: true, returnFocus: true, security, errors, at: new Date().toISOString() };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(join(output, 'failure.txt'), error.stack || String(error));
  if (application) await (await application.firstWindow()).screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally { if (application) await application.close(); }
