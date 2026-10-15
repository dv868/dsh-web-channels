import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { BrowserChannel } from '../lib/browser.js';
import { parseReply } from '../lib/protocol.js';
let browser;
for (const port of [Number(process.env.DSH_WEB_CHANNELS_TEST_PORT || 9336)]) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 }); break; } catch {}
}
if (!browser) throw new Error('需要已有的通道 Edge。');
const page=await browser.contexts()[0].newPage();
try {
  const channel=new BrowserChannel('perplexity-web',{});
  await page.setContent('<div class="prose" data-renderer="lm"><p>第一段</p><p>第二段<span data-pplx-citation data-pplx-citation-url="https://example.com/source"><a href="https://example.com/source">来源</a></span></p></div>');
  let result=(await channel.snapshot(page))[0];
  assert.equal(result.text,'第一段\n\n第二段');
  assert.equal(result.citations[0].url,'https://example.com/source');
  const toolJson='{"dsh_tool_calls":[{"name":"read","arguments":{"file_path":"D:/test.txt"}}]}';
  await page.setContent('<div class="prose" data-renderer="lm"><p>这是示例，不是工具请求：</p><pre><code>'+toolJson+'</code></pre></div>');
  result=(await channel.snapshot(page))[0];
  assert.equal(parseReply(result.text,[]).calls.length,0);
  await page.setContent('<div class="prose" data-renderer="lm"><pre><code>'+toolJson+'</code></pre></div>');
  result=(await channel.snapshot(page))[0];
  assert.equal(parseReply(result.text,[{name:'read',parameters:{type:'object'}}]).calls.length,1);
  console.log('DOM 验证通过：段落、引用 URL、代码块 JSON、正文里的工具示例不执行。');
  await page.setContent(`<div class="prose" data-renderer="lm"><h2>格式验收</h2><p><strong>粗体</strong>、<em>斜体</em>与 <code>a_b()</code>。</p><ol start="3"><li>第一步<ul><li>子项目</li></ul></li><li>第二步</li></ol><blockquote><p>引用文字</p></blockquote><table><thead><tr><th>名称</th><th align="right">值</th></tr></thead><tbody><tr><td>Alpha</td><td><strong>2</strong></td></tr></tbody></table><pre><code class="language-js">function x() {\n  const s = '\`\`\`';\n\n\n  return 1;\n}</code></pre><p><a href="https://example.com/a">参考链接</a></p><hr></div>`);
  result = (await channel.snapshot(page))[0];
  assert.match(result.text, /## 格式验收/);
  assert.match(result.text, /\*\*粗体\*\*、\*斜体\*/);
  assert.match(result.text, /`a_b\(\)`/);
  assert.match(result.text, /3\. 第一步\n\n   - 子项目\n4\. 第二步/);
  assert.match(result.text, /> 引用文字/);
  assert.match(result.text, /\| 名称 \| 值 \|\n\| --- \| ---: \|\n\| Alpha \| \*\*2\*\* \|/);
  assert.match(result.text, /````js\nfunction x\(\) \{\n  const s = '```';\n\n\n  return 1;/);
  assert.match(result.text, /\[参考链接\]\(<https:\/\/example.com\/a>\)/);
  assert.match(result.text, /\n\n---$/);
  console.log('格式 DOM 验证通过：粗斜体、内联代码、有序及嵌套列表、引用、表格、语言标签、代码缩进和空行。\n' + result.text);
  await page.setContent('<div class="prose" data-renderer="lm"><pre><figure><figcaption><span>javascript</span><button>复制代码</button></figcaption><code>const x = 1;</code></figure></pre><code-block><div class="code-block-decoration"><span>JavaScript</span><button>复制代码</button></div><pre><code>const y = 2;</code></pre></code-block><p><span class="katex"><span class="katex-mathml"><math><semantics><mrow>duplicated math</mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">duplicated visual</span></span></p></div>');
  result = (await channel.snapshot(page))[0];
  assert.match(result.text, /```javascript\nconst x = 1;\n```/);
  assert.match(result.text, /```javascript\nconst y = 2;\n```/);
  assert.match(result.text, /\$x\^2\$/);
  assert.doesNotMatch(result.text, /duplicated|复制代码/);
  console.log('真实网页代码结构与公式验证通过：Perplexity figcaption、Gemini code-block、LaTeX 单份输出。');
  const replies = Array.from({ length: 8 }, () => '<section><div class="prose" data-renderer="lm">OK</div><button aria-label="复制">copy</button></section>').join('');
  await page.setContent('<div id="replies">' + replies + '</div><div id="ask-input" role="textbox" contenteditable="true"></div><button aria-label="提交" id="submit">send</button>');
  await page.evaluate(() => document.querySelector('#submit').addEventListener('click', () => {
    document.querySelector('#ask-input').textContent = '';
    setTimeout(() => {
      document.querySelector('#replies').firstElementChild.remove();
      const section = document.createElement('section');
      section.innerHTML = '<div class="prose" data-renderer="lm">OK</div><button aria-label="复制">copy</button>';
      document.querySelector('#replies').appendChild(section);
    }, 100);
  }));
  const virtualizedChannel = new BrowserChannel('perplexity-web', { timeoutMs: 10000 });
  virtualizedChannel.selection = async () => 'fixture-current';
  const before = await virtualizedChannel.snapshot(page);
  const response = await virtualizedChannel.exchange(page, 'another message', true);
  const after = await virtualizedChannel.snapshot(page);
  assert.equal(response.text, 'OK');
  assert.equal(before.length, after.length);
  assert.notEqual(before.at(-1).identity, after.at(-1).identity);
  assert.equal(after.at(-1).complete, true);
  console.log('长对话 DOM 验证通过：回复数及复制按钮数保持 8、文本相同，仍能识别新的完整回复。');
} finally { await page.close(); await browser.close(); }
