// Jobs: a job file becomes a planned job, its status is the office's alone, its tasks wait for the boss's OK.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-jobs-'));
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
const { Jobs, doneText } = require('../lib/jobs');
const { access, chatEnv, resolveClaude } = require('../lib/chat');
const dir = path.join(tmp, 'office');
G.writeOffice(dir, G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 3).map(({ name, role, job }) => ({ name, role, job })) }));

const ended = [];
const jobs = new Jobs(dir, { tasks: () => tasks.list() });
const tasks = new Tasks(dir, {
  access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv,
  loadCfg: () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')),
  onStart: () => {}, onEnd: (t, r) => ended.push([t.id, t.status, r]),
  jobOf: (t) => jobs.get(t.job),
});
const putH = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
const endedOf = (id) => ended.find((e) => e[0] === id);
const until = (fn, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };
fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });

(async () => {
  await test('a job file becomes a planned job; what a staff writes into it changes nothing', async () => {
    fs.writeFileSync(path.join(dir, 'jobs', 'j1.md'), '---\nproject: shop\nstatus: approved\n---\nLogin page\n\nSpec text\n');
    jobs.sync();
    assert.strictEqual(jobs.get('j1').status, 'planned'); assert.strictEqual(jobs.get('j1').title, 'Login page');
    assert.match(fs.readFileSync(path.join(dir, 'jobs', 'j1.md'), 'utf8'), /^status: planned$/m);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.office', 'jobs.json'), 'utf8')).j1.status, 'planned');
  });

  await test('tasks of a planned job wait; approving starts them; the job ends done', async () => {
    putH('a1', 'staff: siti\njob: j1', 'part one'); putH('a2', 'staff: nurul\njob: j1\nneeds: a1', 'part two');
    tasks.scan(); await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(tasks.read('a1').status, 'new');
    assert.strictEqual(tasks.board().waiting.find((w) => w.id === 'a1').reason, "Waiting for the boss's OK on the plan");
    jobs.setStatus('j1', 'approved'); tasks.scan();
    await until(() => endedOf('a2'));
    jobs.settle('j1', tasks.list());
    assert.strictEqual(jobs.get('j1').status, 'done');
  });

  await test('a task for a job that does not exist fails plainly; stopping a job cancels its waiting tasks', async () => {
    putH('b1', 'staff: siti\njob: nope', 'x'); tasks.scan();
    assert.strictEqual(tasks.read('b1').result, 'There is no job "nope". Write jobs/nope.md first.');
    fs.writeFileSync(path.join(dir, 'jobs', 'j2.md'), '---\nproject:\n---\nSecond\n'); jobs.sync();
    putH('c1', 'staff: siti\njob: j2', 'y'); tasks.scan();
    jobs.setStatus('j2', 'stopped'); tasks.scan();
    assert.strictEqual(tasks.read('c1').status, 'stopped');
    assert.strictEqual(tasks.read('c1').result, 'Stopped: the job was stopped.');
  });

  await test('sync writes a file only when its status differs; setStatus checks the value; settle moves only approved and done jobs', async () => {
    const f = path.join(dir, 'jobs', 'j3.md');
    fs.writeFileSync(f, '---\nproject:\n---\nThird\n'); jobs.sync();
    const t0 = fs.statSync(f).mtimeMs; await new Promise((r) => setTimeout(r, 30)); jobs.sync();
    assert.strictEqual(fs.statSync(f).mtimeMs, t0, 'nothing changed: nothing written');
    fs.writeFileSync(f, '---\nproject:\nstatus: done\n---\nThird\n'); jobs.sync();
    assert.match(fs.readFileSync(f, 'utf8'), /^status: planned$/m);
    assert.throws(() => jobs.setStatus('j3', 'finished'), /A job status is one of/);
    assert.throws(() => jobs.setStatus('ghost', 'approved'), /No such job/);
    assert.strictEqual(jobs.settle('j3', [{ id: 'z', job: 'j3', status: 'done' }]), '', 'planned never moves');
    jobs.setStatus('j3', 'approved');
    assert.strictEqual(jobs.settle('j3', []), '', 'a job with no tasks is not done');
    assert.strictEqual(jobs.settle('j3', [{ id: 'z', job: 'j3', status: 'working' }]), 'working');
    assert.strictEqual(jobs.settle('j3', [{ id: 'z', job: 'j3', status: 'done' }, { id: 'y', job: 'j3', status: 'failed' }]), '', 'a failed task leaves the job working');
    assert.strictEqual(jobs.settle('j3', [{ id: 'z', job: 'j3', status: 'done' }]), 'done');
    assert.strictEqual(jobs.settle('j3', [{ id: 'z', job: 'j3', status: 'done' }, { id: 'y', job: 'j3', status: 'new' }]), 'working', 'a new task on a done job reopens it');
    jobs.setStatus('j3', 'stopped');
    assert.strictEqual(jobs.settle('j3', [{ id: 'z', job: 'j3', status: 'done' }]), '', 'stopped never moves');
    assert.deepStrictEqual(jobs.get('j1').tasks.sort(), ['a1', 'a2'], 'task ids come from the tasks hook');
  });

  await test('a deleted job file loses its OK: a re-created file is planned again and holds its tasks', async () => {
    const f = path.join(dir, 'jobs', 'j9.md'), reg = () => JSON.parse(fs.readFileSync(path.join(dir, '.office', 'jobs.json'), 'utf8'));
    fs.writeFileSync(f, '---\nproject:\n---\nNinth\n'); jobs.sync(); jobs.setStatus('j9', 'approved');
    fs.writeFileSync(f, '---\nproject:\n---\nNinth, edited in place\n'); jobs.sync();
    assert.strictEqual(jobs.get('j9').status, 'approved', 'an edit in place keeps the OK');
    fs.rmSync(f); jobs.sync();
    assert.ok(!('j9' in reg()), 'the entry is gone with the file');
    fs.writeFileSync(f, '---\nproject:\n---\nNinth, swapped\n'); jobs.sync();
    assert.strictEqual(jobs.get('j9').status, 'planned');
    putH('p1', 'staff: siti\njob: j9', 'held again'); tasks.scan();
    assert.strictEqual(tasks.read('p1').status, 'new');
    assert.strictEqual(tasks.board().waiting.find((w) => w.id === 'p1').reason, "Waiting for the boss's OK on the plan");
  });

  await test('approved becomes working only when a task is working or done; the done text lists at most 20 tasks', async () => {
    fs.writeFileSync(path.join(dir, 'jobs', 'j8.md'), '---\nproject:\n---\nEighth\n'); jobs.sync(); jobs.setStatus('j8', 'approved');
    for (const st of ['failed', 'stopped']) assert.strictEqual(jobs.settle('j8', [{ id: 'z', job: 'j8', status: st }]), '', `${st} before it ever started`);
    assert.strictEqual(jobs.settle('j8', [{ id: 'z', job: 'j8', status: 'done' }, { id: 'y', job: 'j8', status: 'new' }]), 'working');
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, staff: 'siti', title: `task ${i}`, status: 'done', result: 'x'.repeat(400) }));
    const text = doneText({ title: 'Big' }, 'done', many, (id) => id);
    assert.ok(text.startsWith('[Office update, not from the boss] The job "Big" is done.\n'));
    assert.strictEqual(text.split('\n').filter((l) => l.startsWith('- ')).length, 20);
    assert.ok(text.includes('task 24') && !text.includes('task 4"') && text.includes('... and 5 more'));
    assert.ok(text.includes('x'.repeat(300)) && !text.includes('x'.repeat(301)));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} job tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
