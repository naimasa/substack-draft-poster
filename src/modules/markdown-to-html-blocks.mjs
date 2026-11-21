/**
 * markdown-to-html-blocks.mjs
 * Deterministically converts a practical Markdown subset (## / ### headings, bold / italic / inline
 * code, bullet and numbered lists, quotes and sub-lists nested in lists, tables, horizontal rules and
 * fenced code blocks) into block-level HTML. It is not a full CommonMark implementation.
 *
 * Callers receive blocks as { type, html, ... }. A "table" block carries the rendered <table> in `html`
 * and also keeps `headerCells` / `separatorCells` / `bodyRowsCells`. Substack loses the row/column
 * structure of pasted tables (observed in September 2026), so callers rebuild tables as nested lists
 * with `renderTableAsNestedList`.
 */

import { parseTableRow, isTableRow, isTableSeparatorRow, parseAlignment } from "./markdown-table.mjs";

// ---- Inline decoration ----

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineToHtml(text) {
  let t = escapeHtml(text);
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");
  return t;
}

// ---- Tables ----

function renderTable(headerCells, separatorCells, bodyRowsCells) {
  const alignAttr = (idx) => {
    const align = parseAlignment(separatorCells[idx] || "");
    return align === "l" ? "" : ` style="text-align:${align === "c" ? "center" : "right"}"`;
  };
  const headHtml = headerCells
    .map((c, idx) => `<th${alignAttr(idx)}>${inlineToHtml(c)}</th>`)
    .join("");
  const bodyHtml = bodyRowsCells
    .map((row) => `<tr>${row.map((c, idx) => `<td${alignAttr(idx)}>${inlineToHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

/**
 * Render a table as a nested list instead of a real HTML <table>.
 * Pasting a <table> tag into Substack was observed to break the row/column structure
 * (September 2026), so this is a fallback to a list form that was already verified to work.
 * Each row becomes one item, with the first column in bold as its heading and the
 * remaining columns as a sub-list of "column heading: cell value".
 */
export function renderTableAsNestedList(headerCells, separatorCells, bodyRowsCells) {
  const rowsHtml = bodyRowsCells
    .map((row) => {
      const first = inlineToHtml(row[0] || "");
      const restItems = row
        .slice(1)
        .map((cell, idx) => `<li>${inlineToHtml(headerCells[idx + 1] || "")}: ${inlineToHtml(cell)}</li>`)
        .join("");
      return `<li>${first}<ul>${restItems}</ul></li>`;
    })
    .join("");
  return `<ul>${rowsHtml}</ul>`;
}

// ---- Lists (nested quotes and sub-lists are supported) ----

function getIndent(line) {
  return line.length - line.trimStart().length;
}

/** Convert a ul or ol list block to HTML. Returns [html, index of the next line] */
function renderList(lines, start, tag, baseIndent) {
  const items = [];
  let i = start;
  const itemRe = tag === "ul" ? /^-\s+(.*)$/ : /^\d+\.\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || getIndent(line) !== baseIndent) break;
    const m = line.trim().match(itemRe);
    if (!m) break;

    let itemHtml = inlineToHtml(m[1]);
    i++;

    // Take the quote or sub-list that follows with deeper indentation as nested tags
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === "") break;
      const nextIndent = getIndent(next);
      if (nextIndent <= baseIndent) break;

      if (/^\s*>\s?/.test(next)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i]) && getIndent(lines[i]) > baseIndent) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, "").trim());
          i++;
        }
        itemHtml += `<blockquote><p>${quoteLines.map(inlineToHtml).join("<br>")}</p></blockquote>`;
        continue;
      }
      if (/^\s*-\s+/.test(next)) {
        const [subHtml, nextIdx] = renderList(lines, i, "ul", nextIndent);
        itemHtml += subHtml;
        i = nextIdx;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(next)) {
        const [subHtml, nextIdx] = renderList(lines, i, "ol", nextIndent);
        itemHtml += subHtml;
        i = nextIdx;
        continue;
      }
      break;
    }

    items.push(`<li>${itemHtml}</li>`);
  }

  return [`<${tag}>${items.join("")}</${tag}>`, i];
}

// ---- Block-level Markdown to HTML conversion ----

/**
 * Convert a Markdown string to an array of blocks.
 * Each element is { type, html, ordered? }, where type is
 * "hr" | "table" | "heading2" | "heading3" | "list" | "quote" | "paragraph"。
 */
export function markdownToBlocks(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (/^-{3,}\s*$/.test(line.trim())) {
      blocks.push({ type: "hr", html: "<hr>" });
      i++;
      continue;
    }

    const fenceOpen = line.match(/^```(\w*)\s*$/);
    if (fenceOpen) {
      const codeLines = [];
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j])) {
        codeLines.push(lines[j]);
        j++;
      }
      blocks.push({ type: "code", html: `<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>` });
      i = j + 1; // also skip the closing ``` line
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      const headerCells = parseTableRow(line);
      const separatorCells = parseTableRow(lines[i + 1]);
      let j = i + 2;
      const bodyRowsCells = [];
      while (j < lines.length && isTableRow(lines[j])) {
        bodyRowsCells.push(parseTableRow(lines[j]));
        j++;
      }
      blocks.push({
        type: "table",
        html: renderTable(headerCells, separatorCells, bodyRowsCells),
        headerCells,
        separatorCells,
        bodyRowsCells,
      });
      i = j;
      continue;
    }

    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      blocks.push({ type: "heading2", html: `<h2>${inlineToHtml(h2[1])}</h2>` });
      i++;
      continue;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      blocks.push({ type: "heading3", html: `<h3>${inlineToHtml(h3[1])}</h3>` });
      i++;
      continue;
    }

    if (/^-\s+/.test(line)) {
      const [html, next] = renderList(lines, i, "ul", getIndent(line));
      blocks.push({ type: "list", ordered: false, html });
      i = next;
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const [html, next] = renderList(lines, i, "ol", getIndent(line));
      blocks.push({ type: "list", ordered: true, html });
      i = next;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        quoteLines.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      blocks.push({
        type: "quote",
        html: `<blockquote><p>${quoteLines.map(inlineToHtml).join("<br>")}</p></blockquote>`,
      });
      i = j;
      continue;
    }

    // Paragraph: gather consecutive lines that match none of the above into one paragraph
    const paraLines = [];
    let j = i;
    while (
      j < lines.length &&
      lines[j].trim() !== "" &&
      !/^-{3,}\s*$/.test(lines[j].trim()) &&
      !isTableRow(lines[j]) &&
      !/^##\s+/.test(lines[j]) &&
      !/^###\s+/.test(lines[j]) &&
      !/^-\s+/.test(lines[j]) &&
      !/^\d+\.\s+/.test(lines[j]) &&
      !/^>\s?/.test(lines[j]) &&
      !/^```\w*\s*$/.test(lines[j])
    ) {
      paraLines.push(lines[j]);
      j++;
    }
    blocks.push({ type: "paragraph", html: `<p>${paraLines.map(inlineToHtml).join("<br>")}</p>` });
    i = j;
  }

  return blocks;
}
