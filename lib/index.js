import z from '@deepseek-ai/schemastery';
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { BrowserChannel } from './browser.js';
import { buildPrompt, promptEnvelope, parseReply, replyChunks, envelopeIndex, checkpointOf, cursorSurvives, auxiliaryPrompt } from './protocol.js';
import { RequestGate, SessionStore } from './state.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const name = 'llm-web-channels';
export const inject = ['llm'];
export const Config = z.object({
  debugPort: z.number().step(1).min(1024).max(65535).default(9336),
  autoStartBrowser: z.boolean().default(true),
  managedPort: z.number().step(1).min(1024).max(65535).default(9336),
  geminiEnabled: z.boolean().default(true),
  perplexityEnabled: z.boolean().default(true),
  timeoutMs: z.number().min(10000).default(600000),
  maxPromptChars: z.number().min(1000).default(100000),
  perplexityMessageChars: z.number().min(2000).max(12000).default(12000),
  compactPrompts: z.boolean().default(true),
  restoreSessions: z.boolean().default(true),
  stateDirectory: z.string().default(''),
  perplexityEntryUrl: z.string().default('https://www.perplexity.ai/'),
  perplexityAccountLabel: z.string().default(''),
  responseStableMs: z.number().min(1000).default(2500),
  contextWindow: z.number().min(81920).default(128000)
});

const TITLES = { 'gemini-web': 'Gemini 网页版', 'perplexity-web': 'Perplexity 网页版' };

