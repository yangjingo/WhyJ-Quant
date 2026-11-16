async (page, output = 'output/playwright/thesis-tsp') => {
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:1440,height:900}); await page.reload();
  await page.getByRole('button',{name:'研究成果',exact:true}).waitFor();
  if (!await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).isVisible()) await page.getByRole('button',{name:'切换研究概览',exact:true}).click();
  if (await page.getByTitle('展开会话侧栏',{exact:true}).isVisible()) await page.getByTitle('展开会话侧栏',{exact:true}).click();
  if (await page.locator('.session-select').filter({hasText:'报告体验 · 合成研究'}).isVisible()) await page.locator('.session-select').filter({hasText:'报告体验 · 合成研究'}).click();
  if (await page.getByRole('button',{name:'收起会话',exact:true}).count()) await page.getByRole('button',{name:'收起会话',exact:true}).click();
  await page.getByRole('combobox',{name:'研究问题',exact:true}).fill('TSP 查看后仍应保留的未发送草稿');
  if (!await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).isVisible()) await page.getByRole('button',{name:'切换研究概览',exact:true}).click();
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.getByRole('button',{name:'设立假设基线',exact:true}).click();
  const field=name=>page.locator('.thesis-form [name="'+name+'"]');
  for (const [name,value] of Object.entries({group:'合成 TSP 观察组',symbol:'600000.SH',statement:'合成毛利率基线不因价格提醒自动失效',metric:'margin',period:'2026-Q3',unit:'percent',definition:'consolidated gross margin',before:'22',threshold:'20'})) await field(name).fill(value);
  await page.getByRole('button',{name:'明确设立并保存基线',exact:true}).click(); await page.locator('.thesis-success').waitFor();
  await page.getByRole('button',{name:'返回固定记录',exact:true}).click();
  await page.locator('.thesis-record').filter({hasText:'合成毛利率基线不因价格提醒自动失效'}).first().getByRole('button',{name:'复核此假设',exact:true}).click();
  const responseFor=method=>page.waitForResponse(response=>response.url().endsWith('/api/workbench/rpc') && response.request().postDataJSON()?.method===method);
  const collecting=responseFor('collectThesisTsp');
  await page.getByRole('button',{name:'采集一次 TSP 观察',exact:true}).click();
  const capture=(await (await collecting).json()).result;
  if (!capture?.artifact || capture.alerts.length!==1 || capture.omittedAlerts!==2 || capture.daily?.count!==2) throw new Error('Unexpected retained TSP preview '+JSON.stringify(capture));
  await page.getByRole('combobox',{name:'使用提醒作为价格事件',exact:true}).selectOption('0');
  await page.getByLabel('使用 TSP 固定日线绘图',{exact:true}).check();
  await page.getByRole('combobox',{name:'确认 TSP 成交量单位',exact:true}).selectOption('lots');
  if (await field('kind').inputValue()!=='price' || !(await field('kind').isDisabled())) throw new Error('Selected alert must remain price-only');
  if (await field('summary').inputValue()!=='Synthetic source price move <safe>') throw new Error('Source event changed');
  for (const [width,height,name] of [[1440,900,'01-wide-source'],[1024,768,'02-medium-source'],[390,844,'03-narrow-source']]) {
    await page.setViewportSize({width,height}); await page.locator('.thesis-tsp h3').scrollIntoViewIfNeeded();
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw new Error('Page overflow '+name);
    if(await page.locator('.thesis-dialog').evaluate(el=>el.scrollWidth>el.clientWidth)) throw new Error('Dialog overflow '+name);
    await page.screenshot({path:output+'/'+name+'.png'});
    if(width===390){ await page.getByRole('combobox',{name:'确认 TSP 成交量单位',exact:true}).scrollIntoViewIfNeeded(); await page.screenshot({path:output+'/03b-narrow-window.png'}); }
  }
  await page.setViewportSize({width:1440,height:900});
  const saving=responseFor('saveThesisReview'); await page.getByRole('button',{name:'保存固定复核',exact:true}).click();
  const response=await saving, payload=response.request().postDataJSON().args[0], saved=(await response.json()).result;
  if(!saved?.sha256) throw new Error('Review did not save '+JSON.stringify(await response.json()));
  if(payload.tsp?.revision!==capture.artifact.sha256 || payload.retainedEvidence.length || payload.price!==null) throw new Error('UI reposted raw input or changed source identity');
  await page.locator('.thesis-success').waitFor(); await page.getByRole('button',{name:'打开已保存报告',exact:true}).click();
  await page.getByRole('status').filter({hasText:'隔离交互预览'}).waitFor();
  const inner=page.frameLocator('iframe[title="隔离交互报告"]').frameLocator('iframe[title="报告正文"]');
  const text=await inner.locator('body').innerText();
  if(!text.includes('价格观察') || !text.includes(capture.artifact.sha256) || !text.includes('成交量单位 手')) throw new Error('Missing fixed source semantics');
  await inner.getByRole('region',{name:'日K K线图'}).scrollIntoViewIfNeeded();
  if (!await inner.locator('canvas').count()) throw new Error('Missing saved TSP chart');
  await page.screenshot({path:output+'/04-price-review.png'});
  await page.getByRole('button',{name:'返回研究工作区',exact:true}).click();
  if(await page.getByRole('combobox',{name:'研究问题',exact:true}).inputValue()!=='TSP 查看后仍应保留的未发送草稿') throw new Error('Draft lost');
  if (!await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).isVisible()) await page.getByRole('button',{name:'切换研究概览',exact:true}).click();
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.locator('.thesis-record').filter({hasText:'Synthetic source price move <safe>'}).first().getByRole('button',{name:'查看固定 TSP 来源',exact:true}).click();
  await page.getByRole('status').filter({hasText:'隔离交互预览'}).waitFor();
  if(!(await inner.locator('body').innerText()).includes('原始 JSON')) throw new Error('Missing original tool report');
  await page.screenshot({path:output+'/05-original-observation.png'});
  await page.getByRole('button',{name:'返回研究工作区',exact:true}).click();
  if(errors.length) throw new Error(errors.join('\n'));
  return {synthetic:true,source:capture.artifact,review:saved,rawPosted:false,priceOnly:true,volumeUnit:'lots',excludedOtherAlerts:2,closedDailyCount:2,errors};
}
