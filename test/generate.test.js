// Plain Node tests for the office generator. Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../lib/generate');
const D = require('../lib/defaults');
const T = require('../lib/templates');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const answers = {
  company: 'Kedai Ali', pa: 'Hana', invois: true,
  staff: [D.STAFF[0], { name: 'Mei Ling', role: 'Finance', job: 'Invoices' }, { name: 'Plan', role: 'Sales', job: 'Quotes' }, { name: 'Mei Ling', role: 'Ops', job: 'Stock' }]
    .map(({ name, role, job }) => ({ name, role, job })),
};
const cfg = G.buildConfig(answers);
// Stable configs for later tests: fixed port, key and created.
const fix = (c) => Object.assign(c, { port: 4747, key: '0123456789abcdef0123456789abcdef', created: '2026-11-28T00:00:00.000Z' });
const businessCfg = fix(G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 2) }));
const softwareCfg = fix(G.buildConfig({ company: 'Acme Labs', pa: 'Hana', type: 'software', staff: D.teamOf('software').slice(0, D.SOFTWARE_STAFF_COUNT) }));
const dir = path.join(tmp, 'office');

test('staff ids are unique, safe and avoid built-in agent names', () => {
  assert.deepStrictEqual(cfg.staff.map((s) => s.id), ['aina', 'mei-ling', 'plan-staff', 'mei-ling-2']);
});

test('invois tools allowed in dashboard runs: role tools, not the ask-first ones', () => {
  const T = require('../lib/templates');
  const sales = T.addonAllowed(cfg, 'plan-staff');
  assert.ok(sales.includes('mcp__invois-online__get_companies'));
  assert.ok(sales.includes('mcp__invois-online__create_quotation'));
  assert.ok(sales.includes('mcp__invois-online__authenticate'));
  assert.ok(sales.includes('mcp__claude_ai_Invois_Online__get_quotations'), 'claude.ai connector names too');
  assert.ok(!sales.includes('mcp__claude_ai_Invois_Online__send_quotation_email'));
  assert.ok(!sales.includes('mcp__invois-online__send_quotation_email'));
  const fin = T.addonAllowed(cfg, 'mei-ling');
  assert.ok(fin.includes('mcp__invois-online__create_invoice'));
  assert.ok(!fin.includes('mcp__invois-online__send_invoice_email') && !fin.includes('mcp__invois-online__create_payment'));
  const pa = T.addonAllowed(cfg, 'pa');
  assert.ok(pa.includes('mcp__invois-online__get_quotations'));
  assert.ok(!pa.some((t) => /create_|send_|update_|convert_/.test(t)));
  assert.deepStrictEqual(T.addonAllowed(cfg, 'aina'), []);
});

test('invois add-on goes to sales and finance staff only', () => {
  assert.deepStrictEqual(cfg.addons['invois-online'].staff, ['mei-ling', 'plan-staff']);
});

test('writes the office files', () => {
  G.writeOffice(dir, cfg);
  for (const f of ['office.json', 'CLAUDE.md', 'OFFICE.md', '.claude/settings.json', '.office/hook.js',
    'staff/aina/CLAUDE.md', 'staff/aina/.claude/settings.json', '.claude/agents/mei-ling.md',
    '.claude/skills/add-staff-tool/SKILL.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  for (const d of ['inbox', 'approvals', 'projects']) assert.ok(fs.statSync(path.join(dir, d)).isDirectory());
  assert.ok(G.isOffice(dir));
  assert.match(read(dir, '.claude/agents/plan-staff.md'), /mcp__invois-online__create_quotation/);
  assert.doesNotMatch(read(dir, '.claude/agents/aina.md'), /invois/);
});

test('task board fields are documented for the manager, not for staff', () => {
  const office = read(dir, 'OFFICE.md');
  for (const s of ['needs:', 'role:', 'continues:', 'maxParallel']) assert.ok(office.includes(s), s);
  const pa = read(dir, 'CLAUDE.md');
  assert.ok(pa.includes('needs:') && pa.includes('continues:'));
  assert.ok(!read(dir, 'staff/aina/CLAUDE.md').includes('continues:'));
});

test('no em or en dashes in generated text', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /[–—]/, f);
});

test('never overwrites existing files', () => {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine');
  const res = G.writeOffice(dir, cfg);
  assert.strictEqual(read(dir, 'CLAUDE.md'), 'mine');
  assert.ok(res.skipped.includes('CLAUDE.md'));
});

