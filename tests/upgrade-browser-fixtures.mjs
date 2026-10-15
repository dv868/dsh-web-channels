import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BrowserChannel } from '../lib/browser.js';
import { visibleSiteIssue } from '../lib/issues.js';
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + Number(process.env.DSH_WEB_CHANNELS_TEST_PORT || 9336));
const page = await browser.contexts()[0].newPage();
const channel = new BrowserChannel('perplexity-web', { timeoutMs: 5000, responseStableMs: 1000 });
channel.selection = async () => 'fixture-model';
try {
  await page.setContent('<div role="alert">The response reached the maximum length</div>');
  assert.equal((await visibleSiteIssue(page, channel.site.response)).code, 'WEB_REPLY_TRUNCATED');
  await page.setContent('<div data-renderer="lm" class="prose"><div role="alert">The response reached the maximum length</div></div>');
  assert.equal(await visibleSiteIssue(page, channel.site.response), undefined);
  console.log('页面错误识别：真实提示触发截断错误，模型引用同样文字不触发。');
  await page.setContent('<div id="ask-input" contenteditable="true" role="textbox"></div><button aria-label="Submit">Submit</button>');
  const controller = new AbortController();
  const pending = channel.exchange(page, 'OWNED-UNSENT-020', false, controller.signal);
  while (!(await page.locator('#ask-input').innerText()).includes('OWNED-UNSENT')) await page.waitForTimeout(20);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ABORTED');
  assert.equal((await page.locator('#ask-input').innerText()).trim(), '');
  console.log('取消半自动：清理本轮自己填写且未被用户修改的待发送内容。');
  await page.locator('#ask-input').fill('USER-DRAFT');
  await assert.rejects(channel.exchange(page, 'DO-NOT-OVERWRITE', true), error => error.code === 'WEB_COMPOSER_OCCUPIED');
  assert.equal(await page.locator('#ask-input').innerText(), 'USER-DRAFT');
  console.log('用户草稿保护：输入框被占用时不覆盖、不发送。');
  await page.setContent('<div id="ask-input" contenteditable="true" role="textbox"></div><button aria-label="Submit">Submit</button>');
  await page.getByRole('button', { name: 'Submit', exact: true }).evaluate(button => button.addEventListener('click', () => {
    document.querySelector('#ask-input').textContent = '';
    document.body.insertAdjacentHTML('beforeend', '<div><div data-renderer="lm" class="prose"><h2>完整回复</h2><p>FINISH-020</p></div><button aria-label="Copy">Copy</button></div>');
  }));
  const result = await channel.exchange(page, 'FIXTURE-020', true);
  assert.match(result.text, /## 完整回复\n\nFINISH-020/);
  console.log('回复结束与排版：等待完整标记和稳定期，保留 Markdown 标题与段落。');
} finally { await page.close(); await browser.close(); }
