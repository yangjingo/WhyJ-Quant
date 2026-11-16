async (page) => {
  await page.setViewportSize({ width: 1024, height: 480 });
  const stream = page.locator('#stream');
  const before = await stream.evaluate(element => {
    if (element.scrollHeight - element.clientHeight < 100) throw new Error('Fixture needs a scrollable conversation');
    element.scrollTop = 80; return element.scrollTop;
  });
  await page.waitForFunction(() => document.getElementById('stream').scrollTop === 80);
  await page.getByRole('button', { name: '研究成果', exact: true }).click();
  await page.getByRole('tab', { name: '报告版本', exact: true }).click();
  await page.getByRole('button', { name: '打开交互报告', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '隔离交互预览' }).waitFor();
  if (!await page.locator('.report-view h2').evaluate(element => element === document.activeElement)) throw new Error('Report heading did not receive focus');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Low-height viewport has horizontal overflow');
  await page.screenshot({ path: 'output/playwright/report-ui/12-low-height.png' });
  await page.getByRole('button', { name: '返回研究工作区', exact: true }).focus();
  await page.keyboard.press('Enter');
  await stream.waitFor();
  const after = await stream.evaluate(element => element.scrollTop);
  if (before !== after) throw new Error('Conversation scroll moved: ' + before + ' -> ' + after);
  if (!await page.locator('#sessionTitle').evaluate(element => element === document.activeElement)) throw new Error('Return focus was lost');
  return { scrollBefore: before, scrollAfter: after, keyboardReturn: true, reportFocus: true, viewport: '1024x480' };
}
