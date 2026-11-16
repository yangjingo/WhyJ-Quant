async (page, output = 'output/playwright/report-ui') => {
  const attempts = [];
  await page.route('**/security-probe/**', route => { attempts.push(route.request().url()); return route.fulfill({ status: 200, body: 'unexpected network access' }); });
  const shell = page.frameLocator('iframe[title="隔离交互报告"]');
  const inner = () => shell.frameLocator('iframe[title="报告正文"]');
  const origin = await page.evaluate(() => location.origin);
  const html = `<!doctype html><html><head><base href="${origin}/security-probe/base/"><meta http-equiv="refresh" content="0;url=${origin}/security-probe/meta"><link rel="stylesheet" href="${origin}/security-probe/style"></head><body>
    <img src="${origin}/security-probe/image"><style>body{background-image:url('${origin}/security-probe/css')}</style>
    <iframe src="${origin}/security-probe/frame"></iframe><script src="${origin}/security-probe/script"></script>
    <p id="result">waiting</p><a href="${origin}/security-probe/link" id="link">link</a>
    <form action="${origin}/security-probe/form"><button>form</button></form>
    <script>
      const result={};try{parent.document.body;result.parent=true}catch{result.parent=false}
      try{localStorage.getItem('token');result.storage=true}catch{result.storage=false}
      fetch('${origin}/security-probe/fetch').catch(()=>{});
      new Image().src='${origin}/security-probe/script-image';
      try{navigator.sendBeacon('${origin}/security-probe/beacon','synthetic')}catch{}
      try{window.open('${origin}/security-probe/popup')}catch{}
      try{top.location='${origin}/security-probe/top'}catch{}
      document.getElementById('result').textContent=JSON.stringify(result);
    </script></body></html>`;
  const render = async value => {
    await page.locator('iframe[title="隔离交互报告"]').evaluate((frame, html) => frame.contentWindow.postMessage({ type: 'render-report', id: 'synthetic-security', html, echarts: '' }, location.origin), value);
    await inner().locator('#result').waitFor();
  };
  await render(html);
  const privileges = JSON.parse(await inner().locator('#result').textContent());
  if (privileges.parent || privileges.storage) throw new Error('Report gained application authority');
  if (await inner().locator('base,iframe,script[src],meta[http-equiv=refresh],link').count()) throw new Error('Untrusted resource elements survived transformation');
  await inner().getByRole('button', { name: 'form', exact: true }).click();
  await inner().getByRole('link', { name: 'link', exact: true }).click();
  await page.waitForTimeout(300);
  await render(html);
  await inner().locator('#result').evaluate((element, destination) => { location.href = destination; }, origin + '/security-probe/self-navigation');
  await page.waitForTimeout(300);
  if (attempts.length) throw new Error('Network escaped isolation: ' + JSON.stringify(attempts));
  await page.screenshot({ path: output + '/07-blocked-navigation.png', scale: 'css' });
  await page.unroute('**/security-probe/**');
  return { synthetic: true, networkRequests: attempts, privileges, removedExternalElements: true, formAndSelfNavigation: 'blocked', parentUrl: page.url() };
}
