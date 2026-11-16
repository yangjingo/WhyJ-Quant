async (page) => {
  await page.setViewportSize({width:1440,height:900}); await page.reload();
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  const field = name => page.locator('.thesis-form [name="'+name+'"]');
  const inner = page.frameLocator('iframe[title="隔离交互报告"]').frameLocator('iframe[title="报告正文"]');
  const seen = [];
  for (const [kind,expected,observed] of [['price','价格观察','23'],['wording','未发现实质变化',''],['fundamental','待核实','']]) {
    await page.getByRole('button',{name:'登记事件复核',exact:true}).click();
    await field('kind').selectOption(kind); await field('summary').fill('合成边界验证 '+kind);
    await field('eventUrl').fill('https://example.com/'+kind);
    if (observed) {
      await field('after').fill(observed); await field('excerpt').fill('Synthetic fixed observation '+observed);
      await field('sourceUrl').fill('https://example.com/fixed-source');
      await page.getByText('附加固定价量图（可选）',{exact:true}).click();
      await field('priceUrl').fill('https://example.com/fixed-prices');
      const today = await page.evaluate(() => {const d = new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);});
      await field('prices').fill('date,open,high,low,close,vol\n2020-01-02,10,12,9,11,100\n'+today+',11,13,10,12,110');
    }
    if (kind === 'wording') {
      await field('decision').selectOption('maintain'); await field('rationale').fill('人工明确维持，措辞变化不替代证据。');
    }
    if (kind === 'fundamental') {
      await page.setViewportSize({width:390,height:844});
      await field('summary').scrollIntoViewIfNeeded();
      await page.screenshot({path:'output/playwright/thesis-dashboard/07-narrow-form.png'});
    }
    await page.getByRole('button',{name:'保存固定复核',exact:true}).click(); await page.locator('.thesis-success').waitFor();
    await page.getByRole('button',{name:'打开已保存报告',exact:true}).click();
    await page.getByRole('status').filter({hasText:'隔离交互预览'}).waitFor();
    if (!(await inner.locator('body').innerText()).includes(expected)) throw new Error('Incorrect '+kind+' classification');
    if (kind === 'price') {
      await inner.getByRole('region',{name:'日K K线图'}).scrollIntoViewIfNeeded();
      if (!await inner.locator('canvas').count()) throw new Error('Missing fixed price chart');
      await page.screenshot({path:'output/playwright/thesis-dashboard/08-fixed-price-chart.png'});
    }
    seen.push(expected);
    await page.getByRole('button',{name:'返回研究工作区',exact:true}).click();
    await page.setViewportSize({width:1440,height:900});
    if (!await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).isVisible()) await page.getByRole('button',{name:'切换研究概览',exact:true}).click();
    await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  }
  // A lost response after the real service persisted the result must not duplicate it on retry.
  await page.getByRole('button',{name:'登记事件复核',exact:true}).click();
  await field('summary').fill('合成：保存成功但响应丢失'); await field('eventUrl').fill('https://example.com/lost-response');
  const ids = []; let dropped = false;
  const route = async route => {
    const payload = route.request().postDataJSON();
    if (payload.method === 'saveThesisReview') {
      ids.push(payload.args[0].requestId);
      if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); return; }
    }
    await route.continue();
  };
  await page.route('**/api/workbench/rpc',route);
  await page.getByRole('button',{name:'保存固定复核',exact:true}).click();
  await page.locator('.thesis-content [role="alert"]').waitFor();
  if (await field('summary').inputValue() !== '合成：保存成功但响应丢失') throw new Error('Failed submit lost input');
  await page.screenshot({path:'output/playwright/thesis-dashboard/09-save-error.png'});
  await page.getByRole('button',{name:'保存固定复核',exact:true}).click(); await page.locator('.thesis-success').waitFor();
  await page.unroute('**/api/workbench/rpc',route);
  if (ids.length !== 2 || ids[0] !== ids[1]) throw new Error('Retry did not reuse request identity');
  await page.getByRole('button',{name:'返回固定记录',exact:true}).click();
  if (await page.locator('.thesis-record').filter({hasText:'合成：保存成功但响应丢失'}).count() !== 1) throw new Error('Duplicate saved records');
  await page.keyboard.press('Escape');
  return {outcomes:seen,lostResponseRetryReusedId:true,duplicateRecords:0};
}
