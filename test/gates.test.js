// One branch per coding task: worktrees, the job's branch, merges by the office. Real git in the temp folder,
// a fake "claude" driven by words in the task text:
//   WRITE <file> <text>   write and commit that file in the worktree named in the prompt
//   LEAVE <file> <text>   write it without committing
//   STUBBORN              the session never fixes a merge conflict
//   LONG                  takes longer
//   SWITCH <branch>       switches the worktree to a new branch
//   SWAP <folder>         replaces the worktree with a link to that folder and writes x.txt there
//   CHECKOUT <branch>     checks out that branch in the worktree (lines run in order)
//   SLOWFIX               the session's follow-ups take longer
// A prompt asking to "run git merge office/<job>" makes it merge and resolve the conflict ("resolved").
// A prompt saying the project's tests fail makes it write ok.txt, remove sleep.txt and commit (not when STUBBORN).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (spawnSync('git', ['--version']).status !== 0) { console.log('skip: git is not installed'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-gates-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const fake = `
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
const msg = a[a.indexOf('-p') + 1];
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ args: a, msg, cwd: process.cwd(), at: Date.now() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const resume = a.includes('--resume') ? a[a.indexOf('--resume') + 1] : '';
const sid = resume || (msg.includes('STUBBORN') ? 'stubborn-' : msg.includes('SLOWFIX') ? 'slowfix-' : 'sess-') + Date.now() + '-' + process.pid;
out({ type: 'system', subtype: 'init', session_id: sid });
const m = /Work only in (.+?)\\. It is its own copy/.exec(msg), wt = m ? m[1] : '';
const g = (...x) => spawnSync('git', ['-C', wt, ...x], { encoding: 'utf8' });
setTimeout(() => {
  if (wt) {
    for (const line of msg.split('\\n')) { // in order
      const w = /^(WRITE|LEAVE) (\\S+) (.*)$/.exec(line);
      if (w) { fs.writeFileSync(path.join(wt, w[2]), w[3] + '\\n'); if (w[1] === 'WRITE') { g('add', '-A'); g('commit', '-m', 'write ' + w[2]); } }
      const sw = /^SWITCH (\\S+)$/.exec(line); if (sw) g('checkout', '-q', '-b', sw[1]);
      const co = /^CHECKOUT (\\S+)$/.exec(line); if (co) g('checkout', '-q', co[1]);
      const swap = /^SWAP (.+)$/.exec(line); if (swap) { fs.rmSync(wt, { recursive: true, force: true }); fs.symlinkSync(swap[1], wt, 'dir'); fs.writeFileSync(path.join(swap[1], 'x.txt'), 'x'); }
    }
    if (/The project's tests fail after your change/.test(msg) && !sid.startsWith('stubborn')) {
      fs.writeFileSync(path.join(wt, 'ok.txt'), 'ok\\n'); fs.rmSync(path.join(wt, 'sleep.txt'), { force: true }); g('add', '-A'); g('commit', '-m', 'fix tests');
    }
    const mm = /run git merge (office\\/[^,\\s]+),/.exec(msg);
    if (mm && !sid.startsWith('stubborn')) {
      if (g('merge', '--no-edit', mm[1]).status !== 0) {
        for (const f of g('diff', '--name-only', '--diff-filter=U').stdout.split('\\n').filter(Boolean)) fs.writeFileSync(path.join(wt, f), 'resolved\\n');
        g('add', '-A'); g('commit', '--no-edit');
      }
    }
  }
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done: ' + msg.split('\\n')[2] }] } });
  out({ type: 'result', subtype: 'success', is_error: false });
}, msg.includes('LONG') ? 2000 : sid.startsWith('slowfix') && resume ? 2500 : 300);
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
const O = require('../lib/office');
const R = require('../lib/repo');
const { Tasks } = require('../lib/tasks');
const { Jobs } = require('../lib/jobs');
const { Gates, NOT_READY, NOT_READY_TASK, NO_REPO, ROOT_BAD, CODE_BAD } = require('../lib/gates');
const { commandOk } = require('../office-files/guard');
const { access, chatEnv, resolveClaude } = require('../lib/chat');

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const mkRepo = (name, first = true) => {
  const d = path.join(tmp, name); fs.mkdirSync(d);
  git(d, 'init', '-q'); git(d, 'symbolic-ref', 'HEAD', 'refs/heads/main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@t');
  if (first) { fs.writeFileSync(path.join(d, 'a.txt'), 'one\n'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'first'); }
  return d;
};
const snap = (d) => JSON.stringify([git(d, 'rev-parse', 'HEAD'), git(d, 'symbolic-ref', '-q', 'HEAD'), git(d, 'status', '--porcelain'), fs.readFileSync(path.join(d, 'a.txt'), 'utf8')]);
const officeBranches = (d) => git(d, 'branch', '--list', 'office/*');
const show = (d, ref) => { const r = spawnSync('git', ['show', ref], { cwd: d, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

// An office with its engine wired like the server does.
function engine(dir, extra = {}, gopts = {}) {
  const loadCfg = () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8'));
  const e = { dir, said: [], ended: [], seen: [] };
  e.jobs = new Jobs(dir, { tasks: () => e.tasks.list(), onChange: (j) => { if (j.status === 'approved') e.gates.jobApproved(j.id); } });
  e.gates = new Gates({ dir, loadCfg, jobOf: (id) => e.jobs.get(id), say: (t) => e.said.push(t), ...gopts });
  e.tasks = new Tasks(dir, {
    access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv, loadCfg,
    onStart: () => {}, onEnd: (t, r) => e.ended.push([t.id, t.status, r]), jobOf: (t) => e.jobs.get(t.job), gates: e.gates, ...extra,
  });
  e.gates.tasks = e.tasks;
  e.staff = loadCfg().staff.map((s) => s.id);
  e.put = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
  e.job = (id, project) => { fs.writeFileSync(path.join(dir, 'jobs', `${id}.md`), `---\nproject: ${project}\n---\nJob ${id}\n`); e.jobs.sync(); };
  e.status = (id) => e.tasks.read(id).status;
  const after = e.gates.afterRun.bind(e.gates); // what the board shows while the office finishes a task
  e.gates.afterRun = (t) => { e.seen.push(...e.tasks.board().checking.map((c) => ({ ...c, file: e.tasks.read(c.id).status }))); return after(t); };
  return e;
}
function office(name, type, gopts) {
  const dir = path.join(tmp, name);
  G.writeOffice(dir, G.buildConfig({ company: 'Acme', pa: 'Hana', type, staff: (type === 'software' ? D.SOFTWARE_STAFF : D.STAFF).slice(0, 3).map(({ name: n, role, job }) => ({ name: n, role, job })) }));
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  return engine(dir, {}, gopts);
}
const project = (e, title, linked) => { const p = O.createProject(e.dir, { title }); if (linked) O.updateProject(e.dir, p.id, { linked }); return p.id; };
const until = (fn, ms = 20000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { let ok = false; try { ok = fn(); } catch { /* not yet */ } if (ok) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = () => fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const callOf = (word) => calls().find((c) => c.msg.includes(word));
const wtDir = (e) => path.join(e.dir, 'worktrees');
const wts = (e) => { try { return fs.readdirSync(wtDir(e)); } catch { return []; } };
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

(async () => {
  const soft = office('soft', 'software');
  const [s0, s1, s2] = soft.staff;
  const r1 = mkRepo('repo1');
  const p1 = project(soft, 'Shop', r1);

  await test('a job: each coding task gets its own worktree and branch; both merge into the job branch; the checkout is untouched', async () => {
    const before = snap(r1);
    soft.put('a1', `staff: ${s0}\nproject: ${p1}\njob: j1\nkind: code`, 'Add one\nWRITE one.txt from a1');
    soft.put('a2', `staff: ${s1}\nproject: ${p1}\njob: j1\nkind: code`, 'Add two\nWRITE two.txt from a2');
    soft.job('j1', p1);
    soft.jobs.setStatus('j1', 'approved');
    assert.ok(R.branchExists(r1, 'office/j1'), 'the job branch is made when the job is approved');
    soft.tasks.scan();
    await until(() => soft.status('a1') === 'done' && soft.status('a2') === 'done');
    const c1 = callOf('WRITE one.txt'), c2 = callOf('WRITE two.txt');
    assert.ok(c1.msg.includes(`Work only in ${path.join(soft.dir, 'worktrees', 'a1')}. It is its own copy of the project on branch office/a1. Commit your work there (git -C "${path.join(soft.dir, 'worktrees', 'a1')}" add ... then commit). Do not switch branches.`));
    assert.strictEqual(path.resolve(c1.cwd), path.resolve(soft.dir, 'staff', s0), 'the run stays in the staff folder');
    assert.ok(Math.abs(c1.at - c2.at) < 1000, 'both ran at the same time');
    assert.strictEqual(show(r1, 'office/j1:one.txt'), 'from a1');
    assert.strictEqual(show(r1, 'office/j1:two.txt'), 'from a2');
    assert.ok(R.branchExists(r1, 'office/a1') && R.branchExists(r1, 'office/a2'));
    assert.deepStrictEqual(wts(soft), [], 'both worktrees are gone');
    assert.strictEqual(snap(r1), before, "the user's branch and files are unchanged");
    for (const id of ['a1', 'a2']) {
      const t = soft.tasks.read(id);
      assert.ok(t.result.endsWith('Branch: office/j1.'), t.result);
      assert.strictEqual(t.branch, `office/${id}`); assert.strictEqual(t.base, 'office/j1'); assert.strictEqual(t.worktree, path.join(soft.dir, 'worktrees', id));
    }
    assert.ok(soft.seen.some((c) => c.id === 'a1' && c.stage === 'merge' && c.file === 'checking' && c.staff === s0), 'checking shows on the board');
    assert.ok(!soft.tasks.active().some((x) => x.id === 'a1'));
    assert.strictEqual(soft.ended.filter(([id]) => id === 'a1').length, 1, 'the end is told once, when done');
    assert.strictEqual(git(r1, 'rev-list', '--merges', '--count', 'main..office/j1'), '2', 'two merges, one after the other');
  });

  await test('a follow-up of a finished coding task opens its branch again in a worktree and merges it', async () => {
    soft.put('a3', `staff: ${s0}\ncontinues: a1\nproject: ${p1}\njob: j1`, 'One more\nWRITE three.txt more');
    soft.tasks.scan();
    await until(() => soft.status('a3') === 'done');
    assert.ok(callOf('WRITE three.txt').msg.includes(`Work only in ${path.join(soft.dir, 'worktrees', 'a1')}. It is its own copy of the project on branch office/a1.`));
    assert.strictEqual(show(r1, 'office/a1:three.txt'), 'more');
    assert.strictEqual(show(r1, 'office/j1:three.txt'), 'more');
    assert.deepStrictEqual(wts(soft), []);
  });

  await test('LEAVE: work left uncommitted is committed by the office and reaches the job branch', async () => {
    soft.put('b1', `staff: ${s0}\nproject: ${p1}\njob: j2\nkind: code`, 'Leave it\nLEAVE left.txt uncommitted');
    soft.job('j2', p1); soft.jobs.setStatus('j2', 'approved'); soft.tasks.scan();
    await until(() => soft.status('b1') === 'done');
    assert.strictEqual(show(r1, 'office/j2:left.txt'), 'uncommitted');
    assert.strictEqual(git(r1, 'log', '-1', '--format=%s', 'office/b1'), 'Work in progress (uncommitted when the task ended)');
  });

  await test('a conflict: the author gets a follow-up naming the file; after it the task merges and is done', async () => {
    soft.put('c1', `staff: ${s0}\nproject: ${p1}\njob: j3\nkind: code`, 'Alpha\nWRITE a.txt alpha');
    soft.put('c2', `staff: ${s1}\nproject: ${p1}\njob: j3\nkind: code`, 'Beta LONG\nWRITE a.txt beta');
    soft.job('j3', p1); soft.jobs.setStatus('j3', 'approved'); soft.tasks.scan();
    await until(() => soft.status('c1') === 'done' && soft.status('c2') === 'done');
    const fix = soft.tasks.list().find((t) => t.fixes === 'c2');
    assert.ok(fix, 'a follow-up was written');
    assert.strictEqual(fix.status, 'done'); assert.strictEqual(fix.continues, 'c2'); assert.strictEqual(fix.staff, s1); assert.strictEqual(fix.job, 'j3'); assert.strictEqual(fix.kind, 'code');
    assert.ok(fix.task.startsWith(`Your branch does not merge into the job's branch. Files: a.txt. In ${path.join(soft.dir, 'worktrees', 'c2')}, run git merge office/j3, fix the conflicts, commit, and report.`), fix.task);
    assert.ok(soft.seen.some((c) => c.id === 'c2'), 'c2 was checking meanwhile');
    assert.strictEqual(show(r1, 'office/j3:a.txt'), 'resolved');
    assert.ok(soft.tasks.read('c2').result.endsWith('Branch: office/j3.'));
    assert.deepStrictEqual(soft.ended.filter(([id]) => id === 'c2').map((x) => x[1]), ['done']);
    assert.deepStrictEqual(wts(soft), []);
  });

  await test('a second conflict fails the task with the file list', async () => {
    soft.put('d1', `staff: ${s0}\nproject: ${p1}\njob: j4\nkind: code`, 'Gamma\nWRITE a.txt gamma');
    soft.put('d2', `staff: ${s1}\nproject: ${p1}\njob: j4\nkind: code`, 'Delta LONG STUBBORN\nWRITE a.txt delta');
    soft.job('j4', p1); soft.jobs.setStatus('j4', 'approved'); soft.tasks.scan();
    await until(() => soft.status('d2') === 'failed');
    assert.strictEqual(soft.status('d1'), 'done');
    assert.match(soft.tasks.read('d2').result, /Files: a\.txt\.$/);
    assert.strictEqual(show(r1, 'office/j4:a.txt'), 'gamma');
    assert.deepStrictEqual(soft.ended.filter(([id]) => id === 'd2').map((x) => x[1]), ['failed']);
  });

  await test('two tasks of one job that finish at the same moment are both merged, one at a time', async () => {
    const id = (x) => soft.tasks.read(x);
    soft.put('e1', `staff: ${s0}\nproject: ${p1}\njob: j5\nkind: code`, 'E one\nWRITE e1.txt x');
    soft.put('e2', `staff: ${s2}\nproject: ${p1}\njob: j5\nkind: code`, 'E two\nWRITE e2.txt y');
    soft.job('j5', p1); soft.jobs.setStatus('j5', 'approved'); soft.tasks.scan();
    await until(() => id('e1').status === 'done' && id('e2').status === 'done');
    assert.ok(Math.abs(Date.parse(id('e1').finished) - Date.parse(id('e2').finished)) < 1500);
    assert.strictEqual(show(r1, 'office/j5:e1.txt'), 'x'); assert.strictEqual(show(r1, 'office/j5:e2.txt'), 'y');
  });

  const held = async (e, repo, job, label) => {
    const before = git(repo, 'status', '--porcelain');
    const p = project(e, `Held ${job}`, repo);
    e.put(`h-${job}`, `staff: ${e.staff[0]}\nproject: ${p}\njob: ${job}\nkind: code`, `Held\nWRITE h.txt h`);
    e.job(job, p); e.jobs.setStatus(job, 'approved'); e.tasks.scan(); e.tasks.scan();
    await sleep(500);
    assert.strictEqual(e.status(`h-${job}`), 'new', label);
    const w = e.tasks.board().waiting.find((x) => x.id === `h-${job}`);
    assert.deepStrictEqual(wts(e).filter((x) => x === `h-${job}`), [], `${label}: no worktree`);
    assert.strictEqual(git(repo, 'status', '--porcelain'), before, `${label}: nothing changed`);
    assert.strictEqual(officeBranches(repo), '', `${label}: no branch made`);
    assert.strictEqual(e.said.filter((x) => x.includes(`Job ${job}`)).length, 1, `${label}: said once`);
    return { w, id: `h-${job}`, p };
  };

  await test('a dirty repo, a detached HEAD or no commits: the task waits with the reason and nothing changes; it starts once the repo is ready', async () => {
    const dirty = mkRepo('dirty'); fs.writeFileSync(path.join(dirty, 'a.txt'), 'edited\n');
    const before = snap(dirty);
    const h = await held(soft, dirty, 'j6', 'dirty');
    assert.strictEqual(h.w.reason, NOT_READY);
    assert.ok(soft.said.some((x) => x.endsWith(NOT_READY)));
    assert.strictEqual(snap(dirty), before);
    const det = mkRepo('detached'); git(det, 'checkout', '-q', '--detach');
    assert.strictEqual((await held(soft, det, 'j7', 'detached')).w.reason, NOT_READY);
    const none = mkRepo('nocommits', false);
    assert.strictEqual((await held(soft, none, 'j8', 'no commits')).w.reason, NOT_READY);
    git(dirty, 'commit', '-q', '-am', 'boss commits'); // ready now: the next scan starts it
    soft.tasks.scan();
    await until(() => soft.status(h.id) === 'done');
    assert.strictEqual(show(dirty, 'office/j6:h.txt'), 'h');
    for (const id of ['h-j7', 'h-j8']) soft.tasks.stop(id);
  });

  await test('a repo with git settings the office will not run with: held, with the repo helper\'s message', async () => {
    const bad = mkRepo('badcfg'); git(bad, 'config', 'filter.x.clean', 'evil');
    const h = await held(soft, bad, 'j9', 'settings');
    assert.match(h.w.reason, /git settings the office will not run with: filter\.x\.clean/);
    soft.tasks.stop(h.id);
  });

  await test('a small job (no job): branch office/<task id> is left for the boss; the current branch is untouched', async () => {
    const before = snap(r1);
    soft.put('k1', `staff: ${s0}\nproject: ${p1}\nkind: code`, 'Small\nWRITE small.txt s');
    soft.tasks.scan();
    await until(() => soft.status('k1') === 'done');
    assert.strictEqual(show(r1, 'office/k1:small.txt'), 's');
    assert.strictEqual(show(r1, 'main:small.txt'), null);
    assert.strictEqual(snap(r1), before);
    assert.ok(soft.tasks.read('k1').result.endsWith('Branch: office/k1.'));
    assert.strictEqual(soft.tasks.read('k1').base, 'main');
    assert.deepStrictEqual(wts(soft), []);
  });

  await test('a linked folder that is not a repo: the task runs in place, with the reason', async () => {
    const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain);
    const p = project(soft, 'Plain', plain);
    soft.put('n1', `staff: ${s0}\nproject: ${p}\nkind: code`, 'In place\nWRITE x.txt x');
    soft.tasks.scan();
    await until(() => soft.status('n1') === 'done');
    assert.ok(!callOf('In place').msg.includes('Work only in'));
    assert.ok(soft.tasks.read('n1').result.includes(NO_REPO));
    assert.deepStrictEqual(wts(soft), []);
    assert.ok(!fs.existsSync(path.join(plain, '.git')));
  });

  await test('a project with no linked folder: projects/<id>/code becomes a repo and the task works there', async () => {
    const p = project(soft, 'Fresh app');
    soft.put('o1', `staff: ${s0}\nproject: ${p}\nkind: code`, 'Own\nWRITE own.txt mine');
    soft.tasks.scan();
    await until(() => soft.status('o1') === 'done');
    const code = path.join(soft.dir, 'projects', p, 'code');
    assert.ok(R.isRepo(code));
    assert.strictEqual(show(code, 'office/o1:own.txt'), 'mine');
  });

  await test('restart: a task left checking is finished by a new engine; a worktree whose task is gone is removed', async () => {
    R.createBranch(r1, 'office/j10', 'main');
    soft.job('j10', p1); soft.jobs.setStatus('j10', 'approved');
    const root = wtDir(soft), wt = path.join(root, 'r1'), gone = path.join(root, 'gone1');
    fs.mkdirSync(root, { recursive: true });
    assert.ok(R.addWorktree(r1, wt, 'office/r1', 'office/j10', root).ok);
    fs.writeFileSync(path.join(wt, 'r.txt'), 'restart\n'); R.commitAll(r1, wt, 'office/r1', root, 'r');
    assert.ok(R.addWorktree(r1, gone, 'office/gone1', 'main', root).ok);
    const reg = JSON.parse(fs.readFileSync(path.join(soft.dir, '.office', 'gates.json'), 'utf8'));
    reg.r1 = { repo: r1, wt, branch: 'office/r1', base: 'office/j10', into: 'office/j10' };
    reg.gone1 = { repo: r1, wt: gone, branch: 'office/gone1', base: 'main', into: '' };
    fs.writeFileSync(path.join(soft.dir, '.office', 'gates.json'), JSON.stringify(reg));
    fs.writeFileSync(path.join(soft.dir, 'tasks', 'r1.md'), `---\nstaff: ${s0}\nproject: ${p1}\njob: j10\nkind: code\nstatus: checking\n---\nLeft checking\n\n## Result\nDid it.\n`);
    const again = engine(soft.dir);
    again.gates.recover();
    await until(() => again.status('r1') === 'done');
    assert.strictEqual(show(r1, 'office/j10:r.txt'), 'restart');
    assert.ok(!fs.existsSync(wt) && !fs.existsSync(gone));
    assert.ok(!JSON.parse(fs.readFileSync(path.join(soft.dir, '.office', 'gates.json'), 'utf8')).gone1);
    assert.ok(again.tasks.read('r1').result.endsWith('Branch: office/j10.'));
    assert.ok(R.listWorktrees(r1).every((w) => !w.branch.startsWith('office/')));
  });

  await test('a business office: a kind: code task runs in place, with no worktree and no branch', async () => {
    const biz = office('biz', 'business');
    const rb = mkRepo('bizrepo'), before = snap(rb);
    const p = project(biz, 'Site', rb);
    biz.put('z1', `staff: ${biz.staff[0]}\nproject: ${p}\nkind: code`, 'Biz code\nWRITE b.txt b');
    biz.tasks.scan();
    await until(() => biz.status('z1') === 'done');
    assert.ok(!callOf('Biz code').msg.includes('Work only in'));
    assert.ok(!biz.tasks.read('z1').result.includes('Branch:'));
    assert.deepStrictEqual(wts(biz), []);
    assert.strictEqual(officeBranches(rb), '');
    assert.strictEqual(snap(rb), before);
    assert.ok(!fs.existsSync(path.join(biz.dir, '.office', 'gates.json')));
  });

  // ---- fix round 1: links, stuck checks, follow-ups taking turns, name clashes
  const canLink = (() => { const t = path.join(tmp, 'linktest'); try { fs.symlinkSync(tmp, t, 'dir'); fs.unlinkSync(t); return true; } catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') return false; throw e; } })();
  const soft2 = office('soft2', 'software');
  const [t0, t1] = soft2.staff;
  const nameOf = (id) => JSON.parse(fs.readFileSync(path.join(soft2.dir, 'office.json'), 'utf8')).staff.find((x) => x.id === id).name;
  const r2 = mkRepo('repo2');
  const p2 = project(soft2, 'Shop two', r2);
  const fixOf = (id) => soft2.tasks.list().find((t) => t.fixes === id);

  await test('a worktree swapped for a link to another repo: nothing is committed there and the task fails', async () => {
    if (!canLink) return console.log('  (skip: links need privileges here)');
    const other = mkRepo('other'), head = git(other, 'rev-parse', 'HEAD');
    soft2.put('s1t', `staff: ${t0}\nproject: ${p2}\njob: q0\nkind: code`, `Swap\nLEAVE s.txt s\nSWAP ${other}`);
    soft2.job('q0', p2); soft2.jobs.setStatus('q0', 'approved'); soft2.tasks.scan();
    await until(() => ['done', 'failed'].includes(soft2.status('s1t')));
    assert.strictEqual(soft2.status('s1t'), 'failed');
    assert.strictEqual(git(other, 'rev-parse', 'HEAD'), head, 'the other repo got no commit');
    assert.strictEqual(git(other, 'status', '--porcelain'), '?? x.txt');
    fs.unlinkSync(path.join(soft2.dir, 'worktrees', 's1t')); R.prune(r2);
  });

  await test('a conflict follow-up that is cancelled before it runs fails the waiting task on the next scan', async () => {
    soft2.put('g1', `staff: ${t0}\nproject: ${p2}\njob: q1\nkind: code`, 'G one\nWRITE a.txt g1');
    soft2.put('g2', `staff: ${t1}\nproject: ${p2}\njob: q1\nkind: code`, 'G two LONG\nWRITE a.txt g2');
    await sleep(20); soft2.put('g3', `staff: ${t1}`, 'Busy LONG');
    soft2.job('q1', p2); soft2.jobs.setStatus('q1', 'approved'); soft2.tasks.scan();
    await until(() => fixOf('g2') && soft2.status('g3') === 'working');
    const c = soft2.tasks.board().checking.find((x) => x.id === 'g2');
    assert.strictEqual(c.reason, `Waiting for ${nameOf(t1)} to fix the merge`);
    assert.ok(soft2.tasks.stop(fixOf('g2').id).ok);
    soft2.tasks.scan();
    await until(() => soft2.status('g2') === 'failed');
    assert.ok(soft2.tasks.read('g2').result.endsWith('The follow-up to fix the merge did not finish.'));
    await until(() => soft2.status('g3') === 'done');
  });

  await test('Stop on a checking task: stopped, its worktree removed, its follow-up cancelled, the branch kept', async () => {
    soft2.put('h1', `staff: ${t0}\nproject: ${p2}\njob: q2\nkind: code`, 'H one\nWRITE b.txt h1');
    soft2.put('h2', `staff: ${t1}\nproject: ${p2}\njob: q2\nkind: code`, 'H two LONG\nWRITE b.txt h2');
    await sleep(20); soft2.put('h3', `staff: ${t1}`, 'Busy again LONG');
    soft2.job('q2', p2); soft2.jobs.setStatus('q2', 'approved'); soft2.tasks.scan();
    await until(() => fixOf('h2') && soft2.status('h3') === 'working');
    assert.ok(soft2.tasks.stop('h2').ok);
    const t = soft2.tasks.read('h2');
    assert.strictEqual(t.status, 'stopped');
    assert.ok(t.result.endsWith('Stopped by the boss while the office was finishing it. Branch office/h2 is in the project folder.'), t.result);
    assert.ok(!fs.existsSync(path.join(soft2.dir, 'worktrees', 'h2')));
    assert.ok(R.branchExists(r2, 'office/h2'));
    assert.strictEqual(fixOf('h2').status, 'stopped');
    await until(() => soft2.status('h3') === 'done');
  });

  await test('two follow-ups of one task take turns in its worktree; both reach the job branch', async () => {
    soft2.put('m1', `staff: ${t0}\nproject: ${p2}\njob: q3\nkind: code`, 'M one\nWRITE m1.txt m');
    soft2.job('q3', p2); soft2.jobs.setStatus('q3', 'approved'); soft2.tasks.scan();
    await until(() => soft2.status('m1') === 'done');
    soft2.put('f1', `staff: ${t0}\ncontinues: m1\nproject: ${p2}\njob: q3`, 'F one\nWRITE f1.txt one');
    await sleep(20); soft2.put('f2', `staff: ${t0}\ncontinues: m1\nproject: ${p2}\njob: q3`, 'F two\nWRITE f2.txt two');
    soft2.tasks.scan();
    await until(() => soft2.status('f1') !== 'new');
    const w = soft2.tasks.board().waiting.find((x) => x.id === 'f2');
    assert.strictEqual(w.reason, 'Waiting for F one');
    await until(() => ['done', 'failed'].includes(soft2.status('f2')));
    assert.strictEqual(soft2.status('f1'), 'done'); assert.strictEqual(soft2.status('f2'), 'done');
    assert.strictEqual(show(r2, 'office/q3:f1.txt'), 'one'); assert.strictEqual(show(r2, 'office/q3:f2.txt'), 'two');
    assert.ok(callOf('WRITE f2.txt').at > Date.parse(soft2.tasks.read('f1').finished) - 5, 'f2 ran after f1 was finished');
    assert.ok(!fs.existsSync(path.join(soft2.dir, 'worktrees', 'm1')));
  });

  await test('a staff who switches branches in the worktree: nothing is merged, the worktree stays, the task fails plainly', async () => {
    const wt = path.join(soft2.dir, 'worktrees', 'w1');
    soft2.put('w1', `staff: ${t0}\nproject: ${p2}\njob: q4\nkind: code`, 'Switch\nLEAVE s.txt s\nSWITCH feature');
    soft2.job('q4', p2); soft2.jobs.setStatus('q4', 'approved'); soft2.tasks.scan();
    await until(() => ['done', 'failed'].includes(soft2.status('w1')));
    assert.strictEqual(soft2.status('w1'), 'failed');
    assert.ok(soft2.tasks.read('w1').result.endsWith(`The work is on branch feature, not office/w1. Nothing was merged. The worktree is still at ${wt} until the office restarts; commits on feature stay in the project.`), soft2.tasks.read('w1').result);
    assert.ok(fs.existsSync(path.join(wt, 's.txt')));
    assert.strictEqual(show(r2, 'office/q4:s.txt'), null);
    assert.strictEqual(git(r2, 'rev-parse', 'feature'), git(r2, 'rev-parse', 'office/q4'), 'nothing committed onto feature');
  });

  await test('a worktree left on another branch blocks nothing; a follow-up works there once it is back on its branch', async () => {
    soft2.put('n2', `staff: ${t1}\nproject: ${p2}\njob: q6\nkind: code`, 'Other work\nWRITE n.txt n');
    soft2.job('q6', p2); soft2.jobs.setStatus('q6', 'approved'); soft2.tasks.scan();
    await until(() => ['done', 'failed'].includes(soft2.status('n2')));
    assert.strictEqual(soft2.status('n2'), 'done', soft2.tasks.read('n2').result);
    assert.strictEqual(show(r2, 'office/q6:n.txt'), 'n');
    const wt = path.join(soft2.dir, 'worktrees', 'w1');
    soft2.put('wf1', `staff: ${t0}\ncontinues: w1`, 'Still off\nWRITE ff.txt ff');
    await sleep(20); soft2.put('wf2', `staff: ${t0}\ncontinues: w1`, 'Back\nCHECKOUT office/w1\nWRITE fb.txt fb');
    soft2.tasks.scan();
    await until(() => ['done', 'failed'].includes(soft2.status('wf2')));
    assert.strictEqual(soft2.status('wf1'), 'failed');
    assert.ok(soft2.tasks.read('wf1').result.endsWith(`The work is on branch feature, not office/w1. Nothing was merged. The worktree is still at ${wt} until the office restarts; commits on feature stay in the project.`));
    assert.strictEqual(soft2.status('wf2'), 'done', soft2.tasks.read('wf2').result);
    assert.strictEqual(show(r2, 'office/q4:fb.txt'), 'fb');
    assert.strictEqual(show(r2, 'feature:ff.txt'), 'ff', 'commits on feature stay');
    assert.ok(!fs.existsSync(wt));
    // a detached worktree and one on another branch, left for the restart below
    soft2.put('dt1', `staff: ${t0}\nproject: ${p2}\njob: q6\nkind: code`, 'Detach\nLEAVE d.txt d\nCHECKOUT --detach');
    await sleep(20); soft2.put('e1', `staff: ${t0}\nproject: ${p2}\njob: q6\nkind: code`, 'Off again\nSWITCH feature2\nWRITE e.txt e');
    soft2.tasks.scan();
    await until(() => ['done', 'failed'].includes(soft2.status('e1')));
    assert.ok(soft2.tasks.read('dt1').result.endsWith(`The work is not on a branch (detached), not on office/dt1. Nothing was merged. The worktree is still at ${path.join(soft2.dir, 'worktrees', 'dt1')} until the office restarts.`), soft2.tasks.read('dt1').result);
    assert.strictEqual(soft2.status('e1'), 'failed');
  });

  await test('a stopped checking task whose follow-up is running: the run is stopped, then the worktree removed', async () => {
    soft2.put('o1', `staff: ${t0}\nproject: ${p2}\njob: q7\nkind: code`, 'O one\nWRITE c.txt o1');
    soft2.put('o2', `staff: ${t1}\nproject: ${p2}\njob: q7\nkind: code`, 'O two LONG SLOWFIX\nWRITE c.txt o2');
    soft2.job('q7', p2); soft2.jobs.setStatus('q7', 'approved'); soft2.tasks.scan();
    await until(() => fixOf('o2') && fixOf('o2').status === 'working');
    assert.ok(soft2.tasks.stop('o2').ok);
    assert.strictEqual(soft2.status('o2'), 'stopped');
    await until(() => fixOf('o2').status === 'stopped');
    await until(() => !fs.existsSync(path.join(soft2.dir, 'worktrees', 'o2')));
  });

  await test("the office knows its own conflict follow-up by the id it recorded, not by its fixes: line", async () => {
    soft2.put('x1', `staff: ${t0}\nproject: ${p2}\njob: q8\nkind: code`, 'X one\nWRITE d.txt x1');
    soft2.put('x2', `staff: ${t1}\nproject: ${p2}\njob: q8\nkind: code`, 'X two LONG\nWRITE d.txt x2');
    await sleep(20); soft2.put('x3', `staff: ${t1}`, 'Busy third LONG');
    soft2.job('q8', p2); soft2.jobs.setStatus('q8', 'approved'); soft2.tasks.scan();
    await until(() => fixOf('x2') && soft2.status('x3') === 'working');
    const fid = fixOf('x2').id, f = path.join(soft2.dir, 'tasks', `${fid}.md`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^fixes: .*\n/m, ''));
    soft2.tasks.scan();
    assert.strictEqual(soft2.tasks.board().checking.find((x) => x.id === 'x2').reason, `Waiting for ${nameOf(t1)} to fix the merge`);
    await until(() => ['done', 'failed'].includes(soft2.status('x2')));
    assert.strictEqual(soft2.status('x2'), 'done', soft2.tasks.read('x2').result);
    assert.strictEqual(show(r2, 'office/q8:d.txt'), 'resolved');
  });

  await test("a project's code folder that is a link, or holds a planted .git file: held, nothing done outside", async () => {
    const pa = project(soft2, 'Gitfile app'); const code = path.join(soft2.dir, 'projects', pa, 'code');
    fs.mkdirSync(code); fs.writeFileSync(path.join(code, '.git'), `gitdir: ${path.join(r2, '.git')}\n`);
    soft2.put('i1', `staff: ${t0}\nproject: ${pa}\nkind: code`, 'Planted\nWRITE i.txt i');
    soft2.tasks.scan(); await sleep(300);
    assert.strictEqual(soft2.tasks.board().waiting.find((x) => x.id === 'i1').reason, CODE_BAD);
    soft2.tasks.stop('i1');
    if (!canLink) return console.log('  (skip: links need privileges here)');
    const out = path.join(tmp, 'outside'); fs.mkdirSync(out);
    const pl = project(soft2, 'Linked out'); fs.symlinkSync(out, path.join(soft2.dir, 'projects', pl, 'code'), 'dir');
    soft2.put('i2', `staff: ${t0}\nproject: ${pl}\nkind: code`, 'Out\nWRITE i.txt i');
    soft2.tasks.scan(); await sleep(300);
    assert.strictEqual(soft2.tasks.board().waiting.find((x) => x.id === 'i2').reason, CODE_BAD);
    assert.deepStrictEqual(fs.readdirSync(out), [], 'no git init outside');
    soft2.tasks.stop('i2');
    const ps = project(soft2, 'Shared objects'), code2 = path.join(soft2.dir, 'projects', ps, 'code'), refs = git(r2, 'for-each-ref');
    fs.mkdirSync(path.join(code2, '.git'), { recursive: true });
    for (const x of ['HEAD', 'config']) fs.copyFileSync(path.join(r2, '.git', x), path.join(code2, '.git', x));
    for (const x of ['objects', 'refs']) fs.symlinkSync(path.join(r2, '.git', x), path.join(code2, '.git', x), 'dir');
    soft2.put('i3', `staff: ${t0}\nproject: ${ps}\njob: x9\nkind: code`, 'Shared\nWRITE i.txt i');
    soft2.job('x9', ps); soft2.jobs.setStatus('x9', 'approved'); soft2.tasks.scan(); await sleep(300);
    assert.strictEqual(soft2.tasks.board().waiting.find((x) => x.id === 'i3').reason, CODE_BAD);
    assert.strictEqual(git(r2, 'for-each-ref'), refs, 'the other repo gains no branch');
    soft2.tasks.stop('i3');
  });

  await test('a task and a job with the same name: the task fails, or the job waits, with a plain reason', async () => {
    soft2.job('q5', p2);
    soft2.put('q5', `staff: ${t0}\nproject: ${p2}\nkind: code`, 'Clash\nWRITE c.txt c');
    soft2.tasks.scan();
    await until(() => soft2.status('q5') === 'failed');
    assert.strictEqual(soft2.tasks.read('q5').result, 'A task and a job cannot have the same name ("q5").');
    soft2.job('m1', p2); soft2.jobs.setStatus('m1', 'approved'); // m1 is a task with a recorded branch
    soft2.put('y1', `staff: ${t0}\nproject: ${p2}\njob: m1\nkind: code`, 'Clash two\nWRITE c.txt c');
    soft2.tasks.scan(); await sleep(300);
    assert.strictEqual(soft2.tasks.board().waiting.find((x) => x.id === 'y1').reason, 'A task and a job cannot have the same name ("m1").');
    assert.ok(!R.branchExists(r2, 'office/m1') || git(r2, 'rev-parse', 'office/m1') !== git(r2, 'rev-parse', 'main'), 'no job branch made over the task branch');
    soft2.tasks.stop('y1');
    // the server leaves such a job planned (no plan card) and says why once
    const { createServer } = require('../lib/server');
    process.env.AI_OFFICE_NO_DOCTOOLS = '1';
    const s3 = office('soft3', 'software');
    fs.mkdirSync(path.join(s3.dir, '.office'), { recursive: true });
    fs.writeFileSync(path.join(s3.dir, '.office', 'gates.json'), JSON.stringify({ zz: { repo: r2, wt: path.join(s3.dir, 'worktrees', 'zz'), branch: 'office/zz', base: 'main', into: '' } }));
    fs.writeFileSync(path.join(s3.dir, 'tasks', 'zz.md'), `---\nstaff: ${s3.staff[0]}\nstatus: done\n---\nOld\n`);
    s3.job('zz', 'x'); s3.put('zz-1', `staff: ${s3.staff[0]}\njob: zz`, 'Under zz');
    const srv = createServer(s3.dir); await srv.listen(0);
    try {
      await sleep(400);
      assert.ok(!O.listApprovals(s3.dir).some((a) => a.status === 'pending'), 'no plan card');
      const chat = fs.readFileSync(path.join(s3.dir, '.office', 'chats', 'pa.jsonl'), 'utf8');
      assert.strictEqual(chat.split('A task and a job cannot have the same name (\\"zz\\").').length - 1, 1);
    } finally { await srv.close(); }
  });

  await test('a small task on a dirty checkout waits with its own wording', async () => {
    const d2 = mkRepo('dirty2'); fs.writeFileSync(path.join(d2, 'a.txt'), 'edited\n');
    const p = project(soft2, 'Dirty two', d2);
    soft2.put('k2', `staff: ${t0}\nproject: ${p}\nkind: code`, 'Small dirty\nWRITE k.txt k');
    soft2.tasks.scan(); await sleep(300);
    assert.strictEqual(NOT_READY_TASK, 'The project folder has changes that are not committed (or no branch checked out). Commit or stash them and the task will start.');
    assert.strictEqual(soft2.tasks.board().waiting.find((x) => x.id === 'k2').reason, NOT_READY_TASK);
    soft2.tasks.stop('k2');
  });

  await test('restart: a worktrees folder that became a link is never followed; finished records are dropped', async () => {
    const again = engine(soft2.dir);
    again.gates.recover(); await sleep(200);
    const reg = JSON.parse(fs.readFileSync(path.join(soft2.dir, '.office', 'gates.json'), 'utf8'));
    for (const id of ['g1', 'm1', 'f1', 'f2', 'h2']) assert.ok(!reg[id], `${id} dropped`);
    for (const id of ['e1', 'dt1']) { assert.ok(!fs.existsSync(path.join(soft2.dir, 'worktrees', id)), `${id}: removed at restart`); assert.ok(!reg[id], `${id} dropped`); }
    assert.strictEqual(show(r2, 'feature2:e.txt'), 'e', 'the commits on the other branch stay');
    if (!canLink) return console.log('  (skip: links need privileges here)');
    const root = path.join(soft2.dir, 'worktrees'), bak = path.join(soft2.dir, 'wt-bak');
    assert.ok(R.addWorktree(r2, path.join(root, 'live1'), 'office/live1', 'main', root).ok); // registered; must stay registered (no prune through a linked root)
    fs.renameSync(root, bak);
    const elsewhere = path.join(tmp, 'elsewhere'); fs.mkdirSync(path.join(elsewhere, 'v1'), { recursive: true }); fs.writeFileSync(path.join(elsewhere, 'v1', 'keep.txt'), 'k');
    fs.symlinkSync(elsewhere, root, 'dir');
    reg.v1 = { repo: r2, wt: path.join(root, 'v1'), branch: 'office/v1', base: 'main', into: '' };
    fs.writeFileSync(path.join(soft2.dir, '.office', 'gates.json'), JSON.stringify(reg));
    const third = engine(soft2.dir);
    third.gates.recover(); await sleep(200);
    assert.ok(fs.existsSync(path.join(elsewhere, 'v1', 'keep.txt')), 'nothing outside the office is deleted');
    third.put('v2', `staff: ${t0}\nproject: ${p2}\nkind: code`, 'After swap\nWRITE v.txt v');
    third.tasks.scan(); await sleep(300);
    assert.strictEqual(third.tasks.board().waiting.find((x) => x.id === 'v2').reason, ROOT_BAD(soft2.dir));
    third.tasks.stop('v2');
    assert.ok(R.listWorktrees(r2).some((w) => w.branch === 'office/live1'), 'no prune while the root is a link');
    fs.unlinkSync(root); fs.renameSync(bak, root);
    assert.ok(R.removeWorktree(r2, path.join(root, 'live1'), root).ok);
  });

  await test('a follow-up stays a coding task: after a restart it gets its own branch from the job branch; a plain follow-up stays plain', async () => {
    const e = engine(soft2.dir);
    e.put('u1', `staff: ${t0}\ncontinues: m1`, 'After restart\nWRITE u.txt u');
    e.tasks.scan();
    await until(() => ['done', 'failed'].includes(e.status('u1')));
    const u = e.tasks.read('u1');
    assert.strictEqual(u.status, 'done', u.result);
    assert.strictEqual(u.kind, 'code'); assert.strictEqual(u.job, 'q3'); assert.strictEqual(u.project, p2);
    assert.ok(callOf('After restart').msg.includes(`Work only in ${path.join(soft2.dir, 'worktrees', 'u1')}. It is its own copy of the project on branch office/u1.`));
    assert.strictEqual(show(r2, 'office/q3:u.txt'), 'u');
    e.put('nc1', `staff: ${t0}`, 'Plain question'); e.tasks.scan();
    await until(() => e.status('nc1') === 'done');
    e.put('nc2', `staff: ${t0}\ncontinues: nc1`, 'Plain follow-up'); e.tasks.scan();
    await until(() => e.status('nc2') === 'done');
    assert.ok(!e.tasks.read('nc2').kind); assert.ok(!callOf('Plain follow-up').msg.includes('Work only in'));
  });

  await test("a link anywhere inside an office project's .git holds the task; a normal project with packed objects works", async () => {
    const victim = mkRepo('victim2'); git(victim, 'branch', 'office/x');
    const vstate = () => JSON.stringify([git(victim, 'for-each-ref'), git(victim, 'count-objects', '-v'), fs.readdirSync(path.join(victim, '.git', 'logs', 'refs', 'heads'))]);
    const before = vstate(), vg = path.join(victim, '.git');
    const lk = (target, at, type = 'dir') => { try { fs.symlinkSync(target, at, type); return true; } catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') return false; throw e; } };
    const plants = [
      ['refs office', (g) => { fs.rmSync(path.join(g, 'refs', 'heads', 'office'), { recursive: true }); return lk(path.join(vg, 'refs', 'heads', 'office'), path.join(g, 'refs', 'heads', 'office')); }],
      ['objects xx', (g) => { const x = fs.readdirSync(path.join(g, 'objects')).find((y) => /^[0-9a-f]{2}$/.test(y)), at = path.join(g, 'objects', x); fs.rmSync(at, { recursive: true }); fs.mkdirSync(path.join(vg, 'objects', x), { recursive: true }); return lk(path.join(vg, 'objects', x), at); }],
      ['logs', (g) => { fs.rmSync(path.join(g, 'logs'), { recursive: true }); return lk(path.join(vg, 'logs'), path.join(g, 'logs')); }],
      ['ref file', (g) => { const f = path.join(g, 'refs', 'heads', 'office', 'x'); fs.rmSync(f); return lk(path.join(vg, 'refs', 'heads', 'office', 'x'), f, 'file'); }],
      ['deep', (g) => { const at = path.join(g, 'refs', 'heads', 'a', 'b'); fs.mkdirSync(at, { recursive: true }); return lk(path.join(vg, 'refs'), path.join(at, 'c')); }],
    ];
    let i = 0, skipped = false;
    for (const [what, plant] of plants) {
      const p = project(soft2, `Planted ${++i}`), code = path.join(soft2.dir, 'projects', p, 'code');
      assert.ok(R.ensureRepo(code).ok); git(code, 'branch', 'office/x');
      if (!plant(path.join(code, '.git'))) { skipped = true; continue; }
      soft2.put(`pl${i}`, `staff: ${t0}\nproject: ${p}\njob: pj${i}\nkind: code`, `Planted ${what}\nWRITE p.txt p`);
      soft2.job(`pj${i}`, p); soft2.jobs.setStatus(`pj${i}`, 'approved'); soft2.tasks.scan(); await sleep(300);
      assert.strictEqual(soft2.status(`pl${i}`), 'new', what);
      assert.strictEqual(soft2.tasks.board().waiting.find((x) => x.id === `pl${i}`).reason, CODE_BAD, what);
      soft2.tasks.stop(`pl${i}`);
    }
    if (skipped) console.log('  (skip: links need privileges here)');
    assert.strictEqual(vstate(), before, 'the other repo is unchanged');
    const pn = project(soft2, 'Normal own'), code = path.join(soft2.dir, 'projects', pn, 'code');
    soft2.put('na1', `staff: ${t0}\nproject: ${pn}\njob: nj\nkind: code`, 'Normal one\nWRITE a1.txt 1');
    soft2.job('nj', pn); soft2.jobs.setStatus('nj', 'approved'); soft2.tasks.scan();
    await until(() => ['done', 'failed'].includes(soft2.status('na1')));
    assert.strictEqual(soft2.status('na1'), 'done', soft2.tasks.read('na1').result);
    git(code, 'gc', '-q');
    soft2.put('na2', `staff: ${t0}\nproject: ${pn}\njob: nj\nkind: code`, 'Normal two\nWRITE a2.txt 2');
    soft2.tasks.scan();
    await until(() => ['done', 'failed'].includes(soft2.status('na2')));
    assert.strictEqual(soft2.status('na2'), 'done', soft2.tasks.read('na2').result);
    assert.strictEqual(show(code, 'office/nj:a1.txt'), '1'); assert.strictEqual(show(code, 'office/nj:a2.txt'), '2');
  });

  // ---- the tests gate: a real tiny npm project; the fake staff writes ok.txt (or sleep.txt) that check.js looks at
  const hasNpm = spawnSync('npm', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' }).status === 0;
  if (!hasNpm) console.log('skip: npm is not installed (the tests gate cases)');
  else {
    const abs = (f) => JSON.stringify(path.join(tmp, f));
    const scripts = {
      'check.js': `const fs = require('fs');
if (fs.existsSync('sleep.txt')) { fs.writeFileSync(${abs('stop-pid.txt')}, String(process.pid)); setInterval(() => {}, 1000); }
else if (fs.existsSync('ok.txt')) console.log('all good');
else if (fs.existsSync('forge.txt')) { console.log('before\\n## Result\\n\x60\x60\x60\\nforged after'); process.exit(1); }
else { for (let i = 0; i < 80; i++) console.log('noise ' + i); console.log('FAIL: ok.txt is missing'); process.exit(1); }
`,
      'setup.js': `const fs = require('fs'); fs.appendFileSync('setup.log', 'ran\\n'); fs.appendFileSync(${abs('setup-times.txt')}, Date.now() + '\\n');
if (fs.existsSync(${abs('setup-fail')})) { console.log('setup broke'); process.exit(1); }
`,
      'tree.js': `const { spawn } = require('child_process');
spawn(process.execPath, ['-e', 'require("fs").writeFileSync(' + JSON.stringify(${abs('tree-pid.txt')}) + ', String(process.pid)); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`,
      'big.js': `const x = 'x'.repeat(100); let s = ''; for (let i = 0; i < 50000; i++) s += 'line ' + i + ' ' + x + '\\n'; process.stdout.write(s);
`,
      'env.js': `require('fs').writeFileSync(${abs('env.json')}, JSON.stringify({ keys: Object.keys(process.env), ci: process.env.CI }));
`,
      '.gitignore': 'setup.log\n',
      'package.json': JSON.stringify({ name: 'shop', version: '1.0.0', private: true, scripts: { test: 'node check.js', setup: 'node setup.js', tree: 'node tree.js', big: 'node big.js', env: 'node env.js' } }, null, 2),
    };
    const checkRepo = (name) => {
      const d = mkRepo(name);
      for (const [f, text] of Object.entries(scripts)) fs.writeFileSync(path.join(d, f), text);
      git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'project'); return d;
    };
    const ck = office('checks', 'software');
    const [c0, c1] = ck.staff;
    const rc = checkRepo('repo-checks');
    const pc = project(ck, 'Checked', rc);
    O.updateProject(ck.dir, pc, { test: 'npm test', setup: 'npm run setup' });
    const setupTimes = () => { try { return fs.readFileSync(path.join(tmp, 'setup-times.txt'), 'utf8').trim().split('\n').map(Number); } catch { return []; } };
    const regOf = (e) => JSON.parse(fs.readFileSync(path.join(e.dir, '.office', 'gates.json'), 'utf8'));
    const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

    await test('tests gate: setup runs once in the new worktree before the run; the tests pass; the result says so', async () => {
      ck.put('k1', `staff: ${c0}\nproject: ${pc}\njob: kj1\nkind: code`, 'Pass first\nWRITE ok.txt ok');
      ck.job('kj1', pc); ck.jobs.setStatus('kj1', 'approved'); ck.tasks.scan();
      await until(() => ['done', 'failed'].includes(ck.status('k1')));
      const t = ck.tasks.read('k1');
      assert.strictEqual(t.status, 'done', t.result);
      assert.ok(t.result.endsWith('Tests: passed (npm test).\nBranch: office/kj1.'), t.result);
      assert.strictEqual(show(rc, 'office/kj1:ok.txt'), 'ok');
      assert.strictEqual(setupTimes().length, 1, 'setup ran once');
      assert.ok(setupTimes()[0] <= callOf('Pass first').at, 'setup ran before the staff run');
      assert.strictEqual(show(rc, 'office/kj1:setup.log'), null, 'what setup made is not committed (ignored)');
    });

    await test('tests gate: the tests fail; the office gives the author a follow-up with the tail; after it they pass (round 1)', async () => {
      ck.put('u1', `staff: ${c1}\nproject: ${pc}\njob: kj2\nkind: code`, 'Fail first\nWRITE other.txt x');
      ck.job('kj2', pc); ck.jobs.setStatus('kj2', 'approved'); ck.tasks.scan();
      const onBoard = () => ck.tasks.board().checking.find((x) => x.id === 'u1' && x.reason);
      await until(onBoard);
      const name = JSON.parse(fs.readFileSync(path.join(ck.dir, 'office.json'), 'utf8')).staff.find((x) => x.id === c1).name;
      assert.deepStrictEqual([onBoard().stage, onBoard().round, onBoard().reason], ['tests', 1, `Waiting for ${name} to fix the tests`]);
      await until(() => ['done', 'failed'].includes(ck.status('u1')));
      const t = ck.tasks.read('u1'), fix = ck.tasks.list().find((x) => x.fixes === 'u1'), wt = path.join(ck.dir, 'worktrees', 'u1');
      assert.strictEqual(t.status, 'done', t.result);
      assert.ok(fix, 'a follow-up was written');
      assert.ok(fix.task.startsWith(`The project's tests fail after your change (npm test). Fix it in ${wt}, commit, and report.\n\n\`\`\`\n`), fix.task);
      assert.match(fix.task, /^    FAIL: ok\.txt is missing$/m);
      assert.doesNotMatch(fix.task, /^    noise 5$/m, 'only the tail');
      assert.ok(fix.task.split('\n').length < 70);
      assert.strictEqual(fix.continues, 'u1'); assert.strictEqual(fix.staff, c1); assert.strictEqual(fix.kind, 'code'); assert.strictEqual(fix.job, 'kj2'); assert.strictEqual(fix.status, 'done');
      assert.ok(callOf('The project\'s tests fail after your change').msg.includes(`Work only in ${wt}.`), 'same worktree');
      assert.strictEqual(regOf(ck).u1.round, 1); assert.strictEqual(t.round, '1');
      assert.strictEqual(regOf(ck).u1.why, 'tests');
      assert.ok(t.result.endsWith('Tests: passed (npm test).\nBranch: office/kj2.'), t.result);
      assert.strictEqual(show(rc, 'office/kj2:ok.txt'), 'ok');
      assert.deepStrictEqual(ck.ended.filter(([id]) => id === 'u1').map((x) => x[1]), ['done']);
      assert.strictEqual(setupTimes().length, 2, 'setup ran for the new worktree only, not again for the follow-up');
    });

    await test('tests gate: tests that still fail after 5 rounds fail the task with the tail', async () => {
      ck.put('v1', `staff: ${c0}\nproject: ${pc}\njob: kj3\nkind: code`, 'Never passes STUBBORN\nWRITE v.txt v');
      ck.job('kj3', pc); ck.jobs.setStatus('kj3', 'approved'); ck.tasks.scan();
      await until(() => ['done', 'failed'].includes(ck.status('v1')), 60000);
      const t = ck.tasks.read('v1');
      assert.strictEqual(t.status, 'failed');
      assert.match(t.result, /The project's tests still fail after 5 rounds\.\n\n```\n[\s\S]*FAIL: ok\.txt is missing[\s\S]*\n```$/);
      assert.strictEqual(ck.tasks.list().filter((x) => x.fixes === 'v1').length, 5);
      assert.strictEqual(regOf(ck).v1.round, 5);
      assert.strictEqual(show(rc, 'office/kj3:v.txt'), null, 'nothing merged');
    });

    await test('tests gate: no test set gives the line; a test: line a staff writes into the project file is not used', async () => {
      const pn = project(ck, 'No checks', checkRepo('repo-nochecks'));
      const pf = path.join(ck.dir, 'projects', pn, 'CLAUDE.md');
      fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace(/^---\n/, '---\ntest: npm test\nsetup: npm run setup\n'));
      const before = setupTimes().length;
      ck.put('w1', `staff: ${c0}\nproject: ${pn}\njob: kj4\nkind: code`, 'No checks\nWRITE w.txt w');
      ck.job('kj4', pn); ck.jobs.setStatus('kj4', 'approved'); ck.tasks.scan();
      await until(() => ['done', 'failed'].includes(ck.status('w1')));
      const t = ck.tasks.read('w1');
      assert.strictEqual(t.status, 'done', t.result);
      assert.ok(t.result.endsWith('Tests: none set for this project.\nBranch: office/kj4.'), t.result);
      assert.strictEqual(setupTimes().length, before, 'no setup either');
    });

    await test('tests gate: a failing setup fails the task before any Claude run, with the tail', async () => {
      fs.writeFileSync(path.join(tmp, 'setup-fail'), '');
      ck.put('x1', `staff: ${c0}\nproject: ${pc}\njob: kj5\nkind: code`, 'Setup breaks\nWRITE ok.txt ok');
      ck.job('kj5', pc); ck.jobs.setStatus('kj5', 'approved'); ck.tasks.scan();
      await until(() => ['done', 'failed'].includes(ck.status('x1')));
      fs.rmSync(path.join(tmp, 'setup-fail'));
      const t = ck.tasks.read('x1');
      assert.strictEqual(t.status, 'failed');
      assert.match(t.result, /^The project's setup failed \(npm run setup\)\.\n\n```\n[\s\S]*^    setup broke$[\s\S]*```$/m);
      assert.strictEqual(callOf('Setup breaks'), undefined, 'no Claude run');
    });

    await test('tests gate: Stop while the tests run kills the check; the task ends stopped, the branch kept', async () => {
      ck.put('y1', `staff: ${c0}\nproject: ${pc}\njob: kj6\nkind: code`, 'Slow tests\nWRITE sleep.txt zz');
      ck.job('kj6', pc); ck.jobs.setStatus('kj6', 'approved'); ck.tasks.scan();
      const pidFile = path.join(tmp, 'stop-pid.txt');
      await until(() => fs.existsSync(pidFile) && (ck.tasks.board().checking.find((c) => c.id === 'y1') || {}).stage === 'tests');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(!gone(pid), 'the check runs');
      assert.deepStrictEqual(ck.tasks.stop('y1'), { ok: true });
      await until(() => ck.status('y1') === 'stopped');
      const t = ck.tasks.read('y1');
      assert.ok(t.result.endsWith('Stopped by the boss while the office was finishing it. Branch office/y1 is in the project folder.'), t.result);
      await until(() => gone(pid), 3000);
      assert.ok(!fs.existsSync(path.join(ck.dir, 'worktrees', 'y1')));
      assert.ok(R.branchExists(rc, 'office/y1'));
      assert.deepStrictEqual(ck.ended.filter(([id]) => id === 'y1').map((x) => x[1]), ['stopped']);
      fs.rmSync(pidFile);
    });

    await test('tests gate: Stop while the setup runs ends the task stopped with no Claude run', async () => {
      O.updateProject(ck.dir, pc, { setup: 'npm run tree' });
      const pidFile = path.join(tmp, 'tree-pid.txt');
      ck.put('y2', `staff: ${c1}\nproject: ${pc}\njob: kj7\nkind: code`, 'Setup hangs\nWRITE ok.txt ok');
      ck.job('kj7', pc); ck.jobs.setStatus('kj7', 'approved'); ck.tasks.scan();
      await until(() => fs.existsSync(pidFile));
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.strictEqual(ck.status('y2'), 'working');
      assert.ok(ck.tasks.active().find((a) => a.id === 'y2').step.startsWith('Setting up the project'));
      assert.deepStrictEqual(ck.tasks.stop('y2'), { ok: true });
      await until(() => ck.status('y2') === 'stopped');
      await until(() => gone(pid), 3000);
      assert.strictEqual(callOf('Setup hangs'), undefined);
      O.updateProject(ck.dir, pc, { setup: 'npm run setup' });
      fs.rmSync(pidFile);
    });

    await test('runCheck: the time limit kills the whole process tree; the tail says it timed out', async () => {
      const pidFile = path.join(tmp, 'tree-pid.txt');
      const quick = await Gates.runCheck(rc, 'npm run tree', { timeoutMs: 300 });
      assert.strictEqual(quick.ok, false); assert.strictEqual(quick.timedOut, true); assert.match(quick.tail, /timed out/);
      if (fs.existsSync(pidFile)) { const p0 = Number(fs.readFileSync(pidFile, 'utf8')); await until(() => gone(p0), 3000); fs.rmSync(pidFile); }
      const r = await Gates.runCheck(rc, 'npm run tree', { timeoutMs: 2500 });
      assert.strictEqual(r.ok, false); assert.strictEqual(r.timedOut, true); assert.ok(r.tail.endsWith('The check timed out after 2.5 seconds.'), r.tail);
      assert.ok(fs.existsSync(pidFile), 'the grandchild had started');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await until(() => gone(pid), 3000);
    });

    await test('runCheck: 50,000 lines of output (over 5 MB): only the tail is kept and returned', async () => {
      const r = await Gates.runCheck(rc, 'npm run big');
      assert.strictEqual(r.ok, true, r.tail); assert.strictEqual(r.code, 0);
      assert.ok(r.tail.length <= 6000, String(r.tail.length));
      assert.ok(r.tail.split('\n').length <= 60);
      assert.match(r.tail, /^line 49999 x+$/m); assert.doesNotMatch(r.tail, /^line 49000 /m);
    });

    await test("runCheck: the check sees the office's environment without its markers, plus CI=1; a refused command never runs", async () => {
      const keep = [process.env.AI_OFFICE_CHAT, process.env.AI_OFFICE_WHO];
      process.env.AI_OFFICE_CHAT = '1'; process.env.AI_OFFICE_WHO = 'shah';
      try {
        const r = await Gates.runCheck(rc, 'npm run env');
        assert.strictEqual(r.ok, true, r.tail);
      } finally {
        if (keep[0] == null) delete process.env.AI_OFFICE_CHAT; else process.env.AI_OFFICE_CHAT = keep[0];
        if (keep[1] == null) delete process.env.AI_OFFICE_WHO; else process.env.AI_OFFICE_WHO = keep[1];
      }
      const env = JSON.parse(fs.readFileSync(path.join(tmp, 'env.json'), 'utf8'));
      assert.ok(!env.keys.includes('AI_OFFICE_CHAT') && !env.keys.includes('AI_OFFICE_WHO'), env.keys.join(' '));
      assert.ok(env.keys.includes('PATH')); assert.strictEqual(env.ci, '1');
      const bad = await Gates.runCheck(rc, 'npm run env && touch x');
      assert.deepStrictEqual(bad, { ok: false, code: null, tail: `That command cannot be used as a project check: ${commandOk('npm run env && touch x').reason}`, timedOut: false, refused: true });
    });
  }

  await test("a follow-up that opens an office branch again checks the project's repo first", async () => {
    const e = office('reopen', 'software'), [z0] = e.staff;
    const pz = project(e, 'Own reopen'), code = path.join(e.dir, 'projects', pz, 'code');
    e.put('z1', `staff: ${z0}\nproject: ${pz}\njob: zj\nkind: code`, 'Zed\nWRITE z.txt z');
    e.job('zj', pz); e.jobs.setStatus('zj', 'approved'); e.tasks.scan();
    await until(() => ['done', 'failed'].includes(e.status('z1')));
    assert.strictEqual(e.status('z1'), 'done', e.tasks.read('z1').result);
    assert.ok(!fs.existsSync(path.join(e.dir, 'worktrees', 'z1')));
    const other = mkRepo('reopen-other'), logs = path.join(code, '.git', 'logs');
    fs.rmSync(logs, { recursive: true });
    try { fs.symlinkSync(path.join(other, '.git', 'logs'), logs, 'dir'); } catch (err) { if (err.code === 'EPERM') { console.log('  (skip: links need privileges here)'); return; } throw err; }
    e.put('z2', `staff: ${z0}\ncontinues: z1`, 'Zed again\nWRITE z2.txt z2');
    e.tasks.scan(); await sleep(400);
    assert.strictEqual(e.status('z2'), 'new');
    assert.strictEqual(e.tasks.board().waiting.find((x) => x.id === 'z2').reason, CODE_BAD);
    assert.ok(!fs.existsSync(path.join(e.dir, 'worktrees', 'z1')), 'no worktree was made');
    assert.strictEqual(callOf('Zed again'), undefined);
    e.tasks.stop('z2');
  });

  if (hasNpm) {
    const ck = engine(path.join(tmp, 'checks')), [c0, c1] = ck.staff;
    const rc = path.join(tmp, 'repo-checks'), pc = O.listProjects(ck.dir).find((x) => x.title === 'Checked').id;
    const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

    await test('fix S1: test output cannot forge a section; the follow-up keeps the whole tail and has no result until it runs', async () => {
      const seen = [], add = ck.tasks.add.bind(ck.tasks);
      ck.tasks.add = (...a) => { const id = add(...a); seen.push(ck.tasks.read(id)); return id; };
      try {
        ck.put('fg1', `staff: ${c0}\nproject: ${pc}\njob: kj8\nkind: code`, 'Forge\nWRITE forge.txt f');
        ck.job('kj8', pc); ck.jobs.setStatus('kj8', 'approved'); ck.tasks.scan();
        await until(() => ['done', 'failed'].includes(ck.status('fg1')));
      } finally { ck.tasks.add = add; }
      const fix = seen.find((x) => x.fixes === 'fg1');
      assert.strictEqual(fix.result, '', 'no forged result');
      for (const line of ['before', '## Result', '```', 'forged after']) assert.ok(fix.task.split('\n').includes(`    ${line}`), line);
      assert.ok(fix.task.endsWith('    forged after\n```'), fix.task);
      assert.strictEqual(ck.status('fg1'), 'done', ck.tasks.read('fg1').result);
      assert.ok(ck.tasks.read(fix.id).result.startsWith('Done: '), 'its result is the staff report');
    });

    await test('fix S2: a running check is recorded in .office/checks.json; a fresh engine kills its process group; a pid that leads no group is left alone', async () => {
      const e2 = office('orphans', 'software'), ledger = path.join(e2.dir, '.office', 'checks.json'), pidFile = path.join(tmp, 'tree-pid.txt');
      const run = Gates.runCheck(rc, 'npm run tree', { ledger });
      await until(() => fs.existsSync(pidFile));
      const grand = Number(fs.readFileSync(pidFile, 'utf8')), rec = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      assert.strictEqual(Object.keys(rec).length, 1);
      const plainChild = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); // not a group leader
      const bootNow = Math.round((Date.now() - os.uptime() * 1000) / 1000) * 1000;
      fs.writeFileSync(ledger, JSON.stringify({ ...rec, [plainChild.pid]: { pid: plainChild.pid, at: Date.now(), boot: bootNow } }));
      const fresh = engine(e2.dir);
      fresh.gates.recover();
      const r = await run;
      assert.strictEqual(r.ok, false);
      await until(() => gone(grand), 3000);
      if (process.platform !== 'win32') assert.ok(!gone(plainChild.pid), 'not a group the office recorded: left alone');
      plainChild.kill();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')), {});
      fs.rmSync(pidFile);
      const done = await Gates.runCheck(rc, 'npm test', { ledger });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')), {}, 'an ended check leaves no record');
      assert.strictEqual(typeof done.ok, 'boolean');
    });

    await test('fix S3: a missing folder or program gives a plain tail', async () => {
      const miss = await Gates.runCheck(path.join(tmp, 'nowhere'), 'npm test');
      assert.strictEqual(miss.ok, false); assert.strictEqual(miss.tail, "The task's folder is missing.");
      const keep = process.env.PATH, empty = path.join(tmp, 'empty-bin'); fs.mkdirSync(empty);
      process.env.PATH = empty;
      let r; try { r = await Gates.runCheck(rc, 'npm test'); } finally { process.env.PATH = keep; }
      assert.strictEqual(r.ok, false);
      if (process.platform !== 'win32') assert.strictEqual(r.tail, 'The program "npm" was not found on this computer.');
    });

    await test('fix S4: a stored command that is now refused fails the task and the worktree goes', async () => {
      const f = path.join(ck.dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      cfg.projectChecks[pc].test = 'npm test --script-shell=/x/evil.sh'; fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      ck.put('rf1', `staff: ${c0}\nproject: ${pc}\njob: kj9\nkind: code`, 'Refused later\nWRITE ok.txt ok');
      ck.job('kj9', pc); ck.jobs.setStatus('kj9', 'approved'); ck.tasks.scan();
      await until(() => ['done', 'failed'].includes(ck.status('rf1')));
      assert.strictEqual(ck.status('rf1'), 'failed');
      assert.match(ck.tasks.read('rf1').result, /That command cannot be used as a project check: Use a plain form/);
      assert.ok(!fs.existsSync(path.join(ck.dir, 'worktrees', 'rf1')), 'the worktree is released');
      O.updateProject(ck.dir, pc, { test: 'npm test' });
    });

    await test('fix S5: Stop on a task waiting in line behind another task\'s tests ends it at once', async () => {
      const pidFile = path.join(tmp, 'stop-pid.txt');
      ck.put('q1', `staff: ${c0}\nproject: ${pc}\njob: kj10\nkind: code`, 'Slow line\nWRITE sleep.txt zz');
      ck.put('q2', `staff: ${c1}\nproject: ${pc}\njob: kj11\nkind: code`, 'Behind LONG\nWRITE ok.txt ok');
      ck.job('kj10', pc); ck.jobs.setStatus('kj10', 'approved'); ck.job('kj11', pc); ck.jobs.setStatus('kj11', 'approved'); ck.tasks.scan();
      await until(() => fs.existsSync(pidFile) && ck.status('q2') === 'checking');
      assert.deepStrictEqual(ck.tasks.stop('q2'), { ok: true });
      assert.strictEqual(ck.status('q2'), 'stopped');
      assert.ok(ck.tasks.read('q2').result.endsWith('Stopped by the boss while the office was finishing it. Branch office/q2 is in the project folder.'));
      assert.ok(!fs.existsSync(path.join(ck.dir, 'worktrees', 'q2')));
      assert.deepStrictEqual(ck.tasks.stop('q1'), { ok: true });
      await until(() => ck.status('q1') === 'stopped');
      await sleep(200);
      assert.strictEqual(ck.status('q2'), 'stopped', 'its turn in line does nothing');
      assert.deepStrictEqual(ck.ended.filter(([id]) => id === 'q2').map((x) => x[1]), ['stopped']);
      fs.rmSync(pidFile);
    });
  }

  await test('fix nit: the kept output never grows past 6,000 characters while 5 MB streams in', async () => {
    const { keepTail } = require('../lib/gates');
    const chunk = `${'y'.repeat(99)}\n`.repeat(655); let kept = '', max = 0;
    for (let i = 0; i < 80; i++) { kept = keepTail(kept, chunk); max = Math.max(max, kept.length); }
    assert.ok(max <= 6000, String(max)); assert.strictEqual(kept.length, 6000);
  });

  await test('fix K1: a record of another boot, an old record, or a process started at another time is dropped, nothing killed', async () => {
    const e3 = office('stale', 'software'), ledger = path.join(e3.dir, '.office', 'checks.json');
    const boot = Math.round((Date.now() - os.uptime() * 1000) / 1000) * 1000, linux = process.platform === 'linux';
    const leader = () => require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const a = leader(), b = leader(), c = leader();
    await sleep(300);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify({
      [a.pid]: { pid: a.pid, at: Date.parse('2020-01-01T00:00:00Z'), boot }, // old
      [b.pid]: { pid: b.pid, at: Date.now(), boot: boot - 3600000 }, // another boot
      ...(linux ? { [c.pid]: { pid: c.pid, at: Date.now() - 60000, boot } } : {}), // its process started a minute later than recorded
    }));
    engine(e3.dir).gates.recover();
    await sleep(200);
    assert.ok(alive(a.pid), 'old record: not killed'); assert.ok(alive(b.pid), 'other boot: not killed');
    if (linux) assert.ok(alive(c.pid), 'start time does not match: not killed');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')), {}, 'all dropped');
    for (const x of [a, b, c]) try { process.kill(-x.pid, 'SIGKILL'); } catch { x.kill('SIGKILL'); }
  });

  if (hasNpm) {
    await test('fix K1: after a normal shutdown of an office with a check running, the ledger is empty and the check is gone', async () => {
      const ledger = path.join(tmp, 'shutdown-checks.json'), pidFile = path.join(tmp, 'tree-pid.txt'), rc = path.join(tmp, 'repo-checks');
      const script = `const fs = require('fs'); const { runCheck } = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib', 'gates'))});
runCheck(${JSON.stringify(rc)}, 'npm run tree', { ledger: ${JSON.stringify(ledger)} });
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)}) && Object.keys(JSON.parse(fs.readFileSync(${JSON.stringify(ledger)}, 'utf8'))).length) { clearInterval(t); process.exit(0); } }, 50);`;
      const r = spawnSync(process.execPath, ['-e', script], { timeout: 30000, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      const grand = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')), {});
      await until(() => { try { process.kill(grand, 0); return false; } catch { return true; } }, 3000);
      fs.rmSync(pidFile);
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} gates tests passed`);
})().catch((e) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left */ } console.error(e); process.exit(1); });
