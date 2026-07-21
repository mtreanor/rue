import { parseBlocks, renderBlock, readFile, appendBlock, replaceBlock, deleteBlock } from './blockFile.js';

// Action-file operations: thin bindings of the generic block scanner/renderer
// (blockFile.js) to the `action "name"` header keyword. See blockFile.js for
// the block model (comment/body/blockText line spans).

export function parseActionBlocks(text) {
  return parseBlocks(text, 'action');
}

export function renderActionBlock({ name, comment, body }) {
  return renderBlock({ keyword: 'action', name, comment, body });
}

export { readFile };

export function appendAction(path, { name, comment, body }) {
  return appendBlock(path, 'action', { name, comment, body });
}

export function replaceAction(path, targetName, { name, comment, body }) {
  return replaceBlock(path, 'action', targetName, { name, comment, body });
}

export function deleteAction(path, targetName) {
  return deleteBlock(path, 'action', targetName);
}

// The action grammar reads sections in this fixed order; each is optional, but
// when present they must appear in this sequence (ActionParser.parseAction).
const SECTION_ORDER = ['roles', 'info', 'preconditions', 'utility', 'content', 'effects'];
const SECTION_START_RE = {
  roles:          /^\s*roles\s*:/,
  info:           /^\s*info\s*:/,
  preconditions:  /^\s*preconditions\s*$/,
  utility:        /^\s*utility\s*$/,
  content:        /^\s*content\s*$/,
  effects:        /^\s*effects\s*$/,
};

// Split an action block's raw body text into its DSL sections, so the
// structured action editor can prefill separate fields (preconditions,
// utility, content, effects) from an existing action's exact source text on
// Edit — mirroring how the rule editor prefills its one body field from the
// rule's raw bodyText. `roles` is deliberately not split out here: the editor
// gets it from the parsed AST instead (structured rows), which is more
// reliable than re-parsing free text.
export function splitActionSections(bodyText) {
  const lines = bodyText.split('\n');
  const starts = {};
  let cursor = 0;
  for (const kw of SECTION_ORDER) {
    let found = -1;
    for (let i = cursor; i < lines.length; i++) {
      if (SECTION_START_RE[kw].test(lines[i])) { found = i; break; }
    }
    starts[kw] = found;
    if (found !== -1) cursor = found + 1;
  }

  const present = SECTION_ORDER.filter(kw => starts[kw] !== -1);
  const raw = {};
  for (let i = 0; i < present.length; i++) {
    const kw = present[i];
    const end = present[i + 1] !== undefined ? starts[present[i + 1]] : lines.length;
    raw[kw] = lines.slice(starts[kw], end).join('\n');
  }

  // Bare-keyword sections (preconditions/utility/content/effects): drop the
  // header line, then strip each remaining line's leading indentation — the
  // editor's textarea is flat DSL, not a nested block, and buildActionBody
  // re-indents correctly on save regardless of what's typed back in.
  const dedent = (text) => text.split('\n').map(l => l.replace(/^\s+/, '')).join('\n').trim();
  const body = (kw) => raw[kw] !== undefined ? dedent(raw[kw].split('\n').slice(1).join('\n')) : '';

  const contentTemplate = (() => {
    if (raw.content === undefined) return '';
    const m = raw.content.match(/text\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  })();

  // `info:` carries its first fact inline after the colon; strip that prefix
  // before dedenting the rest of the section like the other raw-text fields.
  const infoText = (() => {
    if (raw.info === undefined) return '';
    const lines = raw.info.split('\n');
    lines[0] = lines[0].replace(/^\s*info\s*:\s?/, '');
    return dedent(lines.join('\n'));
  })();

  return {
    infoText,
    preconditionsText: body('preconditions'),
    utilityText:       body('utility'),
    contentTemplate,
    effectsText:       body('effects'),
  };
}

function indentLines(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.replace(/\s+$/, '').split('\n').map(l => (l.trim() ? pad + l.trim() : ''));
}

function normalizeVariable(v) {
  const t = v.trim();
  return t.startsWith('?') ? t : `?${t}`;
}

// Assemble the structured action editor's fields (roles rows, per-section DSL
// text, and a plain content template string) into the single DSL body string
// the grammar expects — in the fixed section order ActionParser.parseAction
// reads (roles, info, preconditions, utility, content, effects). Header lines
// (roles:/info:/etc.) are left unindented here; renderBlock's per-line pass
// base-indents them to 4 spaces. Nested section bodies are pre-indented an
// extra 2 here so they land at 6 once renderBlock adds its base — one level
// deeper than their header, matching hand-authored actionset files. The DSL
// itself is whitespace-insensitive, so this is purely cosmetic, but renderBlock
// now preserves whatever relative nesting is passed in rather than flattening
// it (see blockFile.js), so the exact indent chosen here is what ends up on disk.
export function buildActionBody({
  roles = [], info = '', preconditions = '', utility = '', content = '', effects = '',
}) {
  const lines = [];

  const rolesText = roles
    .filter(r => r.variable?.trim() && r.type?.trim())
    .map(r => `${normalizeVariable(r.variable)}: ${r.type.trim()}`)
    .join(', ');
  if (rolesText) lines.push(`roles: ${rolesText}`);

  if (info.trim()) {
    lines.push('info:');
    lines.push(...indentLines(info, 2));
  }
  if (preconditions.trim()) {
    lines.push('preconditions');
    lines.push(...indentLines(preconditions, 2));
  }
  if (utility.trim()) {
    lines.push('utility');
    lines.push(...indentLines(utility, 2));
  }
  if (content.trim()) {
    lines.push('content');
    lines.push(...indentLines(`text: ${JSON.stringify(content.trim())}`, 2));
  }
  if (effects.trim()) {
    lines.push('effects');
    lines.push(...indentLines(effects, 2));
  }

  return lines.join('\n');
}