test('repairSettings fixes moved paths and keeps the user\'s own hooks and rules', () => {
  const moved = path.join(tmp, 'moved');
  fs.renameSync(dir, moved);
  const f = path.join(moved, '.claude/settings.json');
  const s = JSON.parse(read(f));
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo mine' }] });
  s.model = 'sonnet';
  s.permissions.allow.push('Bash(git status)');
  fs.writeFileSync(f, JSON.stringify(s));
  const fixed = G.repairSettings(moved);
  assert.ok(fixed.includes('.claude/settings.json'));
  const after = JSON.parse(read(f));
  assert.strictEqual(after.model, 'sonnet');
  assert.deepStrictEqual(after.permissions.allow, ['Bash(git status)', ...T.officeRules(moved)]);
  assert.ok(after.hooks.Stop.some((e) => e.hooks[0].command === 'echo mine'));
  const ours = after.hooks.Stop.filter((e) => e.hooks[0].command.includes('hook.js'));
  assert.strictEqual(ours.length, 1);
  assert.ok(ours[0].hooks[0].command.includes(path.join(moved, '.office', 'hook.js')));
  assert.deepStrictEqual(G.repairSettings(moved), [], 'second repair changes nothing');
});

test('file rules use Claude Code path form on each OS', () => {
  assert.deepStrictEqual(T.officeRules('/home/a/my office', 'linux'), ['Read(//home/a/my office/**)', 'Edit(//home/a/my office/**)']);
  assert.deepStrictEqual(T.officeRules('C:\\Users\\Ali\\kedai\\', 'win32'), ['Read(//c/Users/Ali/kedai/**)', 'Edit(//c/Users/Ali/kedai/**)']);
  const st = JSON.parse(read(path.join(tmp, 'moved'), 'staff/aina/.claude/settings.json'));
  assert.deepStrictEqual(st.permissions.allow, T.officeRules(path.join(tmp, 'moved')), 'staff folders allow the whole office');
});

test('answers file: defaults fill gaps, errors are plain', () => {
  const bin = path.join(__dirname, '..', 'bin', 'ai-office.js');
  const run = (ans) => { const f = path.join(tmp, 'ans.json'); fs.writeFileSync(f, JSON.stringify(ans));
    return spawnSync(process.execPath, [bin, '--answers', f, '--skip-check'], { cwd: tmp, encoding: 'utf8' }); };
  let r = run({ company: 'Kedai Ali', staff: [{ name: 'Siti' }, { name: 'Zul', role: 'Driver', job: 'Deliveries' }] });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(read(tmp, 'kedai-ali/office.json'));
  assert.deepStrictEqual(o.staff.map((x) => [x.id, x.role]), [['siti', 'Sales'], ['zul', 'Driver']]);
  assert.strictEqual(o.pa.name, 'Hana');
  r = run({ company: 'Kedai Ali' });
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /already has an office/);
  r = run({ folder: './x', staff: [{ name: 'Bob' }] });
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /needs a role/);
});

test('launcher: written once, refreshed only when it is ours', () => {
  const moved = path.join(tmp, 'moved');
  const name = T.launcher(process.execPath).name;
  const f = path.join(moved, name);
  assert.ok(fs.existsSync(f), 'setup wrote it');
  fs.rmSync(f);
  assert.strictEqual(G.writeLauncher(moved), name, 'first write');
  assert.match(read(f), /AI Office launcher/); assert.match(read(f), /github:epool86\/ai-office/);
  assert.strictEqual(G.writeLauncher(moved), null, 'unchanged');
  fs.writeFileSync(f, 'my own script');
  assert.strictEqual(G.writeLauncher(moved), null, 'user file kept');
  assert.strictEqual(read(f), 'my own script');
  const win = T.launcher('C:\\Users\\Ali\\.ai-office\\node\\node.exe', 'win32');
  assert.strictEqual(win.name, 'Start AI Office.cmd'); assert.match(win.text, /\r\ncd \/d "%~dp0"\r\n/); assert.match(win.text, /set "PATH=C:\\Users\\Ali\\.ai-office\\node;%PATH%"/);
});

