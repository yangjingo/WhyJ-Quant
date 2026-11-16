import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

// Requires the isolated report-preview-fixture.ts --desktop Host, not a personal workspace.
const root = resolve(import.meta.dirname, '../../..');
const fixture = JSON.parse(readFileSync(join(root, 'output/127/desktop-fixture.json'), 'utf8'));
const output = join(root, 'output/playwright/thesis-tsp-desktop'); mkdirSync(output, {recursive:true});
if (!fixture.tspLog) throw new Error('Requires the isolated --desktop --tsp fixture');
const env = {...process.env,WHYJ_DESKTOP_HOME:fixture.desktopHome,OHQUANT_DIR:fixture.root,WHYJ_RESOURCE_LEASE_ROOT:join(fixture.root,'leases'),OHQUANT_SKILLS_DIR:join(fixture.root,'skills')};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({args:[join(root,'apps/desktop')],env,timeout:60000});
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.getByRole('button',{name:'研究成果',exact:true}).waitFor({timeout:45000});
  assert.equal(await page.evaluate(() => location.origin),'app://desktop');
  await page.getByTitle('展开会话侧栏',{exact:true}).click();
  await page.locator('.session-select').filter({hasText:'报告体验 · 合成研究'}).click();
  const flow = await runInThisContext('('+readFileSync(join(root,'apps/web/dev/thesis-tsp-evidence.cjs'),'utf8')+')')(page,output);
  if (!await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).isVisible()) await page.getByRole('button',{name:'切换研究概览',exact:true}).click();
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.locator('.thesis-record').filter({hasText:flow.review.sha256.slice(0,12)}).getByRole('button',{name:'打开固定报告',exact:true}).click();
  await page.getByRole('status').filter({hasText:'隔离交互预览'}).waitFor();
  await page.screenshot({path:join(output,'fixed-review.png')});
  const destination = join(output,'original-review.html');
  await app.evaluate(({session},path) => {
    globalThis.thesisDownload = 'waiting';
    session.defaultSession.once('will-download',(_event,item) => {item.setSavePath(path);item.once('done',(_event,state) => {globalThis.thesisDownload=state;});});
  },destination);
  await page.getByRole('button',{name:'下载原始 HTML',exact:true}).click();
  let state = 'waiting';
  for(let i=0;i<100 && state==='waiting';i++){await new Promise(done=>setTimeout(done,100));state=await app.evaluate(()=>globalThis.thesisDownload);}
  assert.equal(state,'completed');
  const record = readdirSync(join(fixture.root,'artifacts')).filter(name=>name.endsWith('.report.json')).map(name=>JSON.parse(readFileSync(join(fixture.root,'artifacts',name),'utf8'))).find(item=>item.meta.sessionId===flow.review.id && item.meta.revision===flow.review.sha256);
  assert.ok(record);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(readFileSync(destination)),digest(record.html));
  const result = {synthetic:true,origin:'app://desktop',flow,nativeDownloadSha256:digest(record.html),at:new Date().toISOString()};
  writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error) {
  writeFileSync(join(output,'failure.txt'),error.stack||String(error));
  if(app) await (await app.firstWindow()).screenshot({path:join(output,'failure.png')}).catch(()=>{});
  throw error;
} finally {if(app) await app.close();}
