import { markdownToBlocks, renderTableAsNestedList } from './markdown-to-html-blocks.mjs';

export const ALLOWED_TAGS = Object.freeze(['h2', 'h3', 'p', 'strong', 'em', 'code', 'a', 'br', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr']);
const fragment = (html) => String(html ?? '').match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? String(html ?? '');
const decode = (text) => text.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
  const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n.toLowerCase()]);

export function sanitizeHtml(html) {
  return fragment(html).replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|iframe|object|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-z][\w:-]*)\b[^>]*>/gi, (tag, raw) => {
      const name = raw.toLowerCase();
      if (!ALLOWED_TAGS.includes(name)) return '';
      if (tag.startsWith('</')) return ['br', 'hr'].includes(name) ? '' : `</${name}>`;
      if (name !== 'a') return `<${name}>`;
      const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const value = decode(href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
      if (!/^(https?:\/\/|mailto:|\/|#)/i.test(value) || value.startsWith('//')) return '<a>';
      return `<a href="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`;
    });
}

export function extractTitleAndBody(html) {
  const body = fragment(html);
  const heading = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  return { title: heading ? decode(heading[1].replace(/<[^>]*>/g, '')).trim() : null,
    bodyHtml: body.replace(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/gi, '') };
}

export function markdownToSubstackHtml(markdown) {
  return sanitizeHtml(markdownToBlocks(markdown).map((block) => block.type === 'table'
    ? renderTableAsNestedList(block.headerCells, block.separatorCells, block.bodyRowsCells) : block.html).join(''));
}

export function buildInjectionPlan({ freePreviewHtml, paidBodyHtml, titleEn, excerptEn }) {
  const extracted = extractTitleAndBody(freePreviewHtml);
  const paidHtml = paidBodyHtml ? sanitizeHtml(paidBodyHtml) : null;
  return { title: titleEn || extracted.title, subtitle: excerptEn || '', freeHtml: sanitizeHtml(extracted.bodyHtml),
    paidHtml: paidHtml?.trim() ? paidHtml : null, paywall: Boolean(paidHtml?.trim()) };
}
