async (page) => {
  const origin = new URL(page.url()).origin;
  const cases = { fundamental: 'assumption_review', price: 'price_observation', missing: 'pending_verification', wording: 'no_material_change' };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [name, outcome] of Object.entries(cases)) {
    await page.goto(origin + '/' + name);
    await page.locator('[data-thesis-outcome="' + outcome + '"]').waitFor();
    if (!await page.getByRole('button', { name: 'Share preview', exact: true }).isDisabled()) throw new Error('Private report enabled sharing');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('heading', { name: '旧假设与本次观察', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/thesis-review/' + name + '-comparison.png', scale: 'css' });
  }
  await page.goto(origin + '/fundamental');
  await page.locator('#thesis-price canvas').first().waitFor();
  const annotation = await page.locator('#thesis-price').evaluate(element => window.echarts.getInstanceByDom(element).getOption().series[0].markLine.data);
  if (annotation[0].xAxis !== '2026-11-13') throw new Error('Exact event-date chart annotation missing');
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('heading', { name: '旧假设与本次观察', exact: true }).scrollIntoViewIfNeeded();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Document overflows at ' + width);
    await page.screenshot({ path: 'output/playwright/thesis-review/comparison-' + width + '.png', scale: 'css' });
    await page.locator('#thesis-price').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/thesis-review/chart-' + width + '.png', scale: 'css' });
  }
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  await page.locator('.ec-raw pre').waitFor();
  if (!(await page.locator('.ec-raw pre').innerText()).includes('2026-11-13')) throw new Error('Raw values missing');
  await page.getByRole('button', { name: 'Trajectory', exact: true }).click();
  await page.getByRole('heading', { name: '手动复核', exact: true }).waitFor();
  if (errors.length) throw new Error(errors.join('\n'));
  return { synthetic: true, standaloneRenderer: true, cases, annotation, viewports: 3, sharingDisabled: true, errors };
}