test('hook.js appends one trimmed line per event', () => {
  const moved = path.join(tmp, 'moved');
  const input = { hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'a1', agent_type: 'siti', tool_name: 'Agent',
    tool_input: { description: 'Quote', subagent_type: 'siti', prompt: 'x'.repeat(5000) }, cwd: moved };
  const r = spawnSync(process.execPath, [path.join(moved, '.office/hook.js')], { input: JSON.stringify(input) });
  assert.strictEqual(r.status, 0);
  const line = JSON.parse(read(moved, '.office/events.jsonl').trim().split('\n').pop());
  assert.strictEqual(line.ev, 'PreToolUse');
  assert.strictEqual(line.staff, 'siti');
  assert.strictEqual(line.task, 'Quote');
  assert.ok(!('prompt' in line));
});

test('a stuck task: again: is documented; the example header keeps staff, role and continues apart', () => {
  const c = G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: [D.STAFF[0], D.STAFF[1]] });
  const office = T.officeMd(c), pa = T.paClaude(c);
  assert.ok(office.includes('| `again:` | Written when a stopped or failed task is run again. A new task with `again: <old id>` stands in for the old one, so tasks that need the old one go on |'));
  assert.ok(pa.includes('To retry a failed or stopped task that others wait for, write the new task with `again: <old id>`.'));
  const blocks = office.slice(office.indexOf('## Task:'), office.indexOf('## Staff Tools')).split('```').filter((b, i) => i % 2);
  for (const b of blocks) assert.ok(!(/^staff:/m.test(b) && /^role:/m.test(b) && /^continues:/m.test(b)), b);
  assert.ok(blocks.some((b) => /^staff: \w/m.test(b) && /^needs: /m.test(b)), 'main example: staff and needs');
  assert.ok(blocks.some((b) => /^role: \w/m.test(b) && /^staff: *(#.*)?$/m.test(b)), 'a role example with staff empty');
});

test('software office: type, default team, their commands', () => {
  const a = { company: 'Acme Labs', pa: 'Hana', type: 'software', staff: D.teamOf('software').slice(0, D.SOFTWARE_STAFF_COUNT).map(({ name, role, job }) => ({ name, role, job })) };
  const c = G.buildConfig(a);
  assert.strictEqual(c.type, 'software');
  assert.deepStrictEqual(c.staff.map((s) => s.role), ['Product Analyst', 'Backend Engineer', 'Frontend Engineer', 'QA Engineer', 'Reviewer']);
  assert.deepStrictEqual(c.staff.find((s) => s.role === 'Backend Engineer').commands, ['git', 'node']);
  assert.deepStrictEqual(c.staff.find((s) => s.role === 'Reviewer').commands, ['git']);
  const j = JSON.parse(T.officeJson(c));
  assert.strictEqual(j.type, 'software');
  assert.deepStrictEqual(j.staff.find((s) => s.role === 'QA Engineer').commands, ['git', 'node']);
  assert.ok(!('commands' in j.staff.find((s) => s.role === 'Product Analyst')));
  assert.deepStrictEqual(softwareCfg.staff.map((s) => s.id), ['zara', 'irfan', 'wei-jie', 'priya', 'hakim']);
});

test('business office stays as it was; type helpers', () => {
  const c = G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: [D.STAFF[0]] });
  assert.strictEqual(c.type, 'business');
  assert.ok(!('commands' in JSON.parse(T.officeJson(c)).staff[0]));
  assert.strictEqual(D.typeOf(undefined), 'business'); assert.strictEqual(D.typeOf(' Software '), 'software'); assert.strictEqual(D.typeOf('saas'), null);
  assert.strictEqual(D.teamOf('business'), D.STAFF); assert.strictEqual(D.teamOf('software'), D.SOFTWARE_STAFF);
  assert.strictEqual(businessCfg.type, 'business');
});

test('answers file: type software gives the default software team; a bad type stops', () => {
  const bin = path.join(__dirname, '..', 'bin', 'ai-office.js');
  const run = (ans) => { const f = path.join(tmp, 'ans-type.json'); fs.writeFileSync(f, JSON.stringify(ans));
    return spawnSync(process.execPath, [bin, '--answers', f, '--skip-check'], { cwd: tmp, encoding: 'utf8' }); };
  let r = run({ company: 'Acme Labs', type: 'software' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(read(tmp, 'acme-labs/office.json'));
  assert.strictEqual(o.type, 'software');
  assert.deepStrictEqual(o.staff.map((x) => x.id), ['zara', 'irfan', 'wei-jie', 'priya', 'hakim']);
  assert.deepStrictEqual(o.staff[1].commands, ['git', 'node']);
  r = run({ company: 'Saas Co', type: 'saas' });
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /type must be "business" or "software"\./);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${n} tests passed`);
