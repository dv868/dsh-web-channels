import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promptPackets } from './transport.js';
import { extractResponses } from './markdown.js';
import { digest } from './state.js';
import { visibleSiteIssue } from './issues.js';

let managedLaunch;
async function connectManaged(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  try { return await chromium.connectOverCDP(endpoint, { timeout: 1500 }); } catch {}
  if (!managedLaunch) managedLaunch = (async () => {
    const paths = [
      path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/Application/msedge.exe')
    ];
    const executable = paths.find(existsSync);
    if (!executable) fail('未找到 Microsoft Edge。请保持现有 CDP 浏览器开启。', 'WEB_BROWSER_REQUIRED');
    const root = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'DshWebChannels', 'edge-profile');
    await mkdir(root, { recursive: true });
    const child = spawn(executable, [
      `--user-data-dir=${root}`, '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  })();
  await managedLaunch;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { return await chromium.connectOverCDP(endpoint, { timeout: 1000 }); } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  managedLaunch = undefined;
  fail(`独立 Edge 已启动，但未能连接端口 ${port}。请检查窗口是否正在等待你的操作。`, 'WEB_BROWSER_REQUIRED');
}

const SITES = {
  'gemini-web': {
    origin: 'https://gemini.google.com', home: 'https://gemini.google.com/app',
    editor: '[role="textbox"][contenteditable="true"]',
    response: 'message-content .markdown',
    send: /^(发送|Send message|Send)$/i,
    stop: /停止回答|停止生成|Stop response|Stop generating/i
  },
  'perplexity-web': {
    // An optional HTTPS sign-in entry can redirect to the official Perplexity origin.
    origin: 'https://www.perplexity.ai', home: 'https://www.perplexity.ai/',
    editor: '#ask-input',
    response: '[data-renderer="lm"].prose',
    send: /^(提交|发送|Submit|Send)$/i,
    stop: /停止|停止生成|Stop generating|Stop$/i
  }
};

function fail(message, code) { const error = new Error(message); error.code = code; throw error; }
function checkAbort(signal) { if (signal?.aborted) fail('本轮已取消。', 'ABORTED'); }

export async function hasPerplexityLogin(page, accountLabel = '') {
  try {
    await page.locator('#ask-input').first().waitFor({ state: 'visible', timeout: 15000 });
    return await Promise.any([
      accountLabel && page.getByText(new RegExp(`^${accountLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true),
      page.getByText(/^(企业版 Pro|Enterprise Pro|Pro)$/i).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true)
    ].filter(Boolean));
  } catch { return false; }
}

export class BrowserChannel {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.site = { ...SITES[provider] };
    if (provider === 'perplexity-web' && config.perplexityEntryUrl) {
      const entry = new URL(config.perplexityEntryUrl);
      if (entry.protocol !== 'https:' || entry.username || entry.password) fail('Perplexity 登录入口必须是无账号密码的 HTTPS 地址。', 'WEB_CONFIG_INVALID');
      this.site.home = entry.href;
    }
    this.entryOrigin = new URL(this.site.home).origin;
    this.pages = new Map();
    this.freshPages = new WeakSet();
    this.temporary = new Set();
    this.dirty = new Set();
    this.queue = Promise.resolve();
  }
  async connect() {
    if (this.browser?.isConnected()) return;
    try {
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.config.debugPort}`, { timeout: 10000 });
    } catch {
      if (this.config.autoStartBrowser !== false) {
        this.browser = await connectManaged(this.config.managedPort ?? 9336);
        console.info(`[${this.provider}] 使用独立 Edge 登录目录 DshWebChannels/edge-profile。请自行登录。`);
      } else fail(`无法连接 Edge CDP 端口 ${this.config.debugPort}。请保持已登录的通道 Edge 窗口开启。`, 'WEB_BROWSER_REQUIRED');
    }
  }
  async targetId(page) {
    const client = await page.context().newCDPSession(page);
    try { return (await client.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await client.detach(); }
  }
  invalidate(sessionId) { this.dirty.add(sessionId); }
  async closeTemporary(sessionId) {
    if (!this.temporary.has(sessionId)) return;
    const page = this.pages.get(sessionId);
    try { if (page && !page.isClosed()) await page.close(); }
    finally { this.pages.delete(sessionId); this.temporary.delete(sessionId); this.dirty.delete(sessionId); }
  }
  async pageFor(sessionId, { reset = false, binding, temporary = false, purpose } = {}) {
    await this.connect();
    if (reset || this.dirty.has(sessionId)) {
      this.pages.delete(sessionId); // Keep the old work tab available for inspection.
      this.dirty.delete(sessionId);
      binding = undefined;
    }
    if (temporary) this.temporary.add(sessionId);
    if (!this.pages.has(sessionId) && binding?.targetId && !temporary) {
      for (const candidate of this.browser.contexts().flatMap(context => context.pages())) {
        if (candidate.isClosed() || new URL(candidate.url()).origin !== this.site.origin) continue;
        if (await this.targetId(candidate).catch(() => '') !== binding.targetId) continue;
        const url = new URL(candidate.url());
        const last = (await this.snapshot(candidate)).at(-1);
        const generating = await candidate.getByRole('button', { name: this.site.stop }).first().isVisible().catch(() => false);
        if (!generating && !last?.busy && url.origin + url.pathname === binding.url && last && digest(last.text) === binding.replyHash) {
          this.pages.set(sessionId, candidate);
          console.info(`[${this.provider}] 已恢复本 DSH 会话原有网页标签及当前模型选择。`);
        } else console.info(`[${this.provider}] 原标签内容已变化，将在新标签从 DSH 历史恢复。`);
        break;
      }
    }
    const known = this.pages.get(sessionId);
    if (known && !known.isClosed()) {
      const origin = new URL(known.url()).origin;
      if (origin !== this.site.origin && !(this.provider === 'perplexity-web' && origin === this.entryOrigin)) fail('通道标签页离开了目标网站，请回到该网页或开始新 DSH 会话。', 'WEB_PAGE_MOVED');
      return known;
    }
    // Each DSH session owns one new tab. Never navigate an existing personal conversation.
    const page = await this.browser.contexts()[0].newPage();
    // Register before navigation so failed/cancelled auxiliary tabs are closed.
    this.pages.set(sessionId, page);
    this.freshPages.add(page);
    if (this.provider === 'perplexity-web') {
      await page.goto(this.site.origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (this.entryOrigin !== this.site.origin && !(await hasPerplexityLogin(page, this.config.perplexityAccountLabel ?? ''))) {
        await page.goto(this.site.home, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
    } else await page.goto(this.site.home, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (temporary) await page.evaluate(label => { document.title = label; }, `DSH ${purpose}（临时）`);
    // Both sites can defer initial chat rendering in an inactive new tab.
    await page.bringToFront();
    return page;
  }
  async ready(page, signal) {
    if (this.provider === 'perplexity-web' && this.entryOrigin !== this.site.origin && new URL(page.url()).origin === this.entryOrigin) {
      console.info('[perplexity-web] Pro 登录入口已打开，请自行点击继续登录；插件等待认证跳转，不代操作账号。');
      const deadline = Date.now() + (this.config.timeoutMs ?? 600000);
      while (new URL(page.url()).origin !== this.site.origin) {
        checkAbort(signal);
        if (page.isClosed()) fail('通道标签页已关闭。', 'WEB_PAGE_CLOSED');
        if (Date.now() >= deadline) fail('等待登录跳转超时。请在配置的登录入口标签页自行完成登录后重试。', 'WEB_LOGIN_REQUIRED');
        await page.waitForTimeout(250);
      }
    }
    if (new URL(page.url()).origin !== this.site.origin) fail('请在通道浏览器中自行完成登录，然后重试。', 'WEB_LOGIN_REQUIRED');
    if (this.provider === 'perplexity-web') {
      const login = page.getByRole('button', { name: /^(登录|Log in|Sign in)$/i });
      if (await login.first().isVisible().catch(() => false)) fail('请在此 Edge 窗口中自行登录 Perplexity Pro，然后重试。', 'WEB_LOGIN_REQUIRED');
    }
    try { await page.locator(this.site.editor).first().waitFor({ state: 'visible', timeout: 15000 }); }
    catch { fail('未找到聊天输入框。请自行完成登录并回到普通文字聊天页，然后重试。', 'WEB_LOGIN_REQUIRED'); }
  }
  async selection(page) {
    const button = this.provider === 'gemini-web'
      ? page.getByRole('button', { name: /打开模式选择器|Open mode picker|Open model picker|当前模式|current mode/i }).first()
      : page.locator('#ask-input')
          .locator('xpath=ancestor::div[.//button[@aria-haspopup="menu"]][1]')
          .locator('xpath=.//button[@aria-haspopup="menu" and .//*[local-name()="use" and @*[local-name()="href"]="#pplx-icon-chevron-down"]]').first();
    if (!(await button.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false))) return '网页当前模型（名称未识别）';
    const fallback = await button.getAttribute('aria-label', { timeout: 3000 }) || await button.innerText({ timeout: 3000 });
    // Read the current button only; opening its menu steals focus and flashes.
    if (this.provider === 'perplexity-web' && /^(模型|Model)$/i.test(fallback.trim())) return '网页默认模型（自动选择）';
    return fallback.replace(/\s+/g, ' ').trim() || '网页当前模型（名称未识别）';
  }
  async snapshot(page) {
    return page.locator(this.site.response).evaluateAll(extractResponses, this.site.response);
  }
  async turn(request) {
    // Keep browser composition and model selection deterministic within one provider.
    const pending = this.queue.catch(() => {}).then(() => this.runTurn(request));
    this.queue = pending;
    return pending;
  }
  async runTurn({ sessionId, text, fullText, auto, signal, reset, binding, temporary, purpose }) {
    checkAbort(signal);
    const page = await this.pageFor(sessionId, { reset, binding, temporary, purpose });
    await this.ready(page, signal);
    const prompt = this.freshPages.has(page) && fullText ? fullText : text;
    if (prompt.length > this.config.maxPromptChars) fail('恢复网页会话所需上下文过长，请先在 DSH 压缩上下文。未发送消息。', 'CONTEXT_WINDOW_EXCEEDED');
    const packets = promptPackets(prompt, this.provider === 'perplexity-web' ? (this.config.perplexityMessageChars ?? 12000) : this.config.maxPromptChars);
    if (packets.length > 1) console.info(`[${this.provider}] 长消息分为 ${packets.length - 1} 段，传输确认不会执行工具；最后一轮才处理任务。${auto ? '' : '半自动模式每段都需点击发送。'}`);
    let result;
    try {
      for (const packet of packets) {
        result = await this.exchange(page, packet.text, auto, signal);
        if (!packet.final && result.text.trim() !== packet.ack) fail('网页未确认接收长消息分段，已停止；没有向 DSH 提交任何工具动作。请重试或压缩上下文。', 'WEB_CHUNK_ACK_FAILED');
      }
    } catch (error) { this.invalidate(sessionId); throw error; }
    this.freshPages.delete(page);
    if (!temporary && result.url) {
      const url = new URL(result.url);
      try { result.binding = { targetId: await this.targetId(page), url: url.origin + url.pathname, replyHash: digest(result.text) }; }
      catch (error) { console.warn(`[${this.provider}] 未保存标签索引，下次重启将从宿主历史恢复：${error.message}`); }
    }
    return result;
  }
  async exchange(page, prompt, auto, signal) {
    const diagnostic = (...args) => { if (this.config.diagnostics) console.info(`[${this.provider}]`, ...args); };
    // Keep only this owned tab's document focused while it is serving a turn.
    // Chromium may otherwise suspend the site's response rendering in background.
    let focus;
    try {
      focus = await page.context().newCDPSession(page);
      await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (error) { diagnostic('focus emulation unavailable', error.message); }
    try {
    checkAbort(signal);
    const editor = page.locator(this.site.editor).first();
    if ((await editor.innerText()).trim()) fail('通道输入框已有未发送内容，请先发送或清空后重试。插件没有覆盖你的输入。', 'WEB_COMPOSER_OCCUPIED');
    const model = await this.selection(page);
    diagnostic('selection ready');
    if (await page.getByRole('button', { name: this.site.stop }).first().isVisible().catch(() => false)) fail('网页仍在生成上一条回复，请等待完成再重试。', 'WEB_BUSY');
    const before = await this.snapshot(page);
    diagnostic('snapshot before', before.length);
    const previousIssue = await visibleSiteIssue(page, this.site.response);
    if (previousIssue) fail(previousIssue.text, previousIssue.code);
    const copyBefore = await page.getByRole('button', { name: /^(复制|Copy|Copy answer|Copy response)$/i }).count();
    let sent = false;
    await editor.fill(prompt);
    diagnostic('filled');
    try {
    checkAbort(signal);
    if (auto) {
      const send = page.getByRole('button', { name: this.site.send }).first();
      await send.waitFor({ state: 'visible', timeout: 5000 });
      await send.click();
      diagnostic('send clicked');
      sent = true;
    } else {
      await page.bringToFront();
      console.info(`[${this.provider}] 消息已填写，请在通道标签页点击发送。`);
    }
    const deadline = Date.now() + this.config.timeoutMs;
    let stable = '';
    let stableAt = Date.now();
    let started = false;
    let diagnosticAt = 0;
    while (Date.now() < deadline) {
      checkAbort(signal);
      if (page.isClosed()) fail('通道标签页已关闭，请重新发送本轮任务。', 'WEB_PAGE_CLOSED');
      const issue = await visibleSiteIssue(page, this.site.response);
      if (issue) fail(issue.text, issue.code);
      const current = await this.snapshot(page);
      const last = current.at(-1);
      const previous = before.at(-1);
      const isNew = !!last && (current.length > before.length || last.identity !== previous?.identity || last.text !== previous?.text);
      const stopVisible = await page.getByRole('button', { name: this.site.stop }).first().isVisible().catch(() => false);
      if (stopVisible || isNew) { started = true; sent = true; }
      const replyText = isNew ? last.text : '';
      if (stable !== replyText) { stable = replyText; stableAt = Date.now(); }
      const copied = await page.getByRole('button', { name: /^(复制|Copy|Copy answer|Copy response)$/i }).count();
      if (Date.now() - diagnosticAt > 10000) {
        diagnostic('poll', { count: current.length, isNew, stopVisible, chars: replyText.length, complete: last?.complete, busy: last?.busy, stableMs: Date.now() - stableAt });
        diagnosticAt = Date.now();
      }
      if (started && replyText && !stopVisible && !last.busy && (last.complete || copied > copyBefore) && Date.now() - stableAt >= (this.config.responseStableMs ?? 2500)) {
        const unique = [...new Map(last.citations.filter(c => /^https?:\/\//.test(c.url ?? '')).map(c => [c.url, c])).values()];
        const citations = unique.map((c, i) => `[${i + 1}] ${c.label || '来源'} — ${c.url}`).join('\n');
        const finalModel = await this.selection(page);
        const modelLabel = finalModel === model ? model : model.includes('未识别')
          ? `回复后网页选择：${finalModel}（发送前名称未识别）`
          : `发送前：${model}；回复后：${finalModel}（网页选择发生变化）`;
        return { text: replyText, citations, model: modelLabel, url: page.url() };
      }
      await page.waitForTimeout(500);
    }
    fail('等待网页回复超时。请检查通道标签页的登录、额度或验证提示；插件没有自动重复发送。', 'WEB_TURN_TIMEOUT');
    } finally {
      if (signal?.aborted && !page.isClosed()) {
        if (sent) {
          const stop = page.getByRole('button', { name: this.site.stop }).first();
          if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 3000 }).catch(() => {});
        } else if ((await editor.innerText().catch(() => '')).trim() === prompt.trim()) await editor.fill('').catch(() => {});
      }
    }
    } finally {
      if (focus) {
        await focus.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        await focus.detach().catch(() => {});
      }
    }
  }
  async dispose() {
    // Never close the shared browser or user tabs (including DeepSeek's login profile).
    this.pages.clear();
    // For connectOverCDP, Playwright's documented Browser.close disconnects
    // its transport. It does not close the remotely owned browser or tabs.
    if (this.browser?.isConnected()) await this.browser.close();
    this.browser = undefined;
  }
}
