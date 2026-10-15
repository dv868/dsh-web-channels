import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebAdapter } from '../lib/index.js';
import { buildPrompt, promptEnvelope, envelopeIndex, checkpointOf, parseReply } from '../lib/protocol.js';
import { SessionStore, digest } from '../lib/state.js';
import { BrowserChannel } from '../lib/browser.js';
import { classifySiteIssue } from '../lib/issues.js';

const message = (id, text, role = 'user') => ({ id, role, content: [{ type: 'text', text }] });
const config = { contextWindow: 128000, maxPromptChars: 100000 };
const base = { model: 'gemini-web-auto', sessionId: 'work', messages: [message('u', '写代码')] };
const collect = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks; };
const toolJson = '{"dsh_tool_calls":[{"name":"write","arguments":{}}]}';

test('auxiliary requests are independent text only, even if their output is tool JSON', async () => {
  const requests = [], closed = [];
  const adapter = new WebAdapter('gemini-web', config, { async turn(r) { requests.push(r); return { text: r.temporary ? toolJson : '正文' }; }, async closeTemporary(id) { closed.push(id); } });
  await collect(adapter.stream(base));
  const cursor = adapter.cursors.get('work'), envelope = adapter.envelopes.get('work');
  for (const purpose of ['compaction', 'session-title']) {
    const chunks = await collect(adapter.stream({ ...base, purpose }));
    assert.equal(chunks.some(c => c.type === 'tool-call-delta'), false);
    assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === toolJson));
    const request = requests.at(-1);
    assert.equal(request.temporary, true);
    assert.notEqual(request.sessionId, 'work');
    assert.match(request.text, /只生成所要求的文本/);
  }
  assert.equal(closed.length, 2);
  assert.notEqual(closed[0], closed[1]);
  assert.equal(adapter.cursors.get('work'), cursor);
  assert.equal(adapter.envelopes.get('work'), envelope);
});

test('failed, aborted and truncated auxiliary calls always release temporary tabs', async () => {
  for (const code of ['WEB_REPLY_INTERRUPTED', 'ABORTED', 'WEB_REPLY_TRUNCATED']) {
    let closed = 0;
    const adapter = new WebAdapter('gemini-web', config, { async turn() { throw Object.assign(new Error('真实网页错误'), { code }); }, async closeTemporary() { closed++; } });
    const run = collect(adapter.stream({ ...base, purpose: 'compaction' }));
    if (code === 'WEB_REPLY_TRUNCATED') assert.equal((await run).at(-1).reason.kind, 'max-tokens');
    else await assert.rejects(run, /真实网页错误/);
    assert.equal(closed, 1);
    assert.equal(adapter.cursors.size, 0);
  }
});

test('auxiliary abort after browser return does not emit partial summary', async () => {
  const controller = new AbortController(); let closed = false;
  const adapter = new WebAdapter('gemini-web', config, { async turn() { controller.abort(); return { text: '不完整摘要' }; }, async closeTemporary() { closed = true; } });
  await assert.rejects(collect(adapter.stream({ ...base, purpose: 'compaction', signal: controller.signal })), /abort/i);
  assert.equal(closed, true);
});

test('checkpoint changes rebuild work context without losing host rules or recent tool results', async () => {
  const requests = [];
  const adapter = new WebAdapter('gemini-web', config, { async turn(r) { requests.push(r); return { text: '继续' }; } });
  await collect(adapter.stream(base));
  const checkpoint = message('cp', 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.\n\n<compacted-summary>保留目标 NONCE-123</compacted-summary>');
  const next = { ...base, system: 'HOST_RULE', messages: [checkpoint, message('t', 'ACTUAL_RESULT', 'tool'), message('u2', '继续任务')] };
  await collect(adapter.stream(next));
  assert.equal(requests[1].reset, true);
  assert.match(requests[1].text, /HOST_RULE|NONCE-123|ACTUAL_RESULT/);
  assert.notEqual(checkpointOf(base), checkpointOf(next));
  await collect(adapter.stream({ ...next, messages: [...next.messages, message('u3', '下一步')] }));
  assert.equal(requests[2].reset, false);
  assert.equal(requests[2].text, '下一步');
});

test('invalid cursors rebuild even when a persistent system message survives', async () => {
  const requests = [];
  const adapter = new WebAdapter('gemini-web', config, { async turn(r) { requests.push(r); return { text: 'ok' }; } });
  const system = message('s', 'RULE', 'system');
  await collect(adapter.stream({ ...base, messages: [system, ...base.messages] }));
  await collect(adapter.stream({ ...base, messages: [system, message('new', '新历史')] }));
  assert.equal(requests[1].reset, true);
});

test('standalone options.system is retained and indexed updates work after restart', () => {
  const first = { ...base, system: 'RULE_ONE\n\nRULE_TWO' };
  const index = envelopeIndex(promptEnvelope(first));
  assert.doesNotMatch(index, /RULE_ONE|RULE_TWO|写代码/);
  const next = { ...first, system: 'RULE_ONE\n\nRULE_THREE', messages: [...first.messages, message('u2', '继续')] };
  const prompt = buildPrompt(next, { ids: ['u'] }, index);
  assert.match(prompt, /移除：|RULE_THREE/);
  assert.doesNotMatch(prompt, /RULE_ONE|RULE_TWO/);
});

test('no-tool requests omit executable tool protocol without dropping user or host rules', () => {
  const prompt = buildPrompt({ ...base, system: 'HOST-NONCE', tools: [] });
  assert.match(prompt, /HOST-NONCE|写代码/);
  assert.doesNotMatch(prompt, /dsh_tool_calls|JSON Schema/);
});

test('invalid saved session entries fall back to host history', async () => {
  const store = new SessionStore();
  await store.set('bad', { cursor: { ids: ['u'] }, checkpoint: 'x', envelope: 'broken' });
  assert.equal(await store.get('bad'), undefined);
});

test('session index survives process recreation without persisting prompts or responses', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-state-test-'));
  try {
    const file = path.join(dir, 'state.json'), requests = [];
    const binding = { targetId: 'test-target', replyHash: 'hash', url: 'https://gemini.google.com/app/test' };
    const channel = { async turn(r) { requests.push(r); return { text: 'PRIVATE_REPLY', binding }; } };
    await collect(new WebAdapter('gemini-web', config, channel, new SessionStore(file)).stream({ ...base, system: 'PRIVATE_HOST_RULE' }));
    const saved = await readFile(file, 'utf8');
    assert.doesNotMatch(saved, /PRIVATE_HOST_RULE|PRIVATE_REPLY|写代码|"work"/);
    const restarted = new WebAdapter('gemini-web', config, channel, new SessionStore(file));
    await collect(restarted.stream({ ...base, system: 'PRIVATE_HOST_RULE', messages: [...base.messages, message('u2', '精确原文')] }));
    assert.equal(requests[1].text, '精确原文');
    assert.deepEqual(requests[1].binding, binding);
  } finally { await rm(dir, { recursive: true }); }
});

