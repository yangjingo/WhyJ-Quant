// Exercises published-to-candidate npm upgrades on Windows using synthetic state.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';

const [candidatePath, desktopExe, installerPath] = process.argv.slice(2);
assert(process.platform === 'win32' && candidatePath && Boolean(desktopExe) === Boolean(installerPath),
  'Usage on Windows: node apps/cli/dev/windows-npm-upgrade.mjs CANDIDATE_TGZ [INSTALLED_DESKTOP_EXE INSTALLER]');
if (desktopExe) {
  assert(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted',
    'Installed Desktop acceptance requires a disposable GitHub-hosted runner');
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const pty = requireDesktop('node-pty');
const temp = await realpath(tmpdir());
const home = await mkdtemp(join(temp, 'whyj-npm-upgrade-'));
const output = join(root, 'output/playwright/windows-npm-upgrade');
const workspace = join(home, 'state');
const prefix = join(home, 'prefix');
const runtime = join(home, 'node');
const registry = join(workspace, '.host', 'registry.json');
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const candidate = resolve(candidatePath);
const baseline = '1.2.0';
const baselineIntegrity = 'sha512-H1N6E1BeTIhxq1BqxEIi3SDcB9BV213SzGeSk3ynVzJ3sH2sic3vs9s1zKMaNC7XpiME21f1R0GEh3YZsXfwWw==';
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const result = {
  result: 'failed', revision: process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim(),
  windows: release(), architecture: process.arch, node: process.version, baseline, baselineIntegrity, version, checks: [],
  desktop: desktopExe ? 'installed on disposable runner' : 'unrun', packageScripts: 'disabled',
};
const sys = process.env.SystemRoot;
assert(sys, 'Windows SystemRoot is required');
const cmd = join(sys, 'System32/cmd.exe');
const env = {
  SystemRoot: sys, WINDIR: sys, ComSpec: cmd, PATHEXT: '.COM;.EXE;.BAT;.CMD',
  PATH: [prefix, runtime, join(sys, 'System32'), sys].join(';'), TERM: 'xterm-256color',
  TEMP: home, TMP: home, HOME: home, USERPROFILE: home,
  APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
  WHYJ_DESKTOP_HOME: join(home, 'desktop'), OHQUANT_DIR: workspace,
  PI_CODING_AGENT_DIR: join(home, 'pi'), NO_PROXY: '127.0.0.1,localhost',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1',
};
const npmEnv = {
  ...env, HTTP_PROXY: '', HTTPS_PROXY: '', NODE_USE_ENV_PROXY: '0',
  npm_config_cache: join(home, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org',
};
const npmCommandTimeoutMs = 120_000;
const npmInstallTimeoutMs = 240_000;
const shell = (command, timeout = 30_000) => spawnSync(cmd, ['/d', '/c', command], {
  env, cwd: home, timeout, encoding: 'utf8', windowsHide: true,
});
const npmRun = (args, timeout = npmCommandTimeoutMs) => spawnSync(process.execPath, [npm, ...args], {
  env: npmEnv, cwd: home, timeout, encoding: 'utf8', windowsHide: true,
});
function ok(child, label) {
  if (child.status !== 0) throw new Error(label + ' failed (' + (child.error?.code || child.status) + '): ' + child.stderr?.slice(-1500));
  return child.stdout;
}
async function waitFor(read, matches, label) {
  const deadline = Date.now() + 30_000;
  do {
    const value = await read();
    if (matches(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}
function install(tarball, timeout = npmInstallTimeoutMs) {
  return npmRun(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], timeout);
}
async function assertInstalled(expected) {
  const found = ok(shell('where.exe whyj'), 'CLI PATH discovery').split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  const shims = await Promise.all(found.map(path => realpath(path)));
  const shim = await realpath(join(prefix, 'whyj.cmd'));
  assert(shims.some(path => path.toLowerCase() === shim.toLowerCase()), 'PATH did not resolve the isolated npm cmd shim');
  const prefixPath = (await realpath(prefix)).toLowerCase() + sep;
  assert(shims.every(path => path.toLowerCase().startsWith(prefixPath)), 'A whyj shim outside the isolated npm prefix is visible on PATH');
  const installed = JSON.parse(await readFile(join(prefix, 'node_modules/whyj-quant/package.json'), 'utf8'));
  assert.equal(installed.version, expected);
}
async function terminal(label, expectedText, terminalEnv = env, active = false) {
  const child = pty.spawn(cmd, ['/d', '/c', 'whyj'], { cwd: home, env: terminalEnv, cols: 140, rows: 45 });
  let screen = '';
  let exited;
  child.onData(value => { screen += stripVTControlCharacters(value); });
  child.onExit(value => { exited = value; });
  const read = () => {
    if (exited) throw new Error('Terminal exited before completing ' + label);
    return screen;
  };
  try {
    await waitFor(read, text => text.includes(expectedText), label + ' startup');
    if (!active) {
      const startup = screen.length;
      child.write('/help exit\r');
      await waitFor(read, text => /Saved settings|Exit WhyJ|available commands|退出/i.test(text.slice(startup)), label + ' help');
      child.write('\u001b');
      await delay(250);
      child.write('/exit\r');
      assert.equal((await waitFor(() => exited, Boolean, label + ' exit')).exitCode, 0);
      return;
    }
    // The active snapshot can render before the terminal finishes bootstrapping
    // its submit handler. Ctrl+D requests only terminal detach.
    const end = await waitFor(async () => {
      if (exited) return exited;
      child.write('\u0004');
      await delay(200);
      return exited;
    }, Boolean, label + ' exit');
    assert.equal(end.exitCode, 0);
  } finally {
    if (!exited) child.kill();
    await writeFile(join(output, label + '.txt'), screen);
  }
}
const readJson = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  assert(response.ok, 'Fixture request failed: ' + response.status + ' ' + (body.error?.code || ''));
  return body;
};

let fixture, desktop, registration;
try {
  await mkdir(output, { recursive: true });
  for (const dir of [prefix, runtime, env.APPDATA, env.LOCALAPPDATA]) await mkdir(dir, { recursive: true });
  await copyFile(process.execPath, join(runtime, 'node.exe'));
  result.npm = ok(npmRun(['--version']), 'npm version').trim();
  const pack = JSON.parse(ok(npmRun(['pack', 'whyj-quant@' + baseline, '--ignore-scripts', '--json']), 'published baseline pack'))[0];
  const previous = join(home, pack.filename);
  assert.equal('sha512-' + createHash('sha512').update(await readFile(previous)).digest('base64'), baselineIntegrity);
  result.candidateSha256 = createHash('sha256').update(await readFile(candidate)).digest('hex');
  if (installerPath) result.installerSha256 = createHash('sha256').update(await readFile(installerPath)).digest('hex');

  fixture = spawn('bun', ['run', 'tests/app/dev/review-host-fixture.ts'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...env, PATH: process.env.PATH, WHYJ_REVIEW_HOST_ROOT: workspace },
  });
  let stdout = '';
  let startupError;
  fixture.stdout.on('data', text => { stdout += text; });
  fixture.once('error', error => { startupError = error; });
  const receipt = await waitFor(() => {
    if (startupError || fixture.exitCode !== null) throw startupError || new Error('Review Host exited during startup');
    return stdout.split('\n').slice(0, -1).find(line => line.startsWith('{"origin"'));
  }, Boolean, 'authenticated Host receipt');
  const { origin, control } = JSON.parse(receipt);
  const boot = await readJson(origin + '/api/workbench/bootstrap');
  const rpc = async (method, args = []) => {
    const value = await readJson(origin + '/api/workbench/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-token': boot.token },
      body: JSON.stringify({ method, args }),
    });
    assert(value.ok, 'Fixture RPC failed: ' + method);
    return value.result;
  };

  ok(install(previous), 'baseline npm install');
  await assertInstalled(baseline);
  await terminal('baseline-terminal', 'WhyJ', { ...env, OHQUANT_DIR: join(home, 'baseline-state') });
  result.checks.push('published npm package installs in an isolated prefix and starts its terminal');

  const identity = await rpc('identity');
  const question = 'Windows upgrade acceptance question';
  const snapshot = () => rpc('session', [identity.sessionId]);
  const original = await snapshot();
  const { runId } = await rpc('submit', [{
    workspaceId: identity.workspaceId, sessionId: identity.sessionId,
    requestId: randomUUID(), expectedRevision: original.revision ?? 0, text: question,
  }]);
  const providerState = () => readJson(control + '/state');
  await waitFor(providerState, value => value.stage === 'waiting', 'active synthetic research');
  const running = await snapshot();
  assert.equal(running.identity.runId, runId);
  assert.equal(running.state, 'running');
  const settingsPath = join(workspace, 'settings.json');
  const settings = await readFile(settingsPath);
  let page;
  if (desktopExe) {
    const { _electron: electron } = requireDesktop('playwright');
    desktop = await electron.launch({ executablePath: resolve(desktopExe), args: [], env, timeout: 60_000 });
    page = await desktop.firstWindow();
    await page.locator('.turn-user').getByText(question, { exact: true }).waitFor({ timeout: 45_000 });
    await page.screenshot({ path: join(output, 'desktop-before.png') });
  }

  const invalid = join(home, 'invalid.tgz');
  await writeFile(invalid, 'not an npm archive');
  const rejected = install(invalid, npmCommandTimeoutMs);
  assert(!rejected.error && rejected.status > 0, 'npm did not reject the corrupt upgrade input');
  await assertInstalled(baseline);
  assert((await readFile(settingsPath)).equals(settings), 'Rejected upgrade changed settings');
  result.checks.push('invalid tarball is rejected before replacing the working installation');

  ok(install(candidate), 'candidate npm upgrade');
  await assertInstalled(version);
  const versionResult = JSON.parse(ok(shell('whyj --json --version'), 'candidate version'));
  assert(versionResult.ok && versionResult.data.version === version);
  const shared = JSON.parse(ok(shell('whyj --json web --no-open'), 'candidate Host discovery'));
  assert(shared.ok && !shared.data.started && shared.data.instanceId === boot.instanceId);
  const help = spawnSync(join(runtime, 'node.exe'), [join(prefix, 'node_modules/whyj-quant/dist/index.js'), '-c', '/help exit'],
    { env, cwd: home, timeout: 30_000, encoding: 'utf8', windowsHide: true });
  assert.match(ok(help, 'candidate help'), /Exit WhyJ/);
  await terminal('candidate-terminal', question, env, true);
  assert((await readFile(settingsPath)).equals(settings), 'Successful upgrade changed synthetic settings');
  assert.equal((await snapshot()).identity.runId, runId);
  assert.equal((await snapshot()).state, 'running');
  assert.equal((await providerState()).requests, 1, 'Upgrade replayed the active research');
  if (page) {
    const instance = await page.evaluate(async () => (await (await fetch('/api/workbench/bootstrap')).json()).instanceId);
    assert.equal(instance, boot.instanceId);
    await page.locator('.turn-user').getByText(question, { exact: true }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(output, 'desktop-after.png') });
  }
  result.checks.push('upgraded CLI attaches to the same Host and the existing research remains active');

  registration = await readFile(registry);
  const incompatible = Buffer.from(JSON.stringify({ ...JSON.parse(registration), protocolVersion: 999 }));
  await writeFile(registry, incompatible);
  const mismatch = shell('whyj --json web --no-open');
  assert.equal(mismatch.status, 1);
  const refusal = JSON.parse(mismatch.stdout).error;
  assert.equal(refusal.code, 'web_failed');
  assert.match(refusal.message, /different workspace or protocol\/service contract/);
  assert((await readFile(registry)).equals(incompatible), 'Incompatible attachment changed the Host registration');
  assert.equal((await snapshot()).identity.runId, runId);
  await writeFile(registry, registration);
  registration = undefined;
  await rpc('cancel', [running.identity]);
  const cancelled = await waitFor(snapshot, value => value.state === 'cancelled', 'cancelled research');
  assert.equal(cancelled.identity.runId, runId);
  assert(cancelled.turns.some(turn => turn.text.includes(question)), 'Synthetic research history was lost');
  assert.equal((await providerState()).requests, 1);
  result.checks.push('incompatible CLI leaves the owner intact and explicit cancellation keeps the original history');
  if (desktop) {
    const closed = desktop.waitForEvent('close', { timeout: 15_000 });
    await desktop.evaluate(({ app }) => app.quit()).catch(() => {});
    await closed;
    desktop = undefined;
    assert.equal((await snapshot()).identity.runId, runId);
    result.checks.push('quitting installed Desktop detaches without stopping the shared Host');
  }
  result.result = 'passed';
} catch (error) {
  result.failure = String(error);
  console.error(error);
} finally {
  if (registration) await writeFile(registry, registration);
  if (desktop) {
    await desktop.evaluate(({ app }) => app.quit()).catch(() => {});
    await desktop.close().catch(() => {});
  }
  try {
    if (fixture?.pid && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.kill();
      await waitFor(() => fixture.exitCode !== null || fixture.signalCode !== null, Boolean, 'fixture shutdown');
    }
    if (result.result === 'passed') {
      assert(resolve(home).startsWith(temp + sep), 'Unexpected fixture root');
      await rm(home, { recursive: true, force: true });
    }
  } catch (error) {
    result.result = 'failed';
    result.failure ??= String(error);
  }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  // node-pty can keep an idle native helper handle after its terminal exits.
  process.exit(result.result === 'passed' ? 0 : 1);
}
