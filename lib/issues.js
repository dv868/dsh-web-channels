// Only feed visible site notices/alerts here, never model answer text.
export function classifySiteIssue(text) {
  const patterns = [
    ['WEB_QUERY_TOO_LONG', /查询超出字符上限|query.{0,30}(character limit|too long)|shorten.{0,30}(query|submit)/i],
    ['CONTEXT_WINDOW_EXCEEDED', /(?:conversation|context|聊天|对话|上下文).{0,35}(?:too long|limit reached|已达上限|超过.{0,8}上限|过长)/i],
    ['WEB_REPLY_TRUNCATED', /(?:response|output|回答|回复|输出).{0,35}(?:length limit|maximum length|token limit|达到.{0,8}上限|超出.{0,8}上限|已截断)/i],
    ['WEB_RATE_LIMITED', /too many requests|rate limit|发送过于频繁|请求过于频繁|使用次数.{0,12}上限|you.ve reached.{0,35}limit/i],
    ['WEB_REPLY_INTERRUPTED', /network error|connection lost|response interrupted|网络错误|网络连接.{0,8}(?:断开|中断)|生成失败|something went wrong|出现了?错误|unable to generate/i]
  ];
  for (const [code, pattern] of patterns) if (pattern.test(text)) return { code, text };
}

export async function visibleSiteIssue(page, responseSelector) {
  const notices = await page.locator('[role="alert"], [role="status"], .error-message, .response-error, .error-container, [data-testid="error-message"], [data-testid="toast"], [data-sonner-toast]').evaluateAll((nodes, response) => nodes.filter(node => {
    // Model prose, quoted notices and code samples cannot become page errors.
    if (node.closest(response) || node.querySelector(response)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }).map(node => node.innerText?.trim()).filter(Boolean), responseSelector);
  return notices.map(classifySiteIssue).find(Boolean);
}
