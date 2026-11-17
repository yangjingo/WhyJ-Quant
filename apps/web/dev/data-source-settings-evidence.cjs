async ({ page, control, output }) => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const setMode = async value => { const response = await fetch(control + '/mode?value=' + value); if (!response.ok) throw new Error('Fixture mode failed'); };
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 900 });
  const rejectDraft = (status, code) => async route => {
    const payload = route.request().postDataJSON();
    if (payload.method === 'startDataDraft') return route.fulfill({ status, json: { ok: false, error: { code, message: 'synthetic failure' } } });
    return route.continue();
  };
  const legacy = rejectDraft(404, 'METHOD_NOT_FOUND');
  await page.route('**/api/workbench/rpc', legacy);
  await page.getByRole('button', { name: /研究源/ }).click();
  await page.getByText('研究工具使用下面的数据源。', { exact: false }).waitFor();
  assert(await page.getByLabel('研究数据源').count() === 1 && await page.getByLabel('数据市场').count() === 0, 'old Host must retain legacy selector');
  await page.screenshot({ path: output + '/source-old-host.png' });
  const waitSource = async expected => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await (await fetch(control + '/state')).json()).source === expected && await page.getByLabel('研究数据源').isEnabled()) return;
      await page.waitForTimeout(100);
    }
    throw new Error('Legacy source update did not complete: ' + expected);
  };
  await page.getByLabel('研究数据源').selectOption('tickflow'); await waitSource('tickflow');
  await page.getByLabel('研究数据源').selectOption('llmquant-data'); await waitSource('llmquant-data');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.unroute('**/api/workbench/rpc', legacy);
  const unavailable = rejectDraft(503, 'HOST_STOPPING');
  await page.route('**/api/workbench/rpc', unavailable);
  await page.getByRole('button', { name: /研究源/ }).click();
  await page.getByRole('alert').filter({ hasText: '无法打开数据源草稿' }).waitFor();
  assert(await page.getByText('研究工具使用下面的数据源。', { exact: false }).count() === 0, 'connection failure must not silently fall back');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.unroute('**/api/workbench/rpc', unavailable);
  await page.getByRole('button', { name: /研究源/ }).click(); await page.getByLabel('数据市场').waitFor();
  await page.getByLabel('数据市场').focus(); await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === '研究数据源', 'keyboard order');
  await page.getByLabel('数据市场').selectOption('A'); await page.getByLabel('研究数据源').selectOption('tickflow');
  assert(await page.getByRole('link', { name: '官方申请地址 ↗' }).getAttribute('href') === 'https://tickflow.org/auth/register/', 'official link');
  assert(await page.getByLabel('数据源 API 密钥').getAttribute('type') === 'password', 'key must be masked');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'unverified save must be disabled');
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('缺少凭据', { exact: true }).waitFor();
  await page.getByLabel('数据源 API 密钥').fill('synthetic-ui-key');
  await page.screenshot({ path: output + '/source-wide.png' });
  await setMode('auth-failed'); await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByText('凭据未通过认证').waitFor(); assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'authentication failure cannot save');
  await setMode('empty'); await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('样本为空').waitFor();
  for (const [mode, label] of [['permission-denied', '当前账号没有接口权限'], ['timeout', '检查超时'], ['unavailable', '数据源暂不可用'], ['invalid-input', '样本代码或日期无效']]) {
    await setMode(mode); await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText(label, { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), mode + ' must not save');
  }
  await setMode('slow'); await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByRole('button', { name: '取消检查' }).waitFor(); await page.getByRole('button', { name: '取消检查' }).click();
  await page.getByText('已取消检查，草稿保留；密钥不再回显，保存前请重新检查。').waitFor();
  await page.waitForTimeout(4300); assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'late result cannot enable save');
  await setMode('ready'); await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('样本检查通过').waitFor();
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isEnabled(), 'verified draft should save');
  assert(await page.getByLabel('数据源 API 密钥').inputValue() === '', 'staged key should clear');
  await page.getByLabel('数据源 API 密钥').fill('synthetic-replacement-key');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'changed key must invalidate');
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('样本检查通过').waitFor();
  assert(!(await page.locator('body').innerText()).includes('synthetic-ui-key'), 'secret appeared in page text');
  assert(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes('synthetic-ui-key'), 'secret entered local storage');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: output + '/source-narrow.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow layout overflow');
  assert(await page.locator('.settings-main').evaluate(element => element.scrollWidth <= element.clientWidth), 'settings panel overflow');
  await page.getByLabel('样本标的').fill('600000.SH');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'changed sample must invalidate');
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('样本检查通过').waitFor();
  await fetch(control + '/conflict'); await page.getByRole('button', { name: '保存已验证配置' }).click();
  await page.getByRole('alert').filter({ hasText: '设置已被其他窗口修改' }).waitFor();
  assert(await page.getByLabel('样本标的').inputValue() === '600000.SH', 'conflict must preserve input');
  assert(!(await (await fetch(control + '/state')).json()).keyConfigured, 'conflict saved a key');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.getByRole('button', { name: /研究源/ }).click();
  await page.getByLabel('数据市场').waitFor(); await page.getByLabel('数据市场').selectOption('A');
  await page.getByLabel('研究数据源').selectOption('tickflow'); await page.getByLabel('数据源 API 密钥').fill('synthetic-ui-key');
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('样本检查通过').waitFor();
  await page.getByRole('button', { name: '保存已验证配置' }).click(); await page.getByText('数据源已保存。检查仅覆盖本次样本。').waitFor();
  const saved = await (await fetch(control + '/state')).json(); assert(saved.source === 'tickflow' && saved.keyConfigured, 'source or key not saved');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.getByRole('button', { name: /研究源/ }).click();
  await page.getByLabel('数据源 API 密钥').waitFor(); assert(await page.getByLabel('数据源 API 密钥').inputValue() === '', 'saved key was displayed');
  await setMode('unavailable');
  await page.getByRole('button', { name: '移除本机保存的密钥' }).click();
  await page.getByText(/未保存的草稿将被放弃/).waitFor();
  await page.getByRole('button', { name: '确认移除密钥' }).click();
  await page.getByText('本机密钥已移除。当前数据源未改变；环境变量如有凭据仍会生效。').waitFor();
  const removed = await (await fetch(control + '/state')).json();
  assert(removed.source === 'tickflow' && !removed.keyConfigured && removed.checks === saved.checks, 'removal changed source or contacted provider');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.getByRole('button', { name: /研究源/ }).click();
  await page.getByLabel('数据源 API 密钥').waitFor();
  await page.getByRole('button', { name: '移除本机保存的密钥' }).click();
  await page.getByRole('button', { name: '确认移除密钥' }).click();
  await page.getByText('该数据源没有本机保存的密钥。').waitFor();
  // Synthetic RPC replies exercise the new panel mode without provider calls or credentials.
  let starts = 0, job;
  await page.route('**/api/workbench/rpc', async route => {
    const payload = route.request().postDataJSON();
    if (payload.method === 'startObservationJob') {
      starts++;
      if (starts === 1) return route.fulfill({ status: 400, json: { ok: false, error: { code: 'INPUT_INVALID', message: 'synthetic old Host' } } });
      assert(JSON.stringify(payload.args[0]) === JSON.stringify({ dataset: 'daily', timeMode: 'trading-date', symbol: '600000.SH', startDate: '2024-01-02', endDate: '2024-01-03', adjustment: 'none' }), 'date request shape');
      job = { id: '12345678-1234-1234-1234-123456789abc', request: payload.args[0], status: 'archived', cancelRequested: false,
        receipt: { source: 'tushare', endpoint: 'daily', observedAt: '2024-01-05T00:00:00Z', rowCount: 1, ref: { version: 2, revision: 'a'.repeat(64) } }, error: null };
      return route.fulfill({ status: 200, json: { ok: true, result: job } });
    }
    if (payload.method === 'readObservationJob' && job) return route.fulfill({ status: 200, json: { ok: true, result: job } });
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('采集数据类型').selectOption('daily-date');
  await page.getByLabel('采集标的代码').fill('600000.SH');
  await page.getByLabel('采集开始日期').fill('2024-01-02'); await page.getByLabel('采集结束日期').fill('2024-01-03');
  await page.getByText('交易日模式支持 TickFlow 和 Tushare', { exact: false }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + '/trading-date-wide.png' });
  await page.getByRole('button', { name: '开始采集' }).click();
  await page.getByRole('alert').filter({ hasText: '旧版服务可能不支持此模式' }).waitFor();
  assert(starts === 1, 'old Host rejection must not retry');
  assert(await page.getByRole('button', { name: '开始采集' }).isDisabled(), 'ambiguous start must block resubmission');
  await page.getByRole('button', { name: '我已核实，允许重新采集' }).click();
  await page.getByRole('button', { name: '开始采集' }).click();
  await page.getByText('归档引用（版本 2）', { exact: false }).waitFor();
  assert(starts === 2, 'only explicit retries may start a new job');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('归档引用（版本 2）', { exact: false }).scrollIntoViewIfNeeded();
  assert(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'trading-date narrow page overflow');
  await page.screenshot({ path: output + '/trading-date-narrow.png' });
  assert(!pageErrors.length, 'unexpected page errors: ' + pageErrors.join('; '));
  return { synthetic: true, checks: saved.checks, screenshots: ['source-wide.png', 'source-narrow.png', 'source-old-host.png', 'trading-date-wide.png', 'trading-date-narrow.png'], expectedConflict: true };
}
