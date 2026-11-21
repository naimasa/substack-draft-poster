/**
 * markdown-table.mjs
 * Detection and parsing of Markdown (pipe-delimited) tables.
 */

export function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

export function isTableRow(line) {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

export function isTableSeparatorRow(line) {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** Derive the alignment (l/c/r) from a Markdown delimiter cell (:---, ---:, :---: and so on) */
export function parseAlignment(sepCell) {
  const left = sepCell.startsWith(":");
  const right = sepCell.endsWith(":");
  if (left && right) return "c";
  if (right) return "r";
  return "l";
}
