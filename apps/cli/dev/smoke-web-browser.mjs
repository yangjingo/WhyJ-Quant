import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [origin, question, answer] = process.argv.slice(2);
const browserRoot = process.env.WHYJ_WEB_ACCEPTANCE_BROWSER_ROOT;
assert.ok(browserRoot && question && answer, "The packaged Host and browser fixture are required");
assert.equal(new URL(origin).hostname, "127.0.0.1");
const { chromium } = createRequire(join(resolve(browserRoot), "package.json"))("playwright");
const browser = await chromium.launch({ headless: true, timeout: 20000 });
try {
  const page = await browser.newPage({ locale: "zh-CN" });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const navigation = await page.goto(origin);
  assert.equal(navigation?.status(), 200, "Packaged Host did not serve the production Web page");
  const input = page.getByRole("combobox", { name: "研究问题", exact: true });
  await input.fill(question);
  await input.press("Enter");
  await page.locator(".turn-user").getByText(question, { exact: true }).waitFor();
  await page.locator(".turn-assistant").getByText(answer, { exact: true }).waitFor();
  assert.deepEqual(errors, [], "Production Web page emitted JavaScript errors");
} finally {
  await browser.close();
}
