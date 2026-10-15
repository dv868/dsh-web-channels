import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, promptEnvelope, parseReply, replyChunks, toolCatalog } from '../lib/protocol.js';
import { promptPackets } from '../lib/transport.js';
import { BrowserChannel } from '../lib/browser.js';
import { WebAdapter } from '../lib/index.js';

const tools = [{ name: 'write', parameters: {
  type: 'object', required: ['file_path', 'content'], additionalProperties: false,
  properties: { file_path: { type: 'string' }, content: { type: 'string' } }
} }];
const json = JSON.stringify({ dsh_tool_calls: [{ name: 'write', arguments: { file_path: 'test.txt', content: 'nonce' } }] });

test('valid action becomes native DSH tool-call chunks with unique ids', () => {
  const reply = parseReply('```json\n' + json + '\n```', tools);
  const chunks = [...replyChunks(reply)];
  assert.equal(chunks[1].type, 'tool-call-delta');
  assert.equal(chunks[1].name, 'write');
  assert.equal(JSON.parse(chunks[1].argumentsDelta).content, 'nonce');
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.notEqual(reply.calls[0].id, parseReply(json, tools).calls[0].id);
});
test('tool examples embedded in prose never execute', () => {
  assert.equal(parseReply('这是格式示例：\n' + json, tools).calls.length, 0);
});
test('unknown tools, malformed actions, invalid required types fail closed', () => {
  assert.throws(() => parseReply(json, []), /未知工具/);
  assert.throws(() => parseReply('{"dsh_tool_calls": [}', tools), /格式错误/);
  assert.throws(() => parseReply('{"dsh_tool_calls": []}', tools), /1 至 16/);
  assert.throws(() => parseReply(JSON.stringify({ dsh_tool_calls: [{ name: 'write', arguments: { file_path: 7, content: 'x' } }] }), tools), /不符合/);
  assert.throws(() => parseReply(JSON.stringify({ dsh_tool_calls: [{ name: 'write', arguments: [] }] }), tools), /必须是对象/);
});
test('system rules and actual tool errors survive the next-round prompt', () => {
  const messages = [
    { id: 's', role: 'system', content: [{ type: 'text', text: 'SYSTEM_NONCE' }] },
    { id: 'u', role: 'user', content: [{ type: 'text', text: 'TASK_NONCE' }] },
    { id: 't', role: 'tool', toolCallId: 'real-call', isError: true, content: [{ type: 'text', text: 'ACTUAL_ERROR' }] }
  ];
  const prompt = buildPrompt({ messages, tools }, 'u');
  assert.match(prompt, /SYSTEM_NONCE/);
  assert.match(prompt, /ACTUAL_ERROR/);
  assert.match(prompt, /error=true/);
  assert.doesNotMatch(prompt, /TASK_NONCE/);
  assert.match(prompt, /additionalProperties/);
});
test('unsupported attachments are rejected instead of pretending they were uploaded', () => {
  assert.throws(() => buildPrompt({messages:[{role:'user', content:[{type:'image'}]}]}, null), /仅支持文字/);
});
test('incremental requests omit known replies and unchanged tools, but retain new input and results', () => {
  const initial = { messages: [
    { id: 's', role: 'system', content: [{ type: 'text', text: 'KEEP_SYSTEM' }] },
    { id: 'u', role: 'user', content: [{ type: 'text', text: 'OLD_TASK' }] }
  ], tools };
  const next = { ...initial, messages: [...initial.messages,
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'KNOWN_LONG_ANSWER'.repeat(3000) }] },
    { id: 't', role: 'tool', toolCallId: 'real', content: [{ type: 'text', text: 'ACTUAL_RESULT' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'NEW_TASK' }] }
  ] };
  const prompt = buildPrompt(next, 'u', promptEnvelope(initial));
  assert.match(prompt, /ACTUAL_RESULT/);
  assert.match(prompt, /NEW_TASK/);
  assert.doesNotMatch(prompt, /KNOWN_LONG_ANSWER|OLD_TASK|additionalProperties/);
  const changed = { ...next, tools: [...tools, { name: 'read', parameters: { type: 'object' } }] };
  assert.match(buildPrompt(changed, 'u', promptEnvelope(initial)), /\nread\n/);
  assert.doesNotMatch(buildPrompt(changed, 'u', promptEnvelope(initial)), /KEEP_SYSTEM/); // Unchanged rules remain in the webpage.
  assert.match(buildPrompt(next), /KNOWN_LONG_ANSWER/); // A fresh webpage requires complete replay.
});

