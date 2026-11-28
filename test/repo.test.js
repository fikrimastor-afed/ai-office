// The office's git helper, against real git in the temp folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (spawnSync('git', ['--version']).status !== 0) { console.log('skip: git is not installed'); process.exit(0); }
const R = require('../lib/repo');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-repo-'));
let n = 0;
const test = (name, fn) => { fn(); console.log(`ok ${++n} ${name}`); };
const G = (cwd, ...a) => { const r = R.git(cwd, a); assert(r.ok, `git ${a.join(' ')}: ${r.err}`); return r.out; };
const mk = (name) => {
  const d = path.join(tmp, name); fs.mkdirSync(d);
  G(d, 'init'); G(d, 'config', 'user.name', 't'); G(d, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\nthree\n'); G(d, 'add', '-A'); G(d, 'commit', '-m', 'first');
  return d;
};

try {
  test('ensureRepo makes a repo with one commit, and changes nothing on an existing one', () => {
    const d = path.join(tmp, 'new folder');
    assert.deepStrictEqual(R.ensureRepo(d), { ok: true, created: true });
    assert.strictEqual(G(d, 'rev-list', '--count', 'HEAD'), '1');
    const head = G(d, 'rev-parse', 'HEAD');
    assert.deepStrictEqual(R.ensureRepo(d), { ok: true, created: false });
    assert.strictEqual(G(d, 'rev-parse', 'HEAD'), head);
  });

  test('state: untracked is not clean, detached, no commits', () => {
    const d = mk('st');
    let s = R.state(d);
    assert(s.ok && s.clean && s.hasCommits && !s.detached && s.branch);
    fs.writeFileSync(path.join(d, 'new.txt'), 'x');
    assert.strictEqual(R.state(d).clean, false);
    G(d, 'checkout', '--detach');
    s = R.state(d);
    assert(s.detached && s.branch === '');
    const e = path.join(tmp, 'empty'); fs.mkdirSync(e); G(e, 'init');
    assert.strictEqual(R.state(e).hasCommits, false);
  });

  test('worktree commit merges into a job branch without touching the checkout', () => {
    const d = mk('mg');
    const base = R.state(d).branch;
    assert(R.createBranch(d, 'office/job1', base).ok);
    assert.strictEqual(R.state(d).branch, base, 'createBranch does not check out');
    const wt = path.join(tmp, 'wt1');
    assert(R.addWorktree(d, wt, 'office/t1', 'office/job1').ok);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'new');
    assert.deepStrictEqual(R.commitAll(wt, 'add b'), { ok: true, committed: true });
    assert.deepStrictEqual(R.commitAll(wt, 'again'), { ok: true, committed: false });
    const head = G(d, 'rev-parse', 'HEAD'), file = fs.readFileSync(path.join(d, 'a.txt'), 'utf8');
    const m = R.merge(d, 'office/job1', 'office/t1');
    assert(m.ok, m.err);
    assert.strictEqual(G(d, 'show', 'office/job1:b.txt'), 'new');
    assert.strictEqual(G(d, 'rev-parse', 'HEAD'), head);
    assert.strictEqual(R.state(d).branch, base);
    assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), file);
    assert(!fs.existsSync(path.join(d, 'b.txt')), 'working files untouched');
    assert.strictEqual(R.listWorktrees(d).length, 2, 'temporary merge worktree is gone');
    assert(R.merge(d, base, 'office/t1').err.includes('checked out'), 'user branch refused');
  });

  test('a conflict is reported and the job branch stays put', () => {
    const d = mk('cf');
    const base = R.state(d).branch;
    R.createBranch(d, 'office/job', base);
    const w1 = path.join(tmp, 'cw1'), w2 = path.join(tmp, 'cw2');
    assert(R.addWorktree(d, w1, 'office/c1', 'office/job').ok);
    assert(R.addWorktree(d, w2, 'office/c2', 'office/job').ok);
    fs.writeFileSync(path.join(w1, 'a.txt'), 'one\nAAA\nthree\n'); R.commitAll(w1, 'a');
    fs.writeFileSync(path.join(w2, 'a.txt'), 'one\nBBB\nthree\n'); R.commitAll(w2, 'b');
    assert(R.merge(d, 'office/job', 'office/c1').ok);
    const after = G(d, 'rev-parse', 'office/job');
    const m = R.merge(d, 'office/job', 'office/c2');
    assert.strictEqual(m.ok, false); assert.strictEqual(m.conflict, true);
    assert.deepStrictEqual(m.files, ['a.txt']);
    assert.strictEqual(G(d, 'rev-parse', 'office/job'), after);
  });

  test('removeWorktree removes the folder and the entry, and refuses foreign folders', () => {
    const d = mk('rm');
    const wt = path.join(tmp, 'rmwt');
    assert(R.addWorktree(d, wt, 'office/r1', R.state(d).branch).ok);
    assert(R.listWorktrees(d).some((w) => w.branch === 'office/r1'));
    assert(R.removeWorktree(d, wt).ok);
    assert(!fs.existsSync(wt));
    assert(!R.listWorktrees(d).some((w) => w.branch === 'office/r1'));
    const other = path.join(tmp, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
    assert.strictEqual(R.removeWorktree(d, other).ok, false);
    assert(fs.existsSync(path.join(other, 'keep.txt')), 'a non-worktree folder is never deleted');
    // unregistered but still pointing into this repo
    const wt2 = path.join(tmp, 'rmwt2');
    assert(R.addWorktree(d, wt2, 'office/r2', R.state(d).branch).ok);
    fs.rmSync(path.join(d, '.git', 'worktrees'), { recursive: true, force: true });
    assert(R.removeWorktree(d, wt2).ok);
    assert(!fs.existsSync(wt2));
  });

  test('bad ids and bases are refused before git runs', () => {
    const nowhere = path.join(tmp, 'does', 'not', 'exist');
    for (const id of ['x; rm -rf y', '../x', '-D', '', 'a..b', 'a.lock', 'a.', 'a b']) {
      const name = `office/${id}`;
      for (const r of [R.createBranch(nowhere, name, 'main'), R.addWorktree(nowhere, path.join(tmp, 'zz'), name, 'main'), R.push(nowhere, name)]) {
        assert.strictEqual(r.ok, false, id); assert(!/not found/.test(r.err), `git ran for ${id}`);
      }
    }
    assert.strictEqual(R.createBranch(nowhere, 'main', 'main').ok, false, 'not an office/ name');
    assert.strictEqual(R.createBranch(nowhere, 'office/ok', '-D').ok, false);
    assert.strictEqual(R.branchExists(nowhere, '-D'), false);
    assert.strictEqual(R.git(nowhere, ['status']).ok, false, 'missing cwd returns, not throws');
  });

  test('push goes to origin only; no origin fails', () => {
    const d = mk('ps');
    R.createBranch(d, 'office/p', R.state(d).branch);
    assert.strictEqual(R.hasRemote(d, 'origin'), false);
    assert.strictEqual(R.push(d, 'office/p').ok, false);
    const bare = path.join(tmp, 'bare.git'); fs.mkdirSync(bare); G(bare, 'init', '--bare');
    G(d, 'remote', 'add', 'origin', bare);
    assert.strictEqual(R.hasRemote(d, 'origin'), true);
    const r = R.push(d, 'office/p');
    assert(r.ok, r.err);
    assert(G(bare, 'branch', '--list', 'office/p'));
    assert.strictEqual(R.push(d, 'main').ok, false, 'only office/ branches');
  });

  test('diffStat shows the changed files', () => {
    const d = mk('ds');
    const base = R.state(d).branch;
    const wt = path.join(tmp, 'dswt');
    R.addWorktree(d, wt, 'office/d', base);
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c'); R.commitAll(wt, 'c');
    assert(R.diffStat(d, base, 'office/d').includes('c.txt'));
    assert.strictEqual(R.diffStat(d, '-x', 'office/d'), '');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${n} repo tests passed`);