test('partial generator consumption cannot advance the cursor', async () => {
  const adapter = new WebAdapter('gemini-web', config, { async turn() { return { text: '正文' }; } });
  const stream = adapter.stream(base);
  await stream.next();
  await stream.return();
  assert.equal(adapter.cursors.size, 0);
});

test('whole adapter request is serialized across repair and auxiliary calls', async () => {
  const requests = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const adapter = new WebAdapter('gemini-web', config, { async turn(r) { requests.push(r); if (requests.length === 1) { await blocked; return { text: '{"dsh_tool_calls":[}' }; } return { text: 'ok' }; }, async closeTemporary() {} });
  const work = collect(adapter.stream(base));
  await new Promise(resolve => setImmediate(resolve));
  const aux = collect(adapter.stream({ ...base, purpose: 'compaction' }));
  release(); await Promise.all([work, aux]);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].temporary, undefined);
  assert.equal(requests[2].temporary, true);
});

test('mixed tool output is corrected, examples are inert, multi-action validation is atomic', () => {
  assert.throws(() => parseReply('我将写文件：\n```json\n' + toolJson + '\n```', [], { strictIntent: true }), /无法完整解析/);
  assert.equal(parseReply('这是工具格式示例：\n' + toolJson, [], { strictIntent: true }).calls.length, 0);
  assert.throws(() => parseReply('{"dsh_tool_calls":[{"name":"write","arguments":{}},{"name":"unknown","arguments":{}}]}', [{ name: 'write' }]), /未知工具/);
});

test('explicit site truncation, context, quota and network errors are distinguished', () => {
  assert.equal(classifySiteIssue('The response reached the maximum length').code, 'WEB_REPLY_TRUNCATED');
  assert.equal(classifySiteIssue('上下文过长').code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(classifySiteIssue('Too many requests').code, 'WEB_RATE_LIMITED');
  assert.equal(classifySiteIssue('Something went wrong').code, 'WEB_REPLY_INTERRUPTED');
  assert.equal(classifySiteIssue('复制回答'), undefined);
});

test('only owned auxiliary tabs can be closed by cleanup', async () => {
  const channel = new BrowserChannel('gemini-web', config); let closed = 0;
  const page = { isClosed: () => false, async close() { closed++; } };
  channel.pages.set('work', page); channel.pages.set('aux-test', page); channel.temporary.add('aux-test');
  await channel.closeTemporary('work'); assert.equal(closed, 0);
  await channel.closeTemporary('aux-test'); assert.equal(closed, 1);
  assert.equal(channel.pages.has('work'), true);
});

test('restart reuses verified idle tabs and rebuilds when the prior request is still generating', async () => {
  for (const generating of [false, true]) {
    const channel = new BrowserChannel('gemini-web', config);
    const url = 'https://gemini.google.com/app/owned';
    const original = { url: () => url, isClosed: () => false, getByRole: () => ({ first: () => ({ isVisible: async () => generating }) }) };
    const fresh = { async goto() {}, async bringToFront() {} };
    channel.connect = async () => {};
    channel.browser = { contexts: () => [{ pages: () => [original], newPage: async () => fresh }] };
    channel.targetId = async () => 'owned-target';
    channel.snapshot = async () => [{ text: 'known-reply', busy: false }];
    const page = await channel.pageFor('work', { binding: { targetId: 'owned-target', url, replyHash: digest('known-reply') } });
    assert.equal(page, generating ? fresh : original);
  }
});