export class WebAdapter extends LlmAdapter {
  constructor(provider, config, channel = new BrowserChannel(provider, config), store) {
    super();
    this.provider = provider;
    this.config = config;
    this.channel = channel;
    this.cursors = new Map();
    this.envelopes = new Map();
    this.checkpoints = new Map();
    this.bindings = new Map();
    this.gate = new RequestGate();
    this.store = store ?? new SessionStore();
  }
  providerInfo() { return { id: this.provider, name: TITLES[this.provider] }; }
  async listModels() {
    return [false, true].map(auto => ({
      provider: this.provider,
      id: this.provider + (auto ? '-auto' : ''),
      name: `${TITLES[this.provider]}（网页当前模型·${auto ? '全自动' : '半自动'}）`,
      description: '使用通道标签页当前选中的模型；请在浏览器切换。支持 DSH 宿主工具调用，文字首版。',
      inputModalities: ['text']
    }));
  }
  async resolveModel(provider, model) {
    const info = (await this.listModels()).find(m => m.id === model);
    if (!info) throw new LlmError(`未知网页模型 ${model}`, 'UNKNOWN_MODEL');
    return { ...info, context: { contextWindow: this.config.contextWindow }, defaultMaxTokens: 8192 };
  }
  async *stream(options) {
    const release = await this.gate.acquire(options.signal);
    const auxiliary = ['compaction', 'session-title'].includes(options.purpose);
    let completed = false;
    try {
      await this.resolveModel(this.provider, options.model);
      if (auxiliary) yield* this.streamAuxiliary(options);
      else yield* this.streamTask(options);
      completed = true;
    } finally {
      if (!completed && !auxiliary) this.channel.invalidate?.(options.sessionId ?? 'anonymous');
      release();
    }
  }
  async *streamAuxiliary(options) {
    const sessionId = `aux-${options.purpose}-${randomUUID()}`;
    const text = auxiliaryPrompt(options);
    if (text.length > this.config.maxPromptChars) throw new LlmError('内部摘要历史过长，未提交不完整摘要；请缩小压缩范围或选择独立摘要模型。', 'CONTEXT_WINDOW_EXCEEDED');
    console.info(`[${this.provider}] 内部辅助请求开始：${options.purpose}；使用临时标签。`);
    try {
      const result = await this.channel.turn({ sessionId, text, fullText: text, auto: options.model.endsWith('-auto'), signal: options.signal, temporary: true, purpose: options.purpose });
      options.signal?.throwIfAborted();
      for (const chunk of replyChunks({ text: result.text, calls: [] })) yield chunk;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error.code === 'WEB_REPLY_TRUNCATED') { yield { type: 'finish', reason: { kind: 'max-tokens' } }; return; }
      throw error instanceof LlmError ? error : new LlmError(error.message, typeof error.code === 'string' ? error.code : 'WEB_AUXILIARY_FAILED', { cause: error });
    } finally {
      await this.channel.closeTemporary?.(sessionId);
      console.info(`[${this.provider}] 内部辅助请求结束：${options.purpose}；工作会话未修改。`);
    }
  }
  async *streamTask(options) {
    await this.resolveModel(this.provider, options.model);
    const sessionId = options.sessionId ?? 'anonymous';
    const saved = await this.store.get(sessionId);
    if (!this.cursors.has(sessionId) && saved) {
      this.cursors.set(sessionId, saved.cursor);
      this.envelopes.set(sessionId, saved.envelope);
      this.checkpoints.set(sessionId, saved.checkpoint);
      this.bindings.set(sessionId, saved.binding);
    }
    const checkpoint = checkpointOf(options);
    const cursor = this.cursors.get(sessionId);
    const reset = !!cursor && (this.checkpoints.get(sessionId) !== checkpoint || !cursorSurvives(options, cursor));
    if (reset) console.info(`[${this.provider}] 检查点或历史范围变化，回放宿主摘要与近期消息；继续原 DSH 会话。`);
    const compact = this.config.compactPrompts !== false;
    const envelope = promptEnvelope(options, compact);
    const prompt = buildPrompt(options, reset ? undefined : cursor, reset ? undefined : this.envelopes.get(sessionId), compact);
    if (prompt.length > this.config.maxPromptChars) throw new LlmError('网页提示词过长，请在 DSH 中压缩上下文或开始新会话。未发送消息。', 'CONTEXT_WINDOW_EXCEEDED');
    let result;
    try {
      result = await this.channel.turn({ sessionId, text: prompt, fullText: buildPrompt(options, undefined, undefined, compact), auto: options.model.endsWith('-auto'), signal: options.signal, reset, binding: this.bindings.get(sessionId) });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof LlmError) throw error;
      throw new LlmError(`${TITLES[this.provider]}：${error.message}`, typeof error.code === 'string' ? error.code : 'WEB_TURN_FAILED', { cause: error });
    }
    let reply;
    options.signal?.throwIfAborted();
    try { reply = parseReply(result.text, options.tools, { strictIntent: true }); }
    catch (error) {
      // One bounded repair round: never execute a malformed or unknown action.
      console.warn(`[${this.provider}] ${error.message} 请求网页模型修正一次。`);
      const repair = `${prompt}\n\n[工具格式校验失败，尚未执行任何工具]\n${error.message}\n[完整工具说明与参数，供纠错]\n${JSON.stringify(options.tools ?? [])}\n请重新输出你确实需要请求的工具调用，使用 json 代码围栏、完整有效 JSON、正斜杠文件路径。只能使用上面的工具。不要自行宣称执行完成。`;
      if (repair.length > this.config.maxPromptChars) throw new LlmError(error.message, 'WEB_TOOL_FORMAT_REJECTED', { cause: error });
      result = await this.channel.turn({ sessionId, text: repair, fullText: repair, auto: options.model.endsWith('-auto'), signal: options.signal });
      options.signal?.throwIfAborted();
      try { reply = parseReply(result.text, options.tools, { strictIntent: true }); }
      catch (second) { throw new LlmError(second.message, 'WEB_TOOL_FORMAT_REJECTED', { cause: second }); }
    }
    if (!reply.calls.length && result.citations) reply.text += `\n\n来源：\n${result.citations}`;
    if (result.model) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      const text = `网页选择：${result.model}\n`;
      yield { type: 'reasoning-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text } };
    }
    for (const chunk of replyChunks(reply)) {
      options.signal?.throwIfAborted();
      yield 'index' in chunk ? { ...chunk, index: chunk.index + (result.model ? 1 : 0) } : chunk;
    }
    options.signal?.throwIfAborted();
    const nextCursor = { ids: options.messages.filter(m => !['system', 'developer'].includes(m.role)).map(m => m.id).filter(Boolean) };
    this.cursors.set(sessionId, nextCursor);
    this.envelopes.set(sessionId, envelope);
    this.checkpoints.set(sessionId, checkpoint);
    this.bindings.set(sessionId, result.binding);
    try { await this.store.set(sessionId, { cursor: nextCursor, envelope: envelopeIndex(envelope), checkpoint, binding: result.binding }); }
    catch (error) { console.warn(`[${this.provider}] 会话索引保存失败，下次重启将从 DSH 历史恢复：${error.message}`); }
  }
}

export function apply(ctx, config) {
  for (const [provider, enabled] of [['gemini-web', config.geminiEnabled], ['perplexity-web', config.perplexityEnabled]]) {
    if (!enabled) continue;
    const root = config.stateDirectory || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'web-channels');
    const store = new SessionStore(config.restoreSessions === false ? undefined : path.join(root, `sessions-${provider}.json`));
    const adapter = new WebAdapter(provider, config, new BrowserChannel(provider, config), store);
    ctx.effect(() => {
      const unregister = ctx.llm.registerAdapter([provider], adapter);
      return async () => { unregister(); await adapter.channel.dispose(); };
    }, provider);
    ctx.logger.info(`${provider} registered (CDP=${config.debugPort}, model=web-current)`);
  }
}
