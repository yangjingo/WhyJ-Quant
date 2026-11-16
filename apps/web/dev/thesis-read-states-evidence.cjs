async (page) => {
  await page.setViewportSize({width:1440,height:900});
  if (await page.getByRole('button',{name:'停止生成',exact:true}).count()) await page.getByRole('button',{name:'停止生成',exact:true}).click();
  let fail = true, delayed = false;
  const route = async route => {
    if (route.request().postDataJSON().method === 'readThesis') {
      if (fail) { await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:{message:'Synthetic fixed record unavailable'}})}); return; }
      if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve,1500)); }
    }
    await route.continue();
  };
  await page.route('**/api/workbench/rpc',route); await page.reload();
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.locator('.thesis-content [role="alert"]').waitFor();
  await page.screenshot({path:'output/playwright/thesis-dashboard/11-unavailable.png'});
  fail = false;
  await page.locator('.thesis-content').getByRole('button',{name:'重新读取记录',exact:true}).click();
  await page.locator('.thesis-content [role="status"]').waitFor();
  await page.screenshot({path:'output/playwright/thesis-dashboard/12-loading.png'});
  await page.locator('.thesis-record').first().waitFor();
  await page.unroute('**/api/workbench/rpc',route);
  await page.keyboard.press('Escape');
  return {unavailableDistinct:true,loadingDistinct:true,explicitRetryRecovered:true};
}
