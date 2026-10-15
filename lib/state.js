import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const digest = value => createHash('sha256').update(value ?? '').digest('hex');

// Only identities and hashes are persisted: no prompts, replies, cookies or tokens.
export class SessionStore {
  constructor(file) { this.file = file; this.entries = {}; this.queue = Promise.resolve(); }
  async load() {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.file) return;
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8'));
        if (data.version !== 1 || !data.entries || typeof data.entries !== 'object') throw new Error('状态文件格式不兼容');
        this.entries = data.entries;
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`[web-channels] 无法读取会话索引，将从 DSH 历史重建：${error.message}`);
      }
    })();
    await this.loaded;
  }
  async get(sessionId) {
    await this.load();
    const state = this.entries[digest(sessionId)];
    if (!state) return;
    try {
      if (!Array.isArray(state.cursor?.ids) || !state.cursor.ids.every(id => typeof id === 'string') || typeof state.checkpoint !== 'string') throw new Error('消息索引无效');
      const envelope = JSON.parse(state.envelope);
      if (typeof envelope.instructionsHash !== 'string' || typeof envelope.toolsHash !== 'string' || !Array.isArray(envelope.sections)) throw new Error('规则索引无效');
      if (state.binding && !['targetId', 'url', 'replyHash'].every(key => typeof state.binding[key] === 'string')) throw new Error('标签索引无效');
      return state;
    } catch (error) { console.warn(`[web-channels] 会话索引不完整，将从 DSH 历史重建：${error.message}`); }
  }
  async set(sessionId, state) {
    await this.load();
    this.entries[digest(sessionId)] = state;
    if (!this.file) return;
    const data = JSON.stringify({ version: 1, entries: this.entries }, null, 2) + '\n';
    const pending = this.queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.file);
    });
    this.queue = pending;
    await pending;
  }
}

// Hold across the whole generator, including corrective turns and state commit.
export class RequestGate {
  constructor() { this.tail = Promise.resolve(); }
  async acquire(signal) {
    const before = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await before;
    if (signal?.aborted) { release(); signal.throwIfAborted(); }
    return release;
  }
}
