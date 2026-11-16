async (page, output = 'output/playwright/thesis-dashboard') => {
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  await page.setViewportSize({width:1440,height:900});
  await page.reload();
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).waitFor();
  if (await page.getByRole('button', {name:'收起会话',exact:true}).count()) await page.getByRole('button', {name:'收起会话',exact:true}).click();
  await page.getByRole('combobox', {name:'研究问题',exact:true}).fill('这条未发送草稿必须保留');
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.getByRole('button',{name:'设立假设基线',exact:true}).click();
  const field = name => page.locator('.thesis-form [name="'+name+'"]');
  for (const [name,value] of Object.entries({group:'synthetic-group',symbol:'600000.SH',statement:'合成假设：毛利率至少为 20 percent',metric:'margin',period:'2026-Q3',unit:'percent',definition:'consolidated gross margin',before:'22',threshold:'20'})) await field(name).fill(value);
  await page.screenshot({path:output+'/01-baseline.png'});
  await page.getByRole('button',{name:'明确设立并保存基线',exact:true}).click();
  await page.locator('.thesis-success').waitFor();
  await page.getByRole('button',{name:'返回固定记录',exact:true}).click();
  await page.getByRole('button',{name:'复核此假设',exact:true}).first().click();
  for (const [name,value] of Object.entries({summary:'合成披露更正：毛利率降为 18 percent',eventUrl:'https://example.com/event',sourceUrl:'https://example.com/disclosure',after:'18',excerpt:'Synthetic source disclosure: consolidated gross margin 18 percent in 2026-Q3.'})) await field(name).fill(value);
  await page.screenshot({path:output+'/02-review-form.png'});
  await page.getByRole('button',{name:'保存固定复核',exact:true}).click();
  await page.locator('.thesis-success').waitFor();
  await page.getByRole('button',{name:'打开已保存报告',exact:true}).click();
  await page.getByRole('status').filter({hasText:'隔离交互预览'}).waitFor();
  const inner = page.frameLocator('iframe[title="隔离交互报告"]').frameLocator('iframe[title="报告正文"]');
  if (!(await inner.locator('body').innerText()).includes('假设待复核')) throw new Error('Expected fundamental classification');
  await page.screenshot({path:output+'/03-fixed-review.png'});
  await page.getByRole('button',{name:'返回研究工作区',exact:true}).click();
  if (await page.getByRole('combobox',{name:'研究问题',exact:true}).inputValue() !== '这条未发送草稿必须保留') throw new Error('Draft changed');
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.locator('.thesis-record').filter({hasText:'需要复核假设'}).first().waitFor();
  for (const [width,height,name] of [[1440,900,'04-wide-list'],[1024,768,'04-medium-list'],[390,844,'05-narrow-list'],[1024,480,'06-low-list']]) {
    await page.setViewportSize({width,height});
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Page overflow at '+name);
    if (await page.locator('.thesis-dialog').evaluate(el => el.scrollWidth > el.clientWidth)) throw new Error('Dialog overflow at '+name);
    await page.screenshot({path:output+'/'+name+'.png'});
  }
  await page.getByRole('button',{name:'查看原基线',exact:true}).first().click();
  await page.getByRole('status').filter({hasText:'隔离交互预览'}).waitFor();
  if (!(await inner.locator('body').innerText()).includes('人工设立的基线')) throw new Error('Wrong previous artifact');
  await page.getByRole('button',{name:'返回研究工作区',exact:true}).click();
  if (failures.length) throw new Error(failures.join('\n'));
  return {flow:'baseline -> review -> exact HTML -> prior baseline',draftPreserved:true,pageErrors:failures};
}
