import { readFileSync, writeFileSync } from 'fs';

// The klugh loader discards `#` comments, so we maintain our own raw-file model
// to (a) associate a block's leading comment lines with it for display, and
// (b) locate the exact line span of a block for in-place edit/delete without
// touching any other block's formatting.
//
// A block spans its leading comment lines (contiguous `#` lines immediately
// above the header, with no blank gap) through the last body line (the last
// non-blank line before the next block's header). Blank lines between blocks
// are separators owned by no block.
//
// Shared by ruleFile.js (`rule "name"` headers) and actionFile.js
// (`action "name"` headers) — parameterized by `keyword` so both file kinds
// reuse the same scan/render/append/replace/delete logic.

const COMMENT_RE = /^\s*#/;
const BLANK_RE = /^\s*$/;

function headerRe(keyword) {
  return new RegExp(`^\\s*${keyword}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
}

// Parse raw file text into an ordered array of blocks. Each block:
//   { name, comment, bodyText, blockText, commentStart, headerLine, endLine }
// Line numbers are 0-based indices into the file's line array (endLine inclusive).
export function parseBlocks(text, keyword) {
  const headerRE = headerRe(keyword);
  const lines = text.split('\n');
  const headerLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (headerRE.test(lines[i])) headerLines.push(i);
  }

  const blocks = [];
  for (let h = 0; h < headerLines.length; h++) {
    const headerLine = headerLines[h];
    const name = lines[headerLine].match(headerRE)[1];

    // Leading comment lines: walk up while lines are comments with no blank gap.
    let commentStart = headerLine;
    while (commentStart - 1 >= 0 && COMMENT_RE.test(lines[commentStart - 1])) {
      commentStart--;
    }
    const commentLines = lines.slice(commentStart, headerLine);
    const comment = commentLines.map(l => l.replace(/^\s*#\s?/, '')).join('\n');

    // Body runs from just after the header to the last non-blank line before the
    // next block's block begins (its comment start, or its header if uncommented).
    const nextHeader = headerLines[h + 1];
    let scanEnd = nextHeader === undefined ? lines.length : nextHeader;
    // Exclude the next block's leading comment lines from this block.
    if (nextHeader !== undefined) {
      let c = nextHeader;
      while (c - 1 > headerLine && COMMENT_RE.test(lines[c - 1])) c--;
      scanEnd = c;
    }
    // The body ends at the last non-blank, non-comment line. Trailing comments
    // (e.g. the next section's header, separated by blank lines) belong to no
    // block and must not be absorbed here — only comments directly above a
    // block are associated with it (see commentStart above).
    let endLine = headerLine;
    for (let i = headerLine + 1; i < scanEnd; i++) {
      if (!BLANK_RE.test(lines[i]) && !COMMENT_RE.test(lines[i])) endLine = i;
    }

    const bodyText = lines.slice(headerLine + 1, endLine + 1).join('\n');
    const blockText = lines.slice(commentStart, endLine + 1).join('\n');
    blocks.push({ name, comment, bodyText, blockText, commentStart, headerLine, endLine });
  }
  return blocks;
}

// Render a block from parts. `body` is the DSL under the header; `comment`
// (optional) becomes `#` lines above the header.
export function renderBlock({ keyword, name, comment, body }) {
  const lines = [];
  if (comment && comment.trim()) {
    for (const line of comment.replace(/\s+$/, '').split('\n')) {
      lines.push(line.trim() ? `  # ${line}` : '  #');
    }
  }
  lines.push(`  ${keyword} "${name}"`);
  // Indent body lines to four spaces if the author didn't already indent.
  // If they provided their own indentation (starts with space), we shift it right by 2 spaces.
  for (const raw of body.replace(/\s+$/, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') { lines.push(''); continue; }
    lines.push(/^\s/.test(line) ? `  ${line}` : `    ${line}`);
  }
  return lines.join('\n');
}

export function readFile(path) {
  return readFileSync(path, 'utf-8');
}

// Append a new block to a file, separated from existing content by a blank line.
export function appendBlock(path, keyword, { name, comment, body }) {
  const existing = readFileSync(path, 'utf-8');
  const block = renderBlock({ keyword, name, comment, body });
  const trimmed = existing.replace(/\s+$/, '');
  const next = trimmed.length ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  writeFileSync(path, next, 'utf-8');
  return block;
}

// Replace the block named `targetName` in-place with a re-rendered block. Only
// the matched block's lines change; everything else is byte-preserved.
export function replaceBlock(path, keyword, targetName, { name, comment, body }) {
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n');
  const block = findBlock(text, keyword, targetName);
  const rendered = renderBlock({ keyword, name, comment, body });
  const before = lines.slice(0, block.commentStart);
  const after = lines.slice(block.endLine + 1);
  const next = [...before, ...rendered.split('\n'), ...after].join('\n');
  writeFileSync(path, next, 'utf-8');
  return rendered;
}

// Delete the block named `targetName`, including its leading comments and one
// trailing blank separator line if present.
export function deleteBlock(path, keyword, targetName) {
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n');
  const block = findBlock(text, keyword, targetName);
  let end = block.endLine;
  if (end + 1 < lines.length && BLANK_RE.test(lines[end + 1])) end++;
  const next = [...lines.slice(0, block.commentStart), ...lines.slice(end + 1)].join('\n');
  writeFileSync(path, next, 'utf-8');
}

function findBlock(text, keyword, targetName) {
  const blocks = parseBlocks(text, keyword);
  const matches = blocks.filter(b => b.name === targetName);
  if (matches.length === 0) throw new Error(`No ${keyword} named "${targetName}" found in file`);
  if (matches.length > 1) throw new Error(`Multiple ${keyword}s named "${targetName}" in file — cannot edit unambiguously`);
  return matches[0];
}
