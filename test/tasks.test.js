// Task runner tests with a fake "claude": tasks run as the staff, one at a time per staff,
// in parallel across staff; results go back into the task file; unknown staff and Stop handled.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-tasks-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const fake = `
const fs = require('fs');
const a = process.argv.slice(2);
const msg = a[a.indexOf('-p') + 1];
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ args: a, cwd: process.cwd(), at: Date.now(), who: process.env.AI_OFFICE_WHO }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const wait = msg.includes('LONG') ? 2500 : 400;
const sid = msg.includes('BADSID') ? '--evil' : a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'sess-' + Date.now() + '-' + process.pid;
out({ type: 'system', subtype: 'init', session_id: sid });
setTimeout(() => {
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done: ' + msg.split('\\n')[2] }] } });
  out({ type: 'result', subtype: 'success', is_error: false });
}, wait);
`;
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
  const cli = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(cli, { recursive: true }); fs.writeFileSync(path.join(cli, 'cli.js'), fake);
} else {
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const G = require('../lib/generate');
const D = require('../lib/defaults');
const { Tasks } = require('../lib/tasks');
const { access, chatEnv, resolveClaude } = require('../lib/chat');
const dir = path.join(tmp, 'office');
G.writeOffice(dir, G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 3).map(({ name, role, job }) => ({ name, role, job })) }));

const started = [], ended = [];
const tasks = new Tasks(dir, {
  access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv,
  loadCfg: () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')),
  onStart: (t) => started.push(t.id), onEnd: (t, r) => ended.push([t.id, t.status, r]),
});
const put = (id, staff, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\nstaff: ${staff}\nproject:\nstatus: new\n---\n${text}\n`);
const putH = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
const endedOf = (id) => ended.find((e) => e[0] === id);
const until = (fn, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
const calls = () => fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

(async () => {
  await test('a task runs as that staff, in their folder, and the report goes back into the file', async () => {
    put('t1', 'siti', 'Quote 50 t-shirts for Kedai Ali');
    tasks.scan();
    await until(() => ended.length === 1);
    const t = tasks.read('t1');
    assert.strictEqual(t.status, 'done'); assert.ok(t.started && t.finished);
    assert.strictEqual(t.result, 'Done: Quote 50 t-shirts for Kedai Ali');
    assert.strictEqual(t.task, 'Quote 50 t-shirts for Kedai Ali');
    const c = calls()[0];
    assert.strictEqual(path.resolve(c.cwd), path.resolve(dir, 'staff', 'siti'));
    assert.strictEqual(c.who, 'siti', 'a task run is marked with its staff, never pa');
    assert.ok(!c.args[c.args.indexOf('--tools') + 1].includes('Agent'), 'staff cannot hand work on');
    assert.ok(!c.args.includes('--resume'), 'each task starts fresh');
  });

  await test('one at a time per staff, different staff in parallel', async () => {
    put('t2', 'nurul', 'LONG invoice one');
    put('t3', 'nurul', 'invoice two');
    put('t4', 'aina', 'LONG reply to Ali');
    tasks.scan(); tasks.scan(); // scanning twice must not start anything twice
    await until(() => ended.length === 4);
    const c = calls().slice(1);
    assert.strictEqual(c.length, 3);
    const at = (word) => c.find((x) => x.args[x.args.indexOf('-p') + 1].includes(word)).at;
    assert.ok(Math.abs(at('invoice one') - at('reply to Ali')) < 1500, 'nurul and aina started together');
    assert.ok(at('invoice two') - at('invoice one') >= 2000, 'nurul did her second task after the first');
  });

  await test('a staff can ask a colleague; the answer is for whoever asked', async () => {
    fs.writeFileSync(path.join(dir, 'tasks', 'q1.md'), '---\nstaff: nurul\nfrom: siti\nstatus: new\n---\nAny problems with the invoices?\n');
    tasks.scan();
    await until(() => ended.some(([id]) => id === 'q1'));
    const t = tasks.read('q1');
    assert.strictEqual(t.status, 'done'); assert.strictEqual(t.from, 'siti');
    const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('Any problems'));
    assert.match(c.args[c.args.indexOf('-p') + 1], /^Task from Siti/);
    assert.match(c.args[c.args.indexOf('--append-system-prompt') + 1], /cannot ask colleagues from here/, 'no tasks from inside a task');
    fs.writeFileSync(path.join(dir, 'tasks', 'q2.md'), '---\nstaff: siti\nfrom: siti\nstatus: new\n---\nAsk myself\n');
    fs.writeFileSync(path.join(dir, 'tasks', 'q3.md'), '---\nstaff: siti\nfrom: ghost\nstatus: new\n---\nFrom nobody\n');
    tasks.scan();
    assert.match(tasks.read('q2').result, /cannot give a task to themselves/);
    assert.match(tasks.read('q3').result, /not on the team/);
  });

  await test('a task for someone who is not on the team fails with a plain reason', async () => {
    put('t5', 'ghost', 'Do something');
    tasks.scan();
    await until(() => ended.some(([id]) => id === 't5'));
    assert.strictEqual(tasks.read('t5').status, 'failed');
    assert.match(tasks.read('t5').result, /no active staff/);
  });

  await test('Stop: running and waiting tasks', async () => {
    put('t6', 'siti', 'LONG long quote');
    put('t7', 'siti', 'second quote');
    tasks.scan();
    await until(() => tasks.active().some((a) => a.id === 't6'));
    assert.deepStrictEqual(tasks.stop('t7'), { ok: true });
    assert.strictEqual(tasks.read('t7').status, 'stopped');
    tasks.stop('t6');
    await until(() => tasks.read('t6').status === 'stopped');
    assert.deepStrictEqual(tasks.active(), []);
  });

  await test('after a restart, a task left "working" is marked stopped', async () => {
    put('t8', 'aina', 'half done'); fs.writeFileSync(path.join(dir, 'tasks', 't8.md'), fs.readFileSync(path.join(dir, 'tasks', 't8.md'), 'utf8').replace('status: new', 'status: working'));
    const cut = tasks.recover();
    assert.strictEqual(tasks.read('t8').status, 'stopped');
    assert.deepStrictEqual(cut.map((t) => t.id), ['t8']);
    assert.deepStrictEqual(tasks.interrupted().map((t) => t.id), ['t8']);
  });

  await test('an interrupted task runs again as a new task with the same text, or is dismissed', async () => {
    const r = tasks.rerun('t8');
    assert.ok(r.ok && r.id !== 't8');
    const again = tasks.read(r.id);
    assert.strictEqual(again.staff, 'aina'); assert.strictEqual(again.again, 't8');
    assert.strictEqual(again.task, tasks.read('t8').task);
    assert.deepStrictEqual(tasks.interrupted(), [], 'no longer listed');
    await new Promise((ok) => { const w = setInterval(() => { if (tasks.read(r.id).status === 'done') { clearInterval(w); ok(); } }, 100); });
    assert.throws(() => tasks.rerun(r.id), /stopped or failed/); // a finished task is not run again
    put('t9', 'siti', 'also cut'); fs.writeFileSync(path.join(dir, 'tasks', 't9.md'), fs.readFileSync(path.join(dir, 'tasks', 't9.md'), 'utf8').replace('status: new', 'status: working'));
    tasks.recover(); tasks.dismiss('t9');
    assert.deepStrictEqual(tasks.interrupted(), []);
  });

  await test('a task waits for the tasks it needs, then starts on its own', async () => {
    putH('n1', 'staff: siti', 'LONG first part');
    putH('n2', 'staff: nurul\nneeds: n1', 'second part');
    tasks.scan();
    await until(() => tasks.active().some((a) => a.id === 'n1'));
    assert.strictEqual(tasks.read('n2').status, 'new');
    assert.deepStrictEqual(tasks.board().waiting.map((w) => [w.id, w.waitingFor]), [['n2', ['n1']]]);
    await until(() => endedOf('n2'));
    assert.strictEqual(tasks.read('n2').status, 'done');
    assert.ok(tasks.read('n2').started >= tasks.read('n1').finished);
  });

  await test('needs can be written loosely', async () => {
    putH('n3', 'staff: siti\nneeds: n1,n2   # both first', 'x');
    fs.writeFileSync(path.join(dir, 'tasks', 'n4.md'), '---\r\nstaff: siti\r\nneeds: n1 n2\r\nstatus: new\r\n---\r\ny\r\n');
    assert.deepStrictEqual(tasks.needsOf(tasks.read('n3')), ['n1', 'n2']);
    assert.deepStrictEqual(tasks.needsOf(tasks.read('n4')), ['n1', 'n2']);
    tasks.scan(); await until(() => endedOf('n3') && endedOf('n4'));
  });

  await test('a need that does not exist, or a circle, fails with a plain reason', async () => {
    putH('n5', 'staff: siti\nneeds: nope', 'x');
    putH('n6', 'staff: siti\nneeds: n7', 'x'); putH('n7', 'staff: nurul\nneeds: n6', 'y');
    putH('n8', 'staff: siti\nneeds: n8', 'x');
    tasks.scan();
    assert.strictEqual(tasks.read('n5').result, 'Task "nope" in needs does not exist.');
    assert.match(tasks.read('n6').result, /^These tasks need each other in a circle: /);
    assert.strictEqual(tasks.read('n7').status, 'failed');
    assert.strictEqual(tasks.read('n8').result, 'A task cannot need itself.');
  });

  await test('when a needed task fails or is stopped, the rest keeps waiting and the office is told once; a rerun unblocks it', async () => {
    const blocked = []; tasks.h.onBlocked = (t, ids) => blocked.push([t.id, ids]);
    putH('n9', 'staff: siti', 'LONG will be stopped');
    putH('n10', 'staff: nurul\nneeds: n9', 'after');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'n9'));
    tasks.stop('n9'); await until(() => tasks.read('n9').status === 'stopped');
    tasks.scan(); tasks.scan();
    assert.deepStrictEqual(blocked, [['n10', ['n9']]]);
    assert.deepStrictEqual(tasks.board().waiting[0].blockedBy, ['n9']);
    tasks.rerun('n9');
    await until(() => endedOf('n10'), 20000);
    assert.strictEqual(tasks.read('n10').status, 'done');
  });

  await test('a waiting task can be cancelled, survives a restart, and fails plainly if its need is deleted', async () => {
    putH('n11', 'staff: siti', 'LONG base'); putH('n12', 'staff: nurul\nneeds: n11', 'a'); putH('n13', 'staff: nurul\nneeds: n11', 'b');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'n11'));
    assert.deepStrictEqual(tasks.stop('n12'), { ok: true });
    assert.strictEqual(tasks.read('n12').result, 'Cancelled by the boss before it started.');
    await until(() => endedOf('n13'));                       // n13 ran after n11
    putH('n14', 'staff: siti', 'LONG base 2'); putH('n15', 'staff: nurul\nneeds: n14', 'c');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'n14'));
    fs.unlinkSync(path.join(dir, 'tasks', 'n14.md')); tasks.stopAll();
    await until(() => tasks.active().length === 0);
    const again = new Tasks(dir, tasks.h); again.scan();     // "restart": a fresh engine over the same files
    assert.strictEqual(again.read('n15').result, 'Task "n14" in needs does not exist.');
    // a waiting task whose need finished while the office was off starts after the restart
    fs.writeFileSync(path.join(dir, 'tasks', 'n16.md'), '---\nstaff: siti\nstatus: done\n---\nbase 3\n\n## Result\n\nok\n');
    putH('n17', 'staff: nurul\nneeds: n16', 'd');
    new Tasks(dir, tasks.h).scan();
    await until(() => endedOf('n17'));
    assert.strictEqual(tasks.read('n17').status, 'done');
  });

  await test('a task for a role goes to a free staff with that role, and the office writes who took it', async () => {
    putH('r1', 'role: sales', 'Quote for a role');           // role match ignores case
    tasks.scan(); await until(() => endedOf('r1'));
    const t = tasks.read('r1');
    assert.strictEqual(t.staff, 'siti'); assert.strictEqual(t.status, 'done');
  });

  await test('a role task waits while everyone with that role is busy', async () => {
    putH('r2', 'staff: siti', 'LONG busy'); putH('r3', 'role: Sales', 'next');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'r2'));
    assert.strictEqual(tasks.read('r3').staff || '', '');
    assert.deepStrictEqual(tasks.board().waiting.find((w) => w.id === 'r3').waitingFor, []);
    await until(() => endedOf('r3'));
    assert.strictEqual(tasks.read('r3').staff, 'siti');
  });

  await test('no staff and no role, or a role nobody has, fails with a plain reason', async () => {
    putH('r4', 'role: Plumber', 'x'); putH('r5', 'project:', 'y');
    tasks.scan();
    assert.strictEqual(tasks.read('r4').result, 'There is no active staff with the role "Plumber".');
    assert.strictEqual(tasks.read('r5').result, 'A task needs a staff or a role.');
  });

  await test('if the last staff with a role is archived while a role task waits, it fails plainly', async () => {
    putH('r6', 'staff: siti', 'LONG busy'); putH('r7', 'role: Sales', 'later');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'r6'));
    const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...cfg, staff: cfg.staff.filter((s) => s.id !== 'siti') }));
    tasks.scan();
    assert.strictEqual(tasks.read('r7').result, 'There is no active staff with the role "Sales".');
    assert.strictEqual(ended.filter((e) => e[0] === 'r7').length, 1, 'the requester is told once');
    fs.writeFileSync(f, JSON.stringify(cfg)); tasks.stopAll(); await until(() => tasks.active().length === 0);
  });

  await test('the office notes the Claude session of a task; a follow-up resumes it, as the same staff', async () => {
    putH('f1', 'staff: nurul', 'Draft the invoice');
    tasks.scan(); await until(() => endedOf('f1'));
    const sid = tasks.read('f1').session; assert.match(sid, /^sess-/);
    putH('f2', 'continues: f1', 'Fix the total');             // staff may be left out
    tasks.scan(); await until(() => endedOf('f2'));
    const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('task f2'));
    assert.strictEqual(c.args[c.args.indexOf('--resume') + 1], sid);
    assert.strictEqual(path.resolve(c.cwd), path.resolve(dir, 'staff', 'nurul'));
    assert.strictEqual(tasks.read('f2').staff, 'nurul');
    assert.strictEqual(tasks.read('f2').session, sid);
    assert.match(c.args[c.args.indexOf('-p') + 1], /^Follow-up from Hana \(task f2, continuing task f1\):/);
  });

  await test('a follow-up waits until the task it continues has ended', async () => {
    putH('f3', 'staff: siti', 'LONG quote'); putH('f4', 'continues: f3', 'one more line');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'f3'));
    assert.deepStrictEqual(tasks.board().waiting.find((w) => w.id === 'f4').waitingFor, ['f3']);
    await until(() => endedOf('f4'));
    assert.ok(tasks.read('f4').started >= tasks.read('f3').finished);
  });

  await test('follow-up mistakes fail plainly; with no session to resume it starts fresh and is told to read the old task', async () => {
    putH('f5', 'continues: nope', 'x'); putH('f6', 'staff: siti\ncontinues: f1', 'x');
    put('f7', 'aina', 'old'); fs.writeFileSync(path.join(dir, 'tasks', 'f7.md'), '---\nstaff: aina\nstatus: done\n---\nold task\n\n## Result\n\nok\n');
    putH('f8', 'continues: f7', 'go on');
    tasks.scan(); await until(() => endedOf('f8'));
    assert.strictEqual(tasks.read('f5').result, 'Task "nope" in continues does not exist.');
    assert.strictEqual(tasks.read('f6').result, 'A follow-up goes to the same staff as the task it continues (nurul).');
    const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('task f8'));
    assert.ok(!c.args.includes('--resume'));
    assert.match(c.args[c.args.indexOf('-p') + 1], /You have no memory of task f7: read .*f7\.md first\./);
  });

  await test('a follow-up that continues itself, or a circle of follow-ups, fails plainly', async () => {
    putH('c1', 'staff: siti\ncontinues: c1', 'x');
    putH('c2', 'staff: siti\ncontinues: c3', 'x'); putH('c3', 'staff: siti\ncontinues: c2', 'y');
    tasks.scan();
    assert.strictEqual(tasks.read('c1').result, 'A task cannot continue itself.');
    assert.match(tasks.read('c2').result, /^These tasks need each other in a circle: c2, c3\.$/);
    assert.match(tasks.read('c3').result, /^These tasks need each other in a circle: c2, c3\.$/);
  });

  await test('a follow-up to a role task nobody has claimed yet waits, then runs as whoever took it', async () => {
    putH('c4', 'staff: siti', 'LONG busy'); putH('c5', 'role: Sales', 'first'); putH('c6', 'continues: c5', 'and then this');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'c4'));
    assert.strictEqual(tasks.read('c6').status, 'new');
    assert.deepStrictEqual(tasks.board().waiting.find((w) => w.id === 'c6').waitingFor, ['c5']);
    await until(() => endedOf('c6'));
    assert.strictEqual(tasks.read('c6').staff, 'siti'); assert.strictEqual(tasks.read('c6').status, 'done');
    assert.ok(tasks.read('c6').started >= tasks.read('c5').finished);
  });

  await test('the office-wide limit: never more runs at once than maxParallel, oldest first', async () => {
    const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    const set = (v) => fs.writeFileSync(f, JSON.stringify({ ...cfg, maxParallel: v }));
    for (const [v, want] of [[0, 3], ['abc', 3], [99, 8], [2.9, 2], [undefined, 3], [1, 1]]) { set(v); assert.strictEqual(tasks.limit(), want); }
    let most = 0; const watch = setInterval(() => { most = Math.max(most, tasks.active().length); }, 20);
    putH('p1', 'staff: siti', 'LONG a'); putH('p2', 'staff: nurul', 'LONG b'); putH('p3', 'staff: aina', 'c');
    tasks.scan();
    assert.deepStrictEqual(tasks.board().waiting.map((w) => [w.id, w.waitingFor]).sort(), [['p2', []], ['p3', []]]);
    await until(() => endedOf('p1') && endedOf('p2') && endedOf('p3'), 20000);
    clearInterval(watch); assert.strictEqual(most, 1);
    assert.ok(tasks.read('p2').started >= tasks.read('p1').finished);
    fs.writeFileSync(f, JSON.stringify(cfg));
  });

  await test('hand-written tasks (no created) start in the order they were written, not by id', async () => {
    const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...cfg, maxParallel: 1 }));
    putH('o-busy', 'staff: siti', 'LONG busy');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'o-busy'));
    putH('z-first', 'staff: nurul', 'written first'); putH('a-second', 'staff: aina', 'written second');
    const now = Date.now() / 1000, tf = (id) => path.join(dir, 'tasks', `${id}.md`);
    fs.utimesSync(tf('z-first'), now - 2, now - 2); fs.utimesSync(tf('a-second'), now - 1, now - 1);
    tasks.scan();
    await until(() => endedOf('z-first') && endedOf('a-second'), 20000);
    assert.ok(tasks.read('z-first').started < tasks.read('a-second').started, 'z-first ran first');
    assert.ok(!fs.readFileSync(tf('a-second'), 'utf8').includes('created:'), 'created is not written into the file');
    fs.writeFileSync(f, JSON.stringify(cfg));
  });

  await test('a task that cannot even start fails once; the others start exactly once', async () => {
    putH('e1', 'staff: siti\ncreated: 2001-01-01T00:00:00.000Z', 'bad \0 text');
    putH('e2', 'staff: nurul\ncreated: 2001-01-01T00:00:01.000Z', 'second ok');
    putH('e3', 'staff: aina\ncreated: 2001-01-01T00:00:02.000Z', 'third ok');
    tasks.scan();
    await until(() => endedOf('e1') && endedOf('e2') && endedOf('e3'));
    await new Promise((r) => setTimeout(r, 900)); // a second run would end by now
    for (const id of ['e1', 'e2', 'e3']) assert.strictEqual(ended.filter((e) => e[0] === id).length, 1, `${id} ended once`);
    for (const id of ['e2', 'e3']) assert.strictEqual(calls().filter((x) => x.args[x.args.indexOf('-p') + 1].includes(`(task ${id})`)).length, 1, `${id} spawned once`);
    assert.strictEqual(tasks.read('e1').status, 'failed'); assert.match(tasks.read('e1').result, /^Could not start Claude Code/);
    assert.deepStrictEqual(tasks.active(), []);
  });

  await test('a hand-written session that is not a session id is never passed to Claude', async () => {
    fs.writeFileSync(path.join(dir, 'tasks', 's1.md'), '---\nstaff: aina\nstatus: done\nsession: --some-flag\n---\nold\n\n## Result\n\nok\n');
    putH('s2', 'continues: s1', 'more please');
    putH('s3', 'staff: siti', 'BADSID run');
    tasks.scan(); await until(() => endedOf('s2') && endedOf('s3'));
    const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('task s2'));
    assert.ok(!c.args.includes('--resume') && !c.args.includes('--some-flag'));
    assert.match(c.args[c.args.indexOf('-p') + 1], /You have no memory of task s1: read .*s1\.md first\./);
    assert.strictEqual(tasks.read('s3').session, undefined, 'a bad session id from Claude is not written');
  });

  await test('run again keeps continues, job and kind', async () => {
    fs.writeFileSync(path.join(dir, 'tasks', 'g1.md'), '---\nstaff: nurul\ncontinues: f1\njob: j-7\nkind: invoice\nstatus: failed\n---\nRedo the total\n\n## Result\n\nbroke\n');
    const r = tasks.rerun('g1'), t = tasks.read(r.id);
    assert.deepStrictEqual([t.continues, t.job, t.kind, t.again, t.staff], ['f1', 'j-7', 'invoice', 'g1', 'nurul']);
    await until(() => endedOf(r.id));
    assert.strictEqual(tasks.read(r.id).status, 'done');
  });

  await test('a role task never goes to the staff who asked for it', async () => {
    const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...cfg, staff: cfg.staff.map((s) => (s.id === 'nurul' ? { ...s, role: 'Sales' } : s)) }));
    putH('h1', 'role: Sales\nfrom: siti', 'Check my quote');
    tasks.scan(); await until(() => endedOf('h1'));
    assert.strictEqual(tasks.read('h1').staff, 'nurul');
    fs.writeFileSync(f, JSON.stringify(cfg));
    putH('h2', 'role: Sales\nfrom: siti', 'Only I am Sales');
    tasks.scan(); await until(() => endedOf('h2'));
    assert.strictEqual(tasks.read('h2').status, 'failed');
    assert.strictEqual(tasks.read('h2').result, 'Only the one who asked has the role "Sales", and a staff cannot give a task to themselves.');
  });

  await test('Run again on a role task nobody took keeps the role, and the task waiting for it goes on', async () => {
    putH('k1', 'role: Plumber', 'Fix the sink'); putH('k2', 'staff: siti\nneeds: k1', 'Quote after the sink');
    tasks.scan();
    assert.match(tasks.read('k1').result, /no active staff with the role "Plumber"/);
    const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...cfg, staff: cfg.staff.map((s) => (s.id === 'aina' ? { ...s, role: 'Plumber' } : s)) }));
    const r = tasks.rerun('k1');
    assert.ok(!r.id.includes('undefined'), r.id); assert.match(r.id, /-plumber(-\d+)?$/);
    assert.strictEqual(tasks.read(r.id).role, 'Plumber');
    await until(() => endedOf(r.id) && endedOf('k2'));
    assert.deepStrictEqual([tasks.read(r.id).status, tasks.read(r.id).staff, tasks.read('k2').status], ['done', 'aina', 'done']);
    fs.writeFileSync(f, JSON.stringify(cfg));
  });

  await test('a task run of an Auto staff starts in auto mode with the settings; another staff is unchanged', async () => {
    const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...cfg, staff: cfg.staff.map((s) => (s.id === 'aina' ? { ...s, commandMode: 'auto' } : s)) }));
    put('au1', 'aina', 'auto work au1'); put('au2', 'siti', 'plain work au2');
    tasks.scan(); await until(() => endedOf('au1') && endedOf('au2'));
    const val = (c, k) => c.args[c.args.indexOf(k) + 1];
    const a = calls().find((x) => val(x, '-p').includes('auto work au1')), b = calls().find((x) => val(x, '-p').includes('plain work au2'));
    assert.strictEqual(val(a, '--permission-mode'), 'auto');
    assert.ok(val(a, '--tools').split(',').includes('Bash'));
    assert.ok(JSON.parse(val(a, '--settings')).autoMode);
    assert.strictEqual(val(b, '--permission-mode'), 'default'); assert.ok(!b.args.includes('--settings'));
    fs.writeFileSync(f, JSON.stringify(cfg));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} task tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
