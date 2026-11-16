async (page) => {
  if (!await page.locator('.report-view').count()) {
    await page.getByRole('combobox', { name: '研究问题', exact: true }).fill('保留这条未发送草稿');
    await page.getByRole('button', { name: '研究成果', exact: true }).click();
    await page.getByRole('tab', { name: '报告版本', exact: true }).click();
    await page.getByRole('button', { name: '打开交互报告', exact: true }).first().click();
  }
  await page.getByRole('status').filter({ hasText: '隔离交互预览' }).waitFor();
  const report = page.frameLocator('iframe[title="隔离交互报告"]').frameLocator('iframe[title="报告正文"]');
  const theme = await report.locator('html').getAttribute('data-theme');
  await report.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  if (await report.locator('html').getAttribute('data-theme') === theme) throw new Error('Theme did not change');
  await report.getByRole('button', { name: 'Raw', exact: true }).click();
  await report.locator('.ec-raw pre').waitFor();
  if (!(await report.locator('.ec-raw pre').innerText()).includes('2026-08-01')) throw new Error('Raw observations missing');
  await report.getByRole('button', { name: 'Trajectory', exact: true }).click();
  await report.getByRole('heading', { name: '合成轨迹', exact: true }).waitFor();
  await report.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await report.getByRole('button', { name: 'Chart', exact: true }).click();
  if (await report.locator('canvas').count() < 1) throw new Error('Actual ECharts canvas missing');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载原始 HTML', exact: true }).click();
  const download = await downloading;
  await download.saveAs('output/playwright/report-ui/original.html');
  await page.getByRole('button', { name: '返回研究工作区', exact: true }).click();
  const draft = await page.getByRole('combobox', { name: '研究问题', exact: true }).inputValue();
  if (draft !== '保留这条未发送草稿') throw new Error('Draft changed on return: ' + draft);
  await page.getByRole('button', { name: '研究成果', exact: true }).click();
  await page.getByRole('tab', { name: '报告版本', exact: true }).click();
  await page.getByRole('button', { name: '打开交互报告', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '隔离交互预览' }).waitFor();
  for (const [width,height,name] of [[1440,900,'04-wide-chart'],[1024,768,'05-medium'],[390,844,'06-narrow-chart']]) {
    await page.setViewportSize({ width, height });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('App overflow: ' + name);
    await report.getByRole('region', { name: '日K K线图' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/report-ui/' + name + '.png', scale: 'css' });
  }
  return { themeChanged: true, rawValues: true, charts: 'actual ECharts canvas', trajectory: 'visible', draftPreserved: true, originalDownload: download.suggestedFilename(), captures: 3 };
}
