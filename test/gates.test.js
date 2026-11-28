// One branch per coding task: worktrees, the job's branch, merges by the office. Real git in the temp folder,
// a fake "claude" driven by words in the task text:
//   WRITE <file> <text>   write and commit that file in the worktree named in the prompt
//   LEAVE <file> <text>   write it without committing
//   STUBBORN              the session never fixes a merge conflict
//   LONG                  takes longer
//   SWITCH <branch>       switches the worktree to a new branch
//   SWAP <folder>         replaces the worktree with a link to that folder and writes x.txt there
// A prompt asking to "run git merge office/<job>" makes it merge and resolve the conflict ("resolved").
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
const sid = resume || (msg.includes('STUBBORN') ? 'stubborn-' : 'sess-') + Date.now() + '-' + process.pid;
out({ type: 'system', subtype: 'init', session_id: sid });
const m = /Work only in (.+?)\\. It is its own copy/.exec(msg), wt = m ? m[1] : '';
const g = (...x) => spawnSync('git', ['-C', wt, ...x], { encoding: 'utf8' });
setTimeout(() => {
  if (wt) {
    for (const [, how, file, text] of msg.matchAll(/^(WRITE|LEAVE) (\\S+) (.*)$/gm)) {
      fs.writeFileSync(path.join(wt, file), text + '\\n');
      if (how === 'WRITE') { g('add', '-A'); g('commit', '-m', 'write ' + file); }
    }
    const sw = /^SWITCH (\\S+)$/m.exec(msg); if (sw) g('checkout', '-q', '-b', sw[1]);
    const swap = /^SWAP (.+)$/m.exec(msg); if (swap) { fs.rmSync(wt, { recursive: true, force: true }); fs.symlinkSync(swap[1], wt, 'dir'); fs.writeFileSync(path.join(swap[1], 'x.txt'), 'x'); }
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
}, msg.includes('LONG') ? 2000 : 300);
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
function engine(dir, extra = {}) {
  const loadCfg = () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8'));
  const e = { dir, said: [], ended: [], seen: [] };
  e.jobs = new Jobs(dir, { tasks: () => e.tasks.list(), onChange: (j) => { if (j.status === 'approved') e.gates.jobApproved(j.id); } });
  e.gates = new Gates({ dir, loadCfg, jobOf: (id) => e.jobs.get(id), say: (t) => e.said.push(t) });
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
function office(name, type) {
  const dir = path.join(tmp, name);
  G.writeOffice(dir, G.buildConfig({ company: 'Acme', pa: 'Hana', type, staff: (type === 'software' ? D.SOFTWARE_STAFF : D.STAFF).slice(0, 3).map(({ name: n, role, job }) => ({ name: n, role, job })) }));
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  return engine(dir);
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
    assert.ok(soft2.tasks.read('w1').result.endsWith(`The work is on branch feature, not office/w1. Nothing was merged. The worktree is still at ${wt}.`), soft2.tasks.read('w1').result);
    assert.ok(fs.existsSync(path.join(wt, 's.txt')));
    assert.strictEqual(show(r2, 'office/q4:s.txt'), null);
    assert.strictEqual(git(r2, 'rev-parse', 'feature'), git(r2, 'rev-parse', 'office/q4'), 'nothing committed onto feature');
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
    assert.ok(reg.w1, 'a failed task whose worktree is still there is kept');
    if (!canLink) return console.log('  (skip: links need privileges here)');
    const root = path.join(soft2.dir, 'worktrees'), bak = path.join(soft2.dir, 'wt-bak');
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
    fs.unlinkSync(root); fs.renameSync(bak, root);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} gates tests passed`);
})().catch((e) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left */ } console.error(e); process.exit(1); });
