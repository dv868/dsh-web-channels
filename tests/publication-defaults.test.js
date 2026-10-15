import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserChannel, hasPerplexityLogin } from '../lib/browser.js';

test('public default enters the official site without requiring a custom identity provider', () => {
  const channel = new BrowserChannel('perplexity-web', {});
  assert.equal(channel.site.home, 'https://www.perplexity.ai/');
  assert.equal(channel.entryOrigin, channel.site.origin);
});

test('optional HTTPS sign-in entry is local configuration, and credentials in URLs are rejected', () => {
  const channel = new BrowserChannel('perplexity-web', { perplexityEntryUrl: 'https://login.example.org/start' });
  assert.equal(channel.site.home, 'https://login.example.org/start');
  assert.equal(channel.site.origin, 'https://www.perplexity.ai');
  for (const url of ['http://login.example.org', 'https://person:secret@login.example.org']) {
    assert.throws(() => new BrowserChannel('perplexity-web', { perplexityEntryUrl: url }), error => error.code === 'WEB_CONFIG_INVALID');
  }
});

test('empty account label never matches arbitrary blank page text', async () => {
  const patterns = [];
  const locator = { first() { return this; }, async waitFor() {} };
  const page = { locator() { return locator; }, getByText(pattern) { patterns.push(pattern); return locator; } };
  assert.equal(await hasPerplexityLogin(page), true);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].test(''), false);
  assert.equal(patterns[0].test('Enterprise Pro'), true);
  assert.equal(patterns[0].test('Pro'), true);
});
