// Run against the isolated report-preview-host fixture using playwright-cli run-code --filename.
async (page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const draft = page.getByRole('combobox', { name: '研究问题', exact: true });
  await draft.fill('保留这条未发送草稿');
  const open = async (index = 0) => {
    await page.getByRole('button', { name: '研究成果', exact: true }).click();
    await page.getByRole('tab', { name: '报告版本', exact: true }).click();
    await page.getByRole('button', { name: '打开交互报告', exact: true }).nth(index).click();
  };
  const close = () => page.getByRole('button', { name: '返回研究工作区', exact: true }).click();
  await open(1);
  await page.getByRole('heading', { name: '报告内容为空', exact: true }).waitFor();
  if (!await page.getByRole('button', { name: '下载原始 HTML', exact: true }).isEnabled()) throw new Error('Verified empty file cannot be downloaded');
  await page.screenshot({ path: 'output/playwright/report-ui/08-empty.png' });
  await close();

  await page.route('**/api/workbench/report', route => route.fulfill({ status: 409, contentType: 'text/plain', body: 'Synthetic immutable report mismatch' }));
  await open();
  await page.getByRole('alert').waitFor();
  if (await page.getByRole('button', { name: '下载原始 HTML', exact: true }).isEnabled()) throw new Error('Invalid report enabled download');
  await page.screenshot({ path: 'output/playwright/report-ui/09-read-error.png' });
  await page.unroute('**/api/workbench/report');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '隔离交互预览' }).waitFor();
  await close();
  if (await draft.inputValue() !== '保留这条未发送草稿') throw new Error('Read/retry lost draft');

  await page.route('**/assets/report-shell.html', route => route.fulfill({ status: 503, contentType: 'text/html', body: '<p>Synthetic unavailable shell</p>' }));
  await open();
  await page.getByRole('alert').filter({ hasText: '隔离预览加载超时' }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: 'output/playwright/report-ui/10-preview-timeout.png' });
  await page.unroute('**/assets/report-shell.html');
  await close();

  let release, requested, handled;
  const waiting = new Promise(resolve => { requested = resolve; });
  const delay = new Promise(resolve => { release = resolve; });
  const completed = new Promise(resolve => { handled = resolve; });
  await page.route('**/api/workbench/report', async route => { requested(); await delay; await route.continue(); handled(); });
  await open(); await waiting;
  await page.getByRole('status').filter({ hasText: '正在读取并核验' }).waitFor();
  await page.screenshot({ path: 'output/playwright/report-ui/11-loading.png' });
  await close(); release(); await completed;
  await page.unroute('**/api/workbench/report');
  if (await draft.inputValue() !== '保留这条未发送草稿') throw new Error('Late response lost draft');
  await open();
  await page.getByRole('status').filter({ hasText: '隔离交互预览' }).waitFor();
  // Switching sessions unmounts the old report and restores the session workspace.
  await page.getByTitle('展开会话侧栏', { exact: true }).click();
  await page.locator('.session-select').filter({ hasText: '新研究' }).click();
  await page.getByRole('combobox', { name: '研究问题', exact: true }).waitFor();
  if (await page.locator('.report-view').count()) throw new Error('Previous session report leaked into new session');
  await page.locator('.session-select').filter({ hasText: '报告体验 · 合成研究' }).click();
  await draft.waitFor();
  if (await draft.inputValue() !== '保留这条未发送草稿') throw new Error('Session switch lost draft');
  return { empty: true, readErrorRetry: true, shellTimeout: true, loadingReturn: true, sessionSwitch: true, draftPreserved: true };
}
