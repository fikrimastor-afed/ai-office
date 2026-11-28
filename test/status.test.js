// Status engine tests: event sequences as the hooks really write them (see docs/milestone-1-findings.md).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Status, STALE } = require('../lib/status');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-status-'));
fs.mkdirSync(path.join(dir, '.office'));
const log = path.join(dir, '.office', 'events.jsonl');
const t0 = Date.parse('2026-11-24T10:00:00Z');
let clock = t0;
const ev = (o) => fs.appendFileSync(log, JSON.stringify({ at: new Date(clock += 1000).toISOString(), cwd: dir, ...o }) + '\n');
const people = [{ id: 'pa' }, { id: 'siti' }, { id: 'nurul' }, { id: 'aina' }];
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const s = new Status(dir);
const snap = (pending) => { s.readNew(); return s.snapshot(people, new Set(pending || []), clock); };

test('nobody working at the start', () => {
  ev({ ev: 'SessionStart', sid: 'A' });
  const x = snap();
  assert.strictEqual(x.people.pa.status, 'sleeping'); assert.strictEqual(x.people.siti.status, 'sleeping');
});

test('PA busy on a request', () => {
  ev({ ev: 'UserPromptSubmit', sid: 'A', msg: 'Quote for Kedai Ali' });
  assert.deepStrictEqual(snap().people.pa, { status: 'working', task: 'Working on your request', last: new Date(clock).toISOString() });
});

test('background staff task (WSL order): handed, started, named, working', () => {
  ev({ ev: 'PreToolUse', sid: 'A', tool: 'Agent', staff: 'siti', task: 'Quote 50 t-shirts' });
  ev({ ev: 'SubagentStart', sid: 'A', aid: 'a1', staff: 'siti' });
  ev({ ev: 'PostToolUse', sid: 'A', aid: 'a1', staff: 'siti', tool: 'Agent', task: 'Quote 50 t-shirts' });
  ev({ ev: 'Stop', sid: 'A', msg: 'Siti is on it' });
  const x = snap();
  assert.strictEqual(x.people.siti.status, 'working'); assert.strictEqual(x.people.siti.task, 'Quote 50 t-shirts');
  assert.strictEqual(x.people.pa.status, 'working'); assert.match(x.people.pa.task, /Following up 1 task/);
});

test('two staff at once, then one finishes', () => {
  ev({ ev: 'UserPromptSubmit', sid: 'A' });
  ev({ ev: 'PreToolUse', sid: 'A', tool: 'Agent', staff: 'nurul', task: 'Invoice draft' });
  ev({ ev: 'SubagentStart', sid: 'A', aid: 'a2', staff: 'nurul' });
  ev({ ev: 'PreToolUse', sid: 'A', aid: 'a2', staff: 'nurul', tool: 'Write', file: '/x/invoice.md' });
  let x = snap();
  assert.strictEqual(x.people.nurul.task, 'Invoice draft'); assert.match(x.people.pa.task, /2 tasks/);
  ev({ ev: 'SubagentStop', sid: 'A', aid: 'a1', staff: 'siti' });
  x = snap();
  assert.strictEqual(x.people.siti.status, 'sleeping'); assert.strictEqual(x.people.nurul.status, 'working');
  assert.ok(s.feed.some((f) => f.who === 'siti' && f.text === 'finished: Quote 50 t-shirts'));
});

test('foreground staff task (Windows order) gets its task text too', () => {
  ev({ ev: 'PreToolUse', sid: 'B', tool: 'Agent', staff: 'aina', task: 'Reply to Ali' });
  ev({ ev: 'SubagentStart', sid: 'B', aid: 'a3', staff: 'aina' });
  assert.strictEqual(snap().people.aina.task, 'Reply to Ali');
  ev({ ev: 'SubagentStop', sid: 'B', aid: 'a3', staff: 'aina' });
  ev({ ev: 'PostToolUse', sid: 'B', aid: 'a3', staff: 'aina', tool: 'Agent', task: 'Reply to Ali' });
  assert.strictEqual(snap().people.aina.status, 'sleeping');
});

test('pending approval makes an idle staff wait; working wins', () => {
  assert.strictEqual(snap(['siti']).people.siti.status, 'waiting');
  assert.strictEqual(snap(['nurul']).people.nurul.status, 'working');
});

test('direct chat in a staff folder, and the terminal permission banner', () => {
  const sitiDir = path.join(dir, 'staff', 'siti');
  ev({ ev: 'SessionStart', sid: 'C', cwd: sitiDir });
  ev({ ev: 'UserPromptSubmit', sid: 'C', cwd: sitiDir });
  let x = snap();
  assert.deepStrictEqual([x.people.siti.status, x.people.siti.task], ['working', 'Talking with you']);
  ev({ ev: 'Notification', sid: 'C', cwd: sitiDir, msg: 'Claude needs your permission to use Bash' });
  x = snap();
  assert.deepStrictEqual(x.banner, { who: 'siti', msg: 'Claude needs your permission to use Bash' });
  ev({ ev: 'PreToolUse', sid: 'C', cwd: sitiDir, tool: 'Bash' });
  assert.strictEqual(snap().banner, null);
  ev({ ev: 'Stop', sid: 'C', cwd: sitiDir });
  assert.strictEqual(snap().people.siti.status, 'sleeping');
});

test('agent team hook events are ignored', () => {
  const before = JSON.stringify(snap().people);
  for (const e of ['TeammateIdle', 'TaskCreated', 'TaskCompleted']) ev({ ev: e, sid: 'T', cwd: dir });
  const x = snap();
  assert.deepStrictEqual(Object.fromEntries(Object.entries(x.people).map(([k, v]) => [k, v.status])), Object.fromEntries(Object.entries(JSON.parse(before)).map(([k, v]) => [k, v.status])));
  assert.strictEqual(x.banner, null);
});

test('work nobody heard from in a while ages out', () => {
  clock += STALE + 1000;
  const x = s.snapshot(people, new Set(), clock);
  assert.strictEqual(x.people.nurul.status, 'sleeping'); assert.strictEqual(x.people.pa.status, 'sleeping');
});

test('a half-written last line waits; a new log starts over', () => {
  fs.appendFileSync(log, '{"at":"2026-11-24T12:00:00Z","ev":"UserPromptSubmit","sid":"D"');
  s.readNew();
  fs.appendFileSync(log, ',"cwd":' + JSON.stringify(dir) + '}\n');
  s.readNew();
  assert.ok(s.sessions.get('D').busy);
  fs.writeFileSync(log, '');
  s.readNew();
  ev({ ev: 'SessionStart', sid: 'E' });
  s.readNew();
  assert.ok(s.sessions.has('E'));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} status tests passed`);
