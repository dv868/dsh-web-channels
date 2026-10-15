// Self-contained so Playwright can serialize this function into the page.
// Read the rendered reply only; never use the system clipboard or page scripts.
export function extractResponses(elements, selector) {
  return elements.map(element => {
    const registry = window.__dshWebChannelsResponseIds ??= { nodes: new WeakMap(), next: 0 };
    if (!registry.nodes.has(element)) registry.nodes.set(element, ++registry.next);
    const identity = registry.nodes.get(element);
    let complete = false;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.querySelectorAll(selector).length > 1) break;
      complete = [...ancestor.querySelectorAll('button')].some(button => /^(复制|Copy|Copy answer|Copy response)$/i.test(button.getAttribute('aria-label') ?? button.textContent.trim()));
      if (complete) break;
    }
    const copy = element.cloneNode(true);
    const citations = [...copy.querySelectorAll('[data-pplx-citation-url]')].map(e => ({ label: e.textContent.trim(), url: e.getAttribute('data-pplx-citation-url') }));
    copy.querySelectorAll('[data-pplx-citation], [data-pplx-citation-url], .citation, .citation-nbsp, button, script, style, .katex-html, [data-testid="code-block-header"]').forEach(e => e.remove());
    const language = node => {
      const hints = [node, node.querySelector('code'), node.closest('code-block'), node.closest('[data-language]')].filter(Boolean);
      for (const hint of hints) {
        const value = hint.getAttribute('data-language') || hint.getAttribute('lang') || hint.className?.toString().match(/(?:language|lang)-([\w+#.-]+)/)?.[1];
        if (value && /^[\w+#.-]+$/.test(value)) return value.toLowerCase();
      }
      const label = node.querySelector('figcaption > span, .code-block-decoration > span')?.textContent.trim();
      if (label && /^[\w+#.-]+$/.test(label)) return label.toLowerCase();
      return '';
    };
    const codeBlock = node => {
      const source = node.querySelector('code') ?? node.querySelector('pre') ?? node;
      const text = source.textContent.replace(/^\n/, '').replace(/\n$/, '');
      const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
      const fence = '`'.repeat(longest + 1);
      return `\n\n${fence}${language(node)}\n${text}\n${fence}\n\n`;
    };
    const children = node => [...node.childNodes].map(markdown).join('');
    const list = node => {
      const start = Number(node.getAttribute('start')) || 1;
      return '\n\n' + [...node.children].filter(n => n.tagName === 'LI').map((item, i) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        const marker = node.tagName === 'OL' ? `${start + i}. ` : '- ';
        const body = children(item).trim();
        const lines = body.split('\n');
        const checked = checkbox ? (checkbox.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
        return marker + checked + lines[0] + lines.slice(1).map(line => '\n' + (line ? ' '.repeat(marker.length) + line : '')).join('');
      }).join('\n') + '\n\n';
    };
    const table = node => {
      const rows = [...node.rows].map(row => [...row.cells].map(cell => children(cell).trim().replace(/\r?\n+/g, '<br>').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(r => r.length));
      const line = row => '| ' + Array.from({length: width}, (_, i) => row[i] ?? '').join(' | ') + ' |';
      const header = node.rows[0];
      const divider = Array.from({length: width}, (_, i) => {
        const align = header.cells[i]?.getAttribute('align') || header.cells[i]?.style.textAlign;
        return align === 'right' ? '---:' : align === 'center' ? ':---:' : '---';
      });
      const hasHeader = [...header.cells].some(c => c.tagName === 'TH');
      return '\n\n' + [line(hasHeader ? rows.shift() : []), line(divider), ...rows.map(line)].join('\n') + '\n\n';
    };
    function markdown(node) {
      if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      if (['button', 'script', 'style', 'input', 'svg'].includes(tag)) return '';
      if (tag === 'pre' || tag === 'code-block') return codeBlock(node);
      if (tag === 'table') return table(node);
      if (tag === 'ul' || tag === 'ol') return list(node);
      const math = node.querySelector(':scope > annotation[encoding="application/x-tex"]');
      if (math) {
        const display = node.closest('.katex-display') || node.getAttribute('display') === 'block';
        return display ? `\n\n$$\n${math.textContent}\n$$\n\n` : `$${math.textContent}$`;
      }
      if (tag === 'br') return '\n';
      if (tag === 'hr') return '\n\n---\n\n';
      if (tag === 'code') {
        const text = node.textContent;
        const fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length)) + 1);
        const pad = /^`|`$/.test(text) ? ' ' : '';
        return fence + pad + text + pad + fence;
      }
      const inside = children(node);
      if (tag === 'strong' || tag === 'b') return `**${inside.trim()}**`;
      if (tag === 'em' || tag === 'i') return `*${inside.trim()}*`;
      if (tag === 'del' || tag === 's') return `~~${inside.trim()}~~`;
      if (tag === 'a' && /^(https?:|mailto:)/.test(node.getAttribute('href') ?? '')) return `[${inside.trim()}](<${node.getAttribute('href').replace(/>/g, '%3E')}>)`;
      if (tag === 'blockquote') return '\n\n' + inside.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
      if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inside.trim()}\n\n`;
      if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') return `\n\n${inside.trim()}\n\n`;
      if (tag === 'img') return node.getAttribute('alt') || '';
      return inside;
    }
    // Only a reply consisting exclusively of tool JSON can become an action.
    const code = copy.querySelectorAll('pre code, code-block code');
    const jsonCode = [...code].find(e => e.textContent.trim().startsWith('{') && e.textContent.includes('"dsh_tool_calls"'));
    const codeText = jsonCode?.textContent.trim();
    const plain = copy.textContent.trim().replace(/\s+/g, '');
    const onlyCode = codeText && [codeText, `JSON${codeText}`, `json${codeText}`].some(s => s.replace(/\s+/g, '') === plain);
    // Collapse separator whitespace outside code fences only.
    const rendered = onlyCode ? codeText : markdown(copy).trim();
    let inCode = false, marker = '', blank = 0;
    const text = rendered.split('\n').filter(line => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence && (!inCode || fence[1] === marker)) { inCode = !inCode; marker = fence[1]; }
      if (inCode) return true;
      blank = line.trim() ? 0 : blank + 1;
      return blank <= 1;
    }).join('\n');
    return { text, citations, identity, complete, busy: element.getAttribute('aria-busy') === 'true' };
  });
}
