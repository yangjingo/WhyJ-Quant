import assert from 'node:assert/strict';
import test from 'node:test';
import { eligiblePullRequest, reviewBody, reviewDiff, route } from './kimi-pr-review.mjs';

const credentials = { baseUrl: 'https://gateway.example/v1', apiKey: 'fixture-key' };
const diff = 'diff --git a/widget.ts b/widget.ts\n+ return null;';
const frame = (model, delta, finish_reason) => JSON.stringify({ model, choices: [{ delta, finish_reason }] });
const stream = (...frames) => new Response(frames.map(frame => 'data: ' + frame + '\n\n').join(''), {
  headers: { 'content-type': 'text/event-stream' }
});

test('uses the dedicated Kimi route and assembles only complete final content', async () => {
  const result = await reviewDiff(diff, {
    ...credentials,
    fetchResponse: async (url, request) => {
      assert.equal(url.href, 'https://gateway.example/v1/chat/completions');
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(request.body);
      assert.equal(body.model, route);
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(body.stop, ['\nEND_KIMI_REVIEW']);
      assert.ok(body.messages[0].content.includes(diff));
      assert.ok(!request.body.includes(credentials.apiKey));
      return stream(
        frame('kimi-k3.1-pro', { reasoning_content: 'hidden' }, null),
        frame('kimi-k3.1-pro', { content: 'No actionable findings.\nEND_KIMI_REVIEW' }, 'stop'),
        '[DONE]'
      );
    }
  });
  assert.equal(result.body, 'No actionable findings.');
  assert.equal(result.model, 'kimi-k3.1-pro');
  assert.ok(!reviewBody({ ...result, body: 'fixture-key @user' }, 'a'.repeat(40), credentials).includes('@user'));
  assert.ok(!reviewBody({ ...result, body: 'fixture-key' }, 'a'.repeat(40), credentials).includes('fixture-key'));
});

test('rejects model substitution, truncated output, and non-stream responses', async () => {
  for (const [response, pattern] of [
    [stream(frame('substituted-model', { content: 'wrong model' }, 'stop')), /unexpected model/],
    [stream(frame('kimi-k3.1-pro', { content: 'truncated' }, 'length')), /complete review/],
    [new Response('rate exceeded', { status: 429 }), /HTTP 429/],
    [new Response('{}'), /streaming response/]
  ]) {
    await assert.rejects(reviewDiff(diff, { ...credentials, fetchResponse: async () => response }), pattern);
  }
});

test('rejects oversized diffs and invalid credentials before sending a request', async () => {
  const guard = { ...credentials, fetchResponse: () => assert.fail('unexpected request') };
  await assert.rejects(reviewDiff('中'.repeat(17_000), guard), /48 KiB/);
  await assert.rejects(reviewDiff(diff, { ...guard, baseUrl: 'http://gateway.example/v1' }), /HTTPS/);
  await assert.rejects(reviewDiff(diff, { ...guard, apiKey: '' }), /Secrets are missing/);
});

test('automatic reviews bind to same-repository ready PRs and the event head', () => {
  const baseRepo = 'owner/repo';
  const head = { repo: { full_name: baseRepo }, sha: 'one' };
  const pr = { base: { ref: 'main' }, state: 'open', draft: false, head };
  const options = { baseRepo, head: 'one', automatic: true };
  assert.equal(eligiblePullRequest(pr, options), true);
  assert.equal(eligiblePullRequest(pr, { ...options, head: 'old' }), false);
  assert.equal(eligiblePullRequest({ ...pr, draft: true }, options), false);
  assert.equal(eligiblePullRequest({ ...pr, state: 'closed' }, options), false);
  assert.equal(eligiblePullRequest({ ...pr, head: { ...head, repo: null } }, options), false);
  assert.equal(eligiblePullRequest({ ...pr, state: 'closed' }, { automatic: false }), true);
});
