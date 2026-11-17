async ({ page, control, output }) => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const mode = async value => { const response = await fetch(control + '/mode?value=' + value); if (!response.ok) throw new Error('Fixture mode failed'); };
  const state = async () => (await fetch(control + '/state')).json();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 900 });
  const rejectDraft = (status, code) => async route => {
    if (route.request().postDataJSON().method === 'startModelDraft') return route.fulfill({ status, json: { ok: false, error: { code, message: 'synthetic failure' } } });
    return route.continue();
  };
  const legacy = rejectDraft(404, 'METHOD_NOT_FOUND');
  await page.route('**/api/workbench/rpc', legacy); await page.getByRole('button', { name: 'local-model' }).click();
  await page.getByRole('heading', { name: '当前模型' }).waitFor();
  assert(await page.getByLabel('模型 ID').count() === 1 && await page.getByLabel('模型供应商').count() === 0, 'old Host must retain the existing model editor');
  await page.screenshot({ path: output + '/model-old-host.png' });
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.unroute('**/api/workbench/rpc', legacy);
  const unavailable = rejectDraft(503, 'HOST_STOPPING');
  await page.route('**/api/workbench/rpc', unavailable); await page.getByRole('button', { name: 'local-model' }).click();
  await page.getByRole('alert').filter({ hasText: '无法打开模型草稿' }).waitFor();
  assert(await page.getByRole('heading', { name: '当前模型' }).count() === 0, 'connection failure must not silently fall back');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.unroute('**/api/workbench/rpc', unavailable);
  await page.getByRole('button', { name: 'local-model' }).click();
  await page.getByLabel('模型供应商').waitFor();
  assert(await page.getByLabel('模型供应商').locator('option[value="openai-codex"]').count() === 0, 'OAuth-only provider offered without interactive login');
  await page.screenshot({ path: output + '/model-overview.png' });
  await page.getByLabel('模型供应商').focus(); await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === '模型 ID', 'model settings keyboard order');
  const providers = await page.getByLabel('模型供应商').locator('option').evaluateAll(options => options.map(option => option.value));
  for (const provider of providers.filter(value => value !== 'custom')) {
    await page.getByLabel('模型供应商').selectOption(provider);
    await page.waitForFunction(() => !document.querySelector('[aria-label="模型供应商"]')?.disabled);
    const link = page.getByRole('link', { name: '官方文档或申请密钥 ↗' });
    assert(await link.count() === 1 && (await link.getAttribute('href')).startsWith('https://'), 'missing official link: ' + provider);
  }
  await page.getByLabel('模型供应商').selectOption('custom');
  await page.waitForFunction(() => !document.querySelector('[aria-label="模型供应商"]')?.disabled);
  assert((await state()).checks === 0, 'opening settings made a provider request');
  assert(await page.getByLabel('模型 API 密钥').getAttribute('type') === 'password', 'key must be masked');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'unverified draft can save');
  let staged, syntheticStatus = 'missing-credential';
  const mockStatuses = async route => {
    const method = route.request().postDataJSON().method;
    if (method === 'editModelDraft') {
      const response = await route.fetch(), body = await response.json(); staged = body.result;
      return route.fulfill({ response, json: body });
    }
    if (method === 'verifyModelDraft') return route.fulfill({ json: { ok: true, result: { ...staged, status: syntheticStatus, canSave: false } } });
    return route.continue();
  };
  await page.route('**/api/workbench/rpc', mockStatuses);
  for (const [value, label] of [['missing-credential', '缺少凭据'], ['timeout', '检查超时'], ['unsupported', '不支持此协议或模型']]) {
    syntheticStatus = value; await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText(label, { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), value + ' can save');
  }
  await page.unroute('**/api/workbench/rpc', mockStatuses);
  assert((await state()).checks === 0, 'synthetic Host states contacted the provider');
  await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByText('本次连接检查通过').waitFor(); // The loopback provider accepts anonymous requests.
  await page.getByLabel('模型 API 密钥').fill('synthetic-model-key');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'new key did not invalidate anonymous check');
  await page.screenshot({ path: output + '/model-wide.png' });
  for (const [value, label] of [['auth-failed', '认证失败'], ['permission-denied', '没有访问权限'], ['unavailable', '网络或服务不可用']]) {
    await mode(value); await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText(label, { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), value + ' can save');
  }
  await mode('slow'); await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByRole('button', { name: '取消检查' }).click(); await page.getByText('检查已取消；保存前请重新检查。').waitFor();
  await page.waitForTimeout(4300); assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'late result enabled save');
  await mode('ready'); await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('本次连接检查通过').waitFor();
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isEnabled(), 'verified draft cannot save');
  assert((await state()).expectedKeyObserved && (await state()).requestedModel === 'local-model', 'provider did not receive the submitted draft');
  await mode('slow'); const started = await fetch(control + '/start-run'); if (!started.ok) throw new Error('Synthetic research did not start');
  await page.getByText('研究运行中不能保存设置；请先等待或停止研究。').waitFor();
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'running research did not block save');
  const stopped = await fetch(control + '/stop-run'); if (!stopped.ok) throw new Error('Synthetic research did not stop');
  await page.getByText('研究运行中不能保存设置；请先等待或停止研究。').waitFor({ state: 'hidden' }); await mode('ready');
  assert(await page.getByLabel('模型 API 密钥').inputValue() === '', 'staged key was not cleared');
  assert(!(await page.locator('body').innerText()).includes('synthetic-model-key'), 'secret appeared in page text');
  assert(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes('synthetic-model-key'), 'secret entered local storage');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: output + '/model-narrow.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow layout overflow');
  assert(await page.locator('.settings-main').evaluate(element => element.scrollWidth <= element.clientWidth), 'settings panel overflow');
  await page.getByLabel('模型 ID').fill('other-model');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'changed model did not invalidate');
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('本次连接检查通过').waitFor();
  assert((await state()).requestedModel === 'other-model', 'edited model was not checked');
  await fetch(control + '/conflict'); await page.getByRole('button', { name: '保存已验证配置' }).click();
  await page.getByRole('alert').waitFor(); assert(await page.getByLabel('模型 ID').inputValue() === 'other-model', 'conflict lost draft');
  assert(!(await state()).keyConfigured, 'conflict saved a key');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.getByRole('button', { name: 'local-model' }).click();
  await page.getByLabel('模型 API 密钥').fill('synthetic-model-key'); await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByText('本次连接检查通过').waitFor(); await page.getByRole('button', { name: '保存已验证配置' }).click();
  await page.getByText('模型配置已保存。关闭后可重新打开设置。').waitFor(); assert((await state()).keyConfigured, 'verified key was not saved');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.getByRole('button', { name: 'local-model' }).click();
  await page.getByLabel('模型 API 密钥').waitFor(); assert(await page.getByLabel('模型 API 密钥').inputValue() === '', 'saved key was displayed');
  await page.getByLabel('模型供应商').selectOption('openai');
  await page.getByText('未保存本机密钥；环境变量或其他认证方式可能仍生效。').waitFor();
  assert(await page.getByRole('link', { name: '官方文档或申请密钥 ↗' }).getAttribute('href') === 'https://platform.openai.com/api-keys', 'OpenAI official link missing');
  await page.getByLabel('模型供应商').selectOption('custom');
  await page.getByText('本机已配置密钥，不会回显；尚需检查实际连接。').waitFor();
  assert(await page.getByLabel('模型 API 密钥').inputValue() === '', 'switching providers revealed the saved key');
  await page.getByLabel('模型 API 密钥').fill('synthetic-replacement-key');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'key replacement did not invalidate');
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('本次连接检查通过').waitFor();
  assert((await state()).replacementKeyObserved, 'replacement key was not used for the check');
  await page.getByRole('button', { name: '保存已验证配置' }).click(); await page.getByText('模型配置已保存。关闭后可重新打开设置。').waitFor();
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.locator('button.status-model').click();
  await page.getByLabel('模型 API 密钥').waitFor(); assert(await page.getByLabel('模型 API 密钥').inputValue() === '', 'replacement key was displayed');
  const before = (await state()).checks;
  await page.getByRole('button', { name: '移除本机保存的密钥' }).click(); await page.getByRole('button', { name: '确认移除密钥' }).click();
  await page.getByText('本机密钥已移除，环境变量或其他认证方式仍可能生效。').waitFor();
  const removed = await state(); assert(!removed.keyConfigured && removed.checks === before, 'removal changed provider state or called provider');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.getByRole('button', { name: 'local-model' }).click();
  await page.getByLabel('模型供应商').selectOption('cloudflare-ai-gateway');
  await page.getByLabel('Cloudflare 账号 ID').fill('account-synthetic'); await page.getByLabel('Cloudflare 网关 ID').fill('gateway-synthetic');
  await page.getByLabel('模型 API 密钥').fill('synthetic-model-key'); await page.getByLabel('模型协议').selectOption('openai-completions');
  await page.getByText('连接地址（可选）').click();
  await page.getByLabel('模型服务地址').fill((await state()).providerUrl + '/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}');
  await page.screenshot({ path: output + '/model-cloudflare.png' }); await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByText('本次连接检查通过').waitFor();
  const cloudCheck = await state(); assert(cloudCheck.expectedKeyObserved && cloudCheck.requestPath.includes('/account-synthetic/gateway-synthetic/'), 'Cloudflare checked a different draft');
  await page.getByLabel('Cloudflare 网关 ID').fill('changed-gateway');
  assert(await page.getByRole('button', { name: '保存已验证配置' }).isDisabled(), 'changed gateway did not invalidate');
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('本次连接检查通过').waitFor();
  await page.getByRole('button', { name: '保存已验证配置' }).click(); await page.getByText('模型配置已保存。关闭后可重新打开设置。').waitFor();
  const cloudSaved = await state(); assert(cloudSaved.cloudAccountConfigured && cloudSaved.cloudGatewayConfigured, 'Cloudflare identifiers were not saved');
  await page.getByRole('button', { name: '关闭窗口' }).click(); await page.locator('button.status-model').click();
  await page.getByLabel('Cloudflare 账号 ID').waitFor();
  assert(await page.getByLabel('Cloudflare 账号 ID').inputValue() === '' && await page.getByLabel('Cloudflare 网关 ID').inputValue() === '', 'saved Cloudflare identifiers were displayed');
  await page.getByText('本机已保存账号 ID，不会回显。', { exact: false }).waitFor();
  await page.getByText('本机已保存网关 ID，不会回显。').waitFor();
  assert(!errors.length, 'unexpected page errors: ' + errors.join('; '));
  return { synthetic: true, screenshots: ['model-old-host.png', 'model-overview.png', 'model-wide.png', 'model-narrow.png', 'model-cloudflare.png'], checks: cloudSaved.checks, expectedConflict: true };
}
