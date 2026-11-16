async (page) => {
  await page.setViewportSize({width:1440,height:900});
  if (!await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).isVisible()) await page.getByRole('button',{name:'切换研究概览',exact:true}).click();
  await page.getByRole('combobox',{name:'研究问题',exact:true}).fill('运行中保留的未发送草稿');
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.getByRole('button',{name:'登记事件复核',exact:true}).click();
  if (await page.getByRole('button',{name:'保存固定复核',exact:true}).isEnabled()) throw new Error('Write enabled during run');
  await page.getByText('当前研究仍在运行。可以查看固定记录，请在运行结束后保存。',{exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/thesis-dashboard/10-running-read-only.png'});
  await page.getByRole('button',{name:'固定记录',exact:true}).click();
  await page.getByRole('button',{name:'打开固定报告',exact:true}).first().click();
  await page.getByRole('status').filter({hasText:'隔离交互预览'}).waitFor();
  await page.getByRole('button',{name:'返回研究工作区',exact:true}).click();
  if (await page.getByRole('combobox',{name:'研究问题',exact:true}).inputValue() !== '运行中保留的未发送草稿') throw new Error('Active draft changed');
  if (await page.locator('.run-badge').getAttribute('data-state') !== 'running') throw new Error('Run ended during reading');
  return {activeRead:true,writeDisabled:true,draftPreserved:true};
}