test('ordinary followups are the exact user text when rules and tools are unchanged', () => {
  const initial = { messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: '你好' }] }], tools };
  const next = { ...initial, messages: [...initial.messages, { id: 'u2', role: 'user', content: [{ type: 'text', text: '解释这个函数。\n保留换行。' }] }] };
  assert.equal(buildPrompt(next, 'u', promptEnvelope(initial)), '解释这个函数。\n保留换行。');
  assert.match(buildPrompt(next, 'u', promptEnvelope(initial), false), /本轮工具与参数定义/); // Changing modes reinitializes the protocol.
  assert.match(buildPrompt(next, 'u', promptEnvelope(initial, false), false), /DSH 新增消息/);
});

test('small host rule edits keep every rule effective without replaying unrelated rules', () => {
  const fixed = 'KEEP_ALL_SECURITY_RULES'.repeat(400);
  const initial = { messages: [{ id: 's', role: 'system', content: [{ type: 'text', text: fixed + '\n\nMODE=old' }] }, { id: 'u', role: 'user', content: [{ type: 'text', text: 'task' }] }], tools };
  const next = { ...initial, messages: [{ ...initial.messages[0], content: [{ type: 'text', text: fixed + '\n\nMODE=new' }] }, initial.messages[1], { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next' }] }] };
  const start = buildPrompt(initial);
  const delta = buildPrompt(next, 'u', promptEnvelope(initial));
  assert.match(start, /KEEP_ALL_SECURITY_RULES/);
  assert.match(delta, /移除：[^\n]+/);
  assert.match(delta, /MODE=new/);
  assert.doesNotMatch(delta, /KEEP_ALL_SECURITY_RULES|MODE=old/);
  assert.ok(delta.length < 600);
  const fenced = { messages: [{ role: 'system', content: [{ type: 'text', text: 'rule\n\n```js\na();\n\nb();\n```' }] }] };
  assert.match(buildPrompt(fenced), /```js\na\(\);\n\nb\(\);\n```/);
});

test('compact tool schemas retain nested constraints and literal property names', () => {
  const catalog = [{ name: 'strict', description: 'First sentence. ' + 'Verbose docs. '.repeat(100), parameters: { type: 'object', additionalProperties: false, required: ['description'], properties: {
    description: { type: 'string', minLength: 3, description: 'Parameter documentation' },
    entries: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 5 } },
    payload: { enum: [{ description: 'literal', default: 'literal-default' }] }
  } } }];
  const compact = toolCatalog(catalog);
  assert.ok(compact.length < toolCatalog(catalog, false).length / 2);
  assert.doesNotMatch(compact, /Verbose docs|Parameter documentation/);
  const schema = JSON.parse(compact.slice(compact.indexOf('\n') + 1));
  assert.equal(schema.properties.description.minLength, 3);
  assert.equal(schema.properties.entries.items.maximum, 5);
  assert.equal(schema.properties.payload.enum[0].default, 'literal-default');
  assert.throws(() => parseReply(JSON.stringify({ dsh_tool_calls: [{ name: 'strict', arguments: { description: 'no' } }] }), catalog), /不符合/);
});
test('long transport preserves all text, limits packets and never exposes partial work as final', () => {
  const text = '宿主说明\n' + '甲😀乙'.repeat(12000) + '\n完整工具结果和末尾任务';
  const packets = promptPackets(text, 12000);
  assert.ok(packets.length > 2);
  assert.ok(packets.every(p => p.text.length <= 12000));
  assert.ok(packets.slice(0, -1).every(p => !p.final && p.ack));
  assert.equal(packets.filter(p => p.final).length, 1);
  const reconstructed = packets.slice(0, -1).map(p => p.text.split('[分段原文开始]\n')[1].split('\n[分段原文结束]')[0]).join('');
  assert.equal(reconstructed, text);
  assert.match(packets.at(-1).text, /DSH-COMMIT/);
  assert.deepEqual(promptPackets('short', 12000), [{ text: 'short', final: true }]);
});
test('replaced runtime snapshots do not replay a long answer or an unchanged catalog', () => {
  const initial = { messages: [
    { id: 's', role: 'system', content: [{ type: 'text', text: 'SYSTEM_FIRST' }] },
    { id: 'u', role: 'user', content: [{ type: 'text', text: 'USER_FIRST' }] },
    { id: 'runtime-old', role: 'user', content: [{ type: 'text', text: 'RUNTIME_OLD' }] }
  ], tools };
  const next = { tools, messages: [
    { id: 's', role: 'system', content: [{ type: 'text', text: 'SYSTEM_UPDATED' }] },
    initial.messages[1],
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'LONG_ANSWER'.repeat(3000) }] },
    { id: 'runtime-new', role: 'user', content: [{ type: 'text', text: 'RUNTIME_NEW' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'FOLLOWUP' }] }
  ] };
  const prompt = buildPrompt(next, { ids: initial.messages.map(m => m.id) }, promptEnvelope(initial));
  assert.match(prompt, /SYSTEM_UPDATED|RUNTIME_NEW|FOLLOWUP/);
  assert.doesNotMatch(prompt, /LONG_ANSWER|USER_FIRST|additionalProperties/);
  assert.ok(prompt.length < 1000);
});
test('stream yields tool calls, preserves model selection and forwards real result next turn', async () => {
  const requests = [];
  const channel = { async turn(request) { requests.push(request); return { text: requests.length === 1 ? json : '读回 nonce', model: '网页当前模型' }; } };
  const adapter = new WebAdapter('gemini-web', {contextWindow:64000,maxPromptChars:100000}, channel);
  const message = {id:'u1',role:'user',content:[{type:'text',text:'写入测试文件'}]};
  const first = [];
  for await (const chunk of adapter.stream({model:'gemini-web-auto',sessionId:'s1',tools,messages:[message]})) first.push(chunk);
  const tool = first.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  assert.equal(first.at(-1).reason.kind, 'tool-calls');
  assert.equal(first[0].index,0);
  assert.equal(first.find(c=>c.type==='tool-call-delta').index,1);
  const result={id:'t1',role:'tool',toolCallId:tool.id,isError:false,content:[{type:'text',text:'写入 nonce'}]};
  const second=[];
  for await (const chunk of adapter.stream({model:'gemini-web-auto',sessionId:'s1',tools,messages:[message,result]})) second.push(chunk);
  assert.match(requests[1].text,/写入 nonce/);
  assert.equal(second.at(-1).reason.kind,'stop');
});
test('invalid action is never emitted and one repair is allowed', async () => {
  const requests=[];
  const channel={async turn(r){requests.push(r);return {text:requests.length===1?' {"dsh_tool_calls": [}':json};}};
  const adapter=new WebAdapter('perplexity-web',{contextWindow:64000,maxPromptChars:100000},channel);
  const chunks=[];
  for await(const c of adapter.stream({model:'perplexity-web-auto',sessionId:'repair',tools,messages:[{id:'u',role:'user',content:[{type:'text',text:'写入文件'}]}]})) chunks.push(c);
  assert.equal(requests.length,2);
  assert.match(requests[1].text,/尚未执行任何工具/);
  assert.equal(chunks.filter(c=>c.type==='tool-call-delta').length,1);
});
test('two malformed replies stop without any tool emission or cursor advance',async()=>{
  let rounds=0;
  const adapter=new WebAdapter('gemini-web',{contextWindow:64000,maxPromptChars:100000},{async turn(){rounds++;return {text:'{"dsh_tool_calls": [}'};}});
  const chunks=[];
  await assert.rejects(async()=>{for await(const c of adapter.stream({model:'gemini-web-auto',sessionId:'invalid',tools,messages:[{id:'u',role:'user',content:[{type:'text',text:'写文件'}]}]})) chunks.push(c);}, /格式错误/);
  assert.equal(rounds,2);
  assert.equal(chunks.length,0);
  assert.equal(adapter.cursors.has('invalid'),false);
});
test('a tool reply during fragment acknowledgement cannot reach the DSH executor', async () => {
  const channel = new BrowserChannel('perplexity-web', { maxPromptChars: 100000, perplexityMessageChars: 2000 });
  channel.pageFor = async () => ({});
  channel.ready = async () => {};
  let requests = 0;
  channel.exchange = async () => { requests++; return { text: json }; };
  const adapter = new WebAdapter('perplexity-web', { contextWindow: 128000, maxPromptChars: 100000 }, channel);
  const chunks = [];
  await assert.rejects(async () => {
    for await (const c of adapter.stream({ model: 'perplexity-web-auto', sessionId: 'bad-ack', tools,
      messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: '长输入'.repeat(5000) }] }] })) chunks.push(c);
  }, /未确认接收/);
  assert.equal(requests, 1);
  assert.equal(chunks.length, 0);
  assert.equal(adapter.cursors.has('bad-ack'), false);
  assert.equal(adapter.envelopes.has('bad-ack'), false);
});
