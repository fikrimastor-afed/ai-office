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
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ args: a, cwd: process.cwd(), at: Date.now() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const wait = msg.includes('LONG') ? 2500 : 400;
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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} task tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
