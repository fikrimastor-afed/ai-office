// Tiny helpers for the office's Markdown files: a "---" header of "key: value"
// lines, and "## Heading" sections. Edits change only the lines they touch.

const NL = /\r?\n/;

// "value   # comment" -> "value" (a # only starts a comment after a space and before a space)
const clean = (v) => v.replace(/\s+#\s.*$/, '').trim();

function parse(text) {
  const lines = text.split(NL);
  const fields = {};
  if (lines[0] !== '---') return { fields, body: text };
  let i = 1;
  for (; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(lines[i]);
    if (m) fields[m[1]] = clean(m[2]);
  }
  return { fields, body: lines.slice(i + 1).join('\n').replace(/^\n+/, '') };
}

// Set header fields, keeping every other line (and its comments) as it was.
function setFields(text, fields) {
  let lines = text.split(NL);
  if (lines[0] !== '---') lines = ['---', '---', ...lines];
  let end = lines.indexOf('---', 1);
  for (const [k, v] of Object.entries(fields)) {
    const line = `${k}: ${v == null ? '' : String(v).replace(NL, ' ')}`.trimEnd();
    const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${k}:`).test(l));
    if (at > 0) lines[at] = line; else { lines.splice(end, 0, line); end++; }
  }
  return lines.join('\n');
}

function make(fields, body) {
  const head = Object.entries(fields).map(([k, v]) => `${k}: ${v == null ? '' : String(v).replace(NL, ' ')}`.trimEnd());
  return ['---', ...head, '---', String(body || '').trim(), ''].join('\n');
}

// A "## Heading" line: as in Markdown, at most three spaces before it (four or more is a code block).
const isHeading = (l, heading) => /^ {0,3}\S/.test(l) && l.trim().toLowerCase() === `## ${heading}`.toLowerCase();

// "## Heading" section content (without the heading line), or null.
function section(text, heading) {
  const lines = text.split(NL);
  const start = lines.findIndex((l) => isHeading(l, heading));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function setSection(text, heading, content) {
  const lines = text.split(NL);
  const start = lines.findIndex((l) => isHeading(l, heading));
  const block = ['', String(content).trim(), ''];
  if (start < 0) return `${text.replace(/\s+$/, '')}\n\n## ${heading}\n${block.join('\n')}`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

// "- item" lines of a section
const bullets = (s) => (s || '').split(NL).map((l) => /^\s*[-*]\s+(.*)$/.exec(l)).filter(Boolean).map((m) => m[1].trim());

module.exports = { parse, setFields, make, section, setSection, bullets };
