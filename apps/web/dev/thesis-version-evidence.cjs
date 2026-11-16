async (page) => {
  let current, submitted;
  const route = async route => {
    const payload = route.request().postDataJSON();
    if (payload.method === 'session') {
      const response = await route.fetch(), body = await response.json();
      const artifact = body.result.output.artifacts.find(item => item.id === 'synthetic-report');
      if (artifact) { current = artifact; body.result.output.artifacts.unshift({...artifact,sha256:'0'.repeat(64),title:'Synthetic unavailable prior revision'}); }
      await route.fulfill({response,json:body}); return;
    }
    if (payload.method === 'establishThesis') submitted = payload.args[0];
    await route.continue();
  };
  await page.setViewportSize({width:1440,height:900}); await page.route('**/api/workbench/rpc',route); await page.reload();
  await page.getByRole('button',{name:'查看复核记录 ↗',exact:true}).click();
  await page.getByRole('button',{name:'设立假设基线',exact:true}).click();
  const field = name => page.locator('.thesis-form [name="'+name+'"]');
  await field('source').selectOption('synthetic-report@'+current.sha256);
  for (const [name,value] of Object.entries({group:'exact-version',symbol:'600000.SH',statement:'Exact selected version check',metric:'margin',period:'2026-Q3',unit:'percent',definition:'consolidated gross margin',before:'22',threshold:'20'})) await field(name).fill(value);
  await page.getByRole('button',{name:'明确设立并保存基线',exact:true}).click(); await page.locator('.thesis-success').waitFor();
  if (submitted.sha256 !== current.sha256 || submitted.artifactId !== current.id) throw new Error('Selected prior/new revision identity was replaced');
  await page.unrouteAll({behavior:'wait'}); await page.keyboard.press('Escape'); await page.reload();
  return {sameArtifactMultipleRevisions:true,selectedExactHash:submitted.sha256,realServiceSave:true};
}
