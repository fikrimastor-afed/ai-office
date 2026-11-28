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
const root = path.join(tmp, 'root'); fs.mkdirSync(root);
const W = (name) => path.join(root, name);
const test = (name, fn) => { n++; try { fn(); console.log(`ok ${n} ${name}`); } catch (e) { console.log(`FAIL ${n} ${name}: ${e.message.split('\n')[0]}`); process.exitCode = 1; } };
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
    const wt = W('wt1');
    assert(R.addWorktree(d, wt, 'office/t1', 'office/job1', root).ok);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'new');
    assert.deepStrictEqual(R.commitAll(d, wt, 'office/t1', root, 'add b'), { ok: true, committed: true });
    assert.deepStrictEqual(R.commitAll(d, wt, 'office/t1', root, 'again'), { ok: true, committed: false });
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
    const w1 = W('cw1'), w2 = W('cw2');
    assert(R.addWorktree(d, w1, 'office/c1', 'office/job', root).ok);
    assert(R.addWorktree(d, w2, 'office/c2', 'office/job', root).ok);
    fs.writeFileSync(path.join(w1, 'a.txt'), 'one\nAAA\nthree\n'); R.commitAll(d, w1, 'office/c1', root, 'a');
    fs.writeFileSync(path.join(w2, 'a.txt'), 'one\nBBB\nthree\n'); R.commitAll(d, w2, 'office/c2', root, 'b');
    assert(R.merge(d, 'office/job', 'office/c1').ok);
    const after = G(d, 'rev-parse', 'office/job');
    const m = R.merge(d, 'office/job', 'office/c2');
    assert.strictEqual(m.ok, false); assert.strictEqual(m.conflict, true);
    assert.deepStrictEqual(m.files, ['a.txt']);
    assert.strictEqual(G(d, 'rev-parse', 'office/job'), after);
  });

  test('bad ids and bases are refused before git runs', () => {
    const nowhere = path.join(tmp, 'does', 'not', 'exist');
    for (const id of ['x; rm -rf y', '../x', '-D', '', 'a..b', 'a.lock', 'a.', 'a b', 'HEAD']) {
      const name = `office/${id}`;
      for (const r of [R.createBranch(nowhere, name, 'main'), R.addWorktree(nowhere, path.join(root, 'zz'), name, 'main', root), R.push(nowhere, name)]) {
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
    const wt = W('dswt');
    R.addWorktree(d, wt, 'office/d', base, root);
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c'); R.commitAll(d, wt, 'office/d', root, 'c');
    assert(R.diffStat(d, base, 'office/d').includes('c.txt'));
    assert.strictEqual(R.diffStat(d, '-x', 'office/d'), '');
  });

  // a repo with uncommitted edits, an untracked file and one stash entry
  const dirty = (name) => {
    const d = mk(name);
    fs.writeFileSync(path.join(d, 'a.txt'), 'stashed\n'); G(d, 'stash');
    fs.writeFileSync(path.join(d, 'a.txt'), 'edited\n'); fs.writeFileSync(path.join(d, 'u.txt'), 'untracked');
    return d;
  };
  const snap = (d) => JSON.stringify([G(d, 'rev-parse', 'HEAD'), G(d, 'symbolic-ref', 'HEAD'), G(d, 'status', '--porcelain'), fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), G(d, 'stash', 'list')]);

  test('every function leaves a dirty checkout exactly as it was', () => {
    const d = dirty('dirty'); const before = snap(d); const base = R.state(d).branch;
    const bare = path.join(tmp, 'dbare.git'); fs.mkdirSync(bare); G(bare, 'init', '--bare');
    const same = (what) => assert.strictEqual(snap(d), before, what);
    R.git(d, ['status']); same('git');
    R.isRepo(d); same('isRepo'); R.state(d); same('state'); R.ensureRepo(d); same('ensureRepo');
    R.branchExists(d, 'office/z'); same('branchExists');
    assert(R.createBranch(d, 'office/dj', base).ok); same('createBranch');
    const wt = W('dirtywt');
    assert(R.addWorktree(d, wt, 'office/dt', 'office/dj', root).ok); same('addWorktree');
    R.listWorktrees(d); same('listWorktrees');
    fs.writeFileSync(path.join(wt, 'n.txt'), 'n');
    assert(R.commitAll(d, wt, 'office/dt', root, 'n').ok); same('commitAll');
    assert(R.merge(d, 'office/dj', 'office/dt').ok); same('merge');
    R.diffStat(d, base, 'office/dj'); same('diffStat');
    G(d, 'remote', 'add', 'origin', bare); R.hasRemote(d, 'origin'); same('hasRemote');
    assert(R.push(d, 'office/dj').ok); same('push');
    assert(R.removeWorktree(d, wt, root).ok); same('removeWorktree');
    R.prune(d); same('prune');
    assert(fs.existsSync(path.join(d, 'u.txt')));
  });

  test('removeWorktree never deletes the project, user worktrees, other folders or link targets', () => {
    const d = dirty('safe'); const before = snap(d);
    const base = R.state(d).branch;
    const intact = () => { assert.strictEqual(snap(d), before); assert(fs.existsSync(path.join(d, 'u.txt'))); };
    for (const x of [d, d + path.sep, path.join(d, '.')]) { assert.strictEqual(R.removeWorktree(d, x, root).ok, false, x); intact(); }
    // a worktree the user made on their own branch, inside and outside root
    G(d, 'branch', 'feature');
    const inFeature = W(path.join('nest', 'userwt')), outFeature = path.join(tmp, 'userwt-out'); // inside root, but not a direct child: the user's
    G(d, 'worktree', 'add', inFeature, 'feature');
    G(d, 'branch', 'feature2');
    G(d, 'worktree', 'add', outFeature, 'feature2');
    fs.writeFileSync(path.join(inFeature, 'work.txt'), 'precious'); fs.writeFileSync(path.join(outFeature, 'work.txt'), 'precious');
    assert.strictEqual(R.removeWorktree(d, inFeature, root).ok, false);
    assert.strictEqual(R.removeWorktree(d, outFeature, root).ok, false);
    assert(fs.existsSync(path.join(inFeature, 'work.txt')) && fs.existsSync(path.join(outFeature, 'work.txt')));
    assert(R.listWorktrees(d).some((w) => w.branch === 'feature'));
    // a different spelling of a folder outside root
    fs.mkdirSync(path.join(tmp, 'plain-wt')); fs.writeFileSync(path.join(tmp, 'plain-wt', 'k'), 'k');
    assert.strictEqual(R.removeWorktree(d, path.join(tmp, 'PLAIN-wt'), root).ok, false);
    assert(fs.existsSync(path.join(tmp, 'plain-wt', 'k')));
    // a planted .git file outside root
    const planted = path.join(tmp, 'planted'); fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, '.git'), `gitdir: ${path.join(d, '.git', 'worktrees', 'x')}\n`); fs.writeFileSync(path.join(planted, 'k'), 'k');
    assert.strictEqual(R.removeWorktree(d, planted, root).ok, false);
    assert(fs.existsSync(path.join(planted, 'k')));
    // the same planted file inside root counts as a plain leftover folder, but a relative path or root itself is refused
    assert.strictEqual(R.removeWorktree(d, root, root).ok, false); assert(fs.existsSync(root));
    assert.strictEqual(R.removeWorktree(d, 'root/x', root).ok, false);
    // a symlink inside root pointing outside: the target survives
    const target = path.join(tmp, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'k'), 'k');
    let linked = true;
    try { fs.symlinkSync(target, W('lnk'), 'dir'); } catch { linked = false; }
    if (linked) { assert.strictEqual(R.removeWorktree(d, W('lnk'), root).ok, false); assert(fs.existsSync(path.join(target, 'k'))); }
    intact();
    // a genuine office worktree, registered, and a leftover folder git no longer knows
    // root holding a user worktree is refused whole (above); a clean root works
    const root2 = path.join(tmp, 'root2'); fs.mkdirSync(root2);
    const ow = path.join(root2, 'ox');
    assert(R.addWorktree(d, ow, 'office/x', base, root2).ok);
    assert(R.removeWorktree(d, ow, root2).ok);
    assert(!fs.existsSync(ow) && !R.listWorktrees(d).some((w) => w.branch === 'office/x'));
    const left = path.join(root2, 'left'); fs.mkdirSync(left); fs.writeFileSync(path.join(left, 'f'), 'f');
    assert(R.removeWorktree(d, left, root2).ok); assert(!fs.existsSync(left));
    intact();
  });

  test('case: a registered worktree survives a different spelling', () => {
    const d = mk('case'); const base = R.state(d).branch;
    fs.writeFileSync(path.join(root, 'ci_a'), '');
    const insensitive = fs.existsSync(path.join(root, 'CI_A'));
    fs.rmSync(path.join(root, 'ci_a'));
    assert(R.addWorktree(d, W('UP'), 'office/up', base, root).ok);
    fs.mkdirSync(W('up2')); fs.writeFileSync(W('up2') + '/k', 'k');
    R.removeWorktree(d, W('up'), root);
    if (!insensitive) assert(R.listWorktrees(d).some((w) => w.branch === 'office/up'), 'UP is still registered');
    assert(fs.existsSync(W('up2') + '/k'));
  });

  test('no hooks and no fsmonitor run', () => {
    const d = mk('hooks');
    const marks = path.join(tmp, 'marks'); fs.mkdirSync(marks);
    const sh = (name) => `#!/bin/sh\necho x > "${path.join(marks, name)}"\n`;
    if (process.platform !== 'win32') for (const h of ['pre-push', 'pre-commit', 'post-checkout', 'post-merge', 'post-commit', 'commit-msg', 'pre-merge-commit']) {
      const f = path.join(d, '.git', 'hooks', h); fs.writeFileSync(f, sh(h)); fs.chmodSync(f, 0o755);
    }
    if (process.platform !== 'win32') {
      const fm = path.join(tmp, 'fsm.sh'); fs.writeFileSync(fm, sh('fsmonitor')); fs.chmodSync(fm, 0o755);
      G(d, 'config', 'core.fsmonitor', fm);
      spawnSync('git', ['status'], { cwd: d }); // sanity: it would run
      assert(fs.existsSync(path.join(marks, 'fsmonitor')), 'the test setup fires fsmonitor');
      fs.rmSync(path.join(marks, 'fsmonitor'));
      R.state(d); assert(!fs.existsSync(path.join(marks, 'fsmonitor')), 'state runs no fsmonitor');
      G(d, 'config', '--unset', 'core.fsmonitor');
    }
    const base = R.state(d).branch;
    R.createBranch(d, 'office/h', base);
    const wt = W('hookwt'), wt2 = W('hookwt2');
    assert(R.addWorktree(d, wt, 'office/h1', 'office/h', root).ok);
    assert(R.addWorktree(d, wt2, 'office/h2', 'office/h', root).ok);
    fs.writeFileSync(path.join(wt, 'h.txt'), 'h'); assert(R.commitAll(d, wt, 'office/h1', root, 'h').committed);
    fs.writeFileSync(path.join(wt2, 'g.txt'), 'g'); R.commitAll(d, wt2, 'office/h2', root, 'g');
    assert(R.merge(d, 'office/h', 'office/h1').ok);
    assert(R.merge(d, 'office/h', 'office/h2').ok);
    R.state(d);
    const bare = path.join(tmp, 'hbare.git'); fs.mkdirSync(bare); G(bare, 'init', '--bare'); G(d, 'remote', 'add', 'origin', bare);
    assert(R.push(d, 'office/h').ok);
    assert.deepStrictEqual(fs.readdirSync(marks), []);
  });

  test('merge needs a plain existing local branch and never moves main', () => {
    const d = mk('into'); const base = R.state(d).branch;
    R.createBranch(d, 'office/src', base);
    G(d, 'checkout', '-q', '-b', 'other');
    const head = G(d, 'rev-parse', base);
    const wt = W('intowt'); R.addWorktree(d, wt, 'office/s2', base, root);
    fs.writeFileSync(path.join(wt, 's.txt'), 's'); R.commitAll(d, wt, 'office/s2', root, 's');
    for (const into of [`refs/heads/${base}`, `heads/${base}`, 'HEAD', head, '-x', 'nope', `${base}/../x`]) {
      assert.strictEqual(R.merge(d, into, 'office/s2').ok, false, into);
      assert.strictEqual(G(d, 'rev-parse', base), head, into);
    }
    G(d, 'tag', 'v1'); assert.strictEqual(R.merge(d, 'v1', 'office/s2').ok, false);
    assert.strictEqual(R.merge(d, 'other', 'office/s2').ok, false, 'checked out in the project folder');
    assert(R.merge(d, base, 'office/s2').ok);
    assert.notStrictEqual(G(d, 'rev-parse', base), head, 'a real merge moves the target');
  });

  test('addWorktree needs an absolute, empty folder inside root', () => {
    const d = mk('aw'); const base = R.state(d).branch;
    assert.strictEqual(R.addWorktree(d, '-f', 'office/dd2', base, root).ok, false);
    assert(!fs.existsSync(path.join(d, '-f')));
    assert.strictEqual(R.addWorktree(d, path.join(tmp, 'outside-wt'), 'office/o', base, root).ok, false);
    assert.strictEqual(R.addWorktree(d, root, 'office/o', base, root).ok, false);
    fs.mkdirSync(W('full')); fs.writeFileSync(W('full') + '/k', 'k');
    assert.strictEqual(R.addWorktree(d, W('full'), 'office/o', base, root).ok, false);
    fs.mkdirSync(W('empty'));
    assert(R.addWorktree(d, W('empty'), 'office/e', base, root).ok);
    assert(!R.branchExists(d, 'office/o'));
  });

  test('a folder inside another repo is not a repo; ensureRepo makes its own', () => {
    const d = mk('outer'); const sub = path.join(d, 'projects', 'x', 'code'); fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(R.isRepo(sub), false); assert.strictEqual(R.isRepo(d), true);
    assert.deepStrictEqual(R.ensureRepo(sub), { ok: true, created: true });
    assert(fs.existsSync(path.join(sub, '.git')));
    assert.strictEqual(R.isRepo(sub), true);
    assert(R.state(sub).hasCommits && G(sub, 'rev-parse', '--show-toplevel') === fs.realpathSync(sub));
  });

  test('conflict file names are not quoted', () => {
    const d = mk('uni'); const base = R.state(d).branch;
    fs.writeFileSync(path.join(d, 'café x.txt'), 'a\n'); G(d, 'add', '-A'); G(d, 'commit', '-m', 'u');
    R.createBranch(d, 'office/uj', base); G(d, 'checkout', '-q', '-b', 'side');
    const w1 = W('uw1'), w2 = W('uw2');
    R.addWorktree(d, w1, 'office/u1', 'office/uj', root); R.addWorktree(d, w2, 'office/u2', 'office/uj', root);
    fs.writeFileSync(path.join(w1, 'café x.txt'), '1\n'); R.commitAll(d, w1, 'office/u1', root, '1');
    fs.writeFileSync(path.join(w2, 'café x.txt'), '2\n'); R.commitAll(d, w2, 'office/u2', root, '2');
    assert(R.merge(d, 'office/uj', 'office/u1').ok);
    assert.deepStrictEqual(R.merge(d, 'office/uj', 'office/u2').files, ['café x.txt']);
  });

  test('root is checked: not a file system root, not the project, not a parent, not a link to it', () => {
    const d = dirty('rootchk'); fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'f'), 'f');
    const base = R.state(d).branch; const before = snap(d);
    const link = path.join(tmp, 'rootlink');
    let linked = true; try { fs.symlinkSync(d, link, 'dir'); } catch { linked = false; }
    const calls = [[d + '/src', path.parse(d).root], [d + '/src', d], [d + '/.git', d], [path.join(tmp, 'x1'), tmp]];
    if (linked) calls.push([link + '/src', link]);
    for (const [dir, rt] of calls) {
      assert.strictEqual(R.removeWorktree(d, dir, rt).ok, false, `remove ${dir} in ${rt}`);
      assert.strictEqual(R.addWorktree(d, path.join(rt, 'zz'), 'office/zz', base, rt).ok, false, `add in ${rt}`);
    }
    assert(fs.existsSync(path.join(d, 'src', 'f')) && fs.existsSync(path.join(d, '.git')));
    assert.strictEqual(snap(d), before);
    const ok = W('fine'); assert(R.addWorktree(d, ok, 'office/fine', base, root).ok); assert(R.removeWorktree(d, ok, root).ok);
  });

  test('an unregistered leftover that holds a user worktree is not deleted', () => {
    const d = mk('r2'); G(d, 'branch', 'feature3');
    fs.mkdirSync(W('outer'));
    G(d, 'worktree', 'add', path.join(W('outer'), 'inner'), 'feature3');
    fs.writeFileSync(path.join(W('outer'), 'inner', 'work.txt'), 'precious');
    assert.strictEqual(R.removeWorktree(d, W('outer'), root).ok, false);
    assert(fs.existsSync(path.join(W('outer'), 'inner', 'work.txt')));
  });

  test('planted git settings: changes are refused and nothing runs; reads still work', () => {
    const d = mk('plant'); const base = R.state(d).branch;
    const marks = path.join(tmp, 'pmarks'); fs.mkdirSync(marks);
    R.createBranch(d, 'office/pj', base);
    const wt = W('plantwt'); assert(R.addWorktree(d, wt, 'office/pt', 'office/pj', root).ok);
    const sc = path.join(tmp, 'smudge.sh'); fs.writeFileSync(sc, `#!/bin/sh\necho x > "${path.join(marks, 'smudge')}"\ncat\n`); try { fs.chmodSync(sc, 0o755); } catch { /* win */ }
    fs.writeFileSync(path.join(d, '.gitattributes'), '* filter=x\n'); G(d, 'add', '-A'); G(d, 'commit', '-m', 'attr');
    G(d, 'config', 'filter.x.smudge', sc); G(d, 'config', 'filter.x.clean', 'cat');
    fs.writeFileSync(path.join(wt, 'q.txt'), 'q');
    for (const r of [R.addWorktree(d, W('plant2'), 'office/p2', 'office/pj', root), R.commitAll(d, wt, 'office/pt', root, 'q'), R.merge(d, 'office/pj', 'office/pt'), R.createBranch(d, 'office/p3', base), R.removeWorktree(d, wt, root), R.push(d, 'office/pj')]) {
      assert.strictEqual(r.ok, false); assert(/git settings the office will not run with: .*filter\.x\.smudge/.test(r.err), r.err);
    }
    assert.deepStrictEqual(fs.readdirSync(marks), []);
    assert(R.state(d).ok === false && R.isRepo(d) && R.listWorktrees(d).length && R.branchExists(d, 'office/pj') === true && R.hasRemote(d, 'origin') === false);
    assert.strictEqual(R.diffStat(d, base, 'office/pj'), '');
    G(d, 'config', '--unset-all', 'filter.x.smudge'); G(d, 'config', '--unset-all', 'filter.x.clean');
    G(d, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    assert(R.createBranch(d, 'office/p4', base).ok, 'filter.lfs alone is fine');
    for (const [k, v] of [['remote.origin.proxy', 'http://x'], ['gpg.program', '/bin/true'], ['gpg.ssh.program', '/bin/true'], ['alias.x', '!id'], ['include.path', '/x'], ['merge.m.driver', 'cat']]) {
      G(d, 'config', k, v);
      assert.strictEqual(R.createBranch(d, 'office/p5', base).ok, false, k);
      G(d, 'config', '--unset-all', k);
    }
    assert(R.safeConfig(d).ok);
    G(d, 'config', 'alias.x', 'status');
    assert(R.safeConfig(d).err.includes('alias.x'));
  });

  test('push sends exactly one named branch; pushTarget shows where', () => {
    const d = mk('pushone'); const base = R.state(d).branch;
    const bare = path.join(tmp, 'pbare.git'); fs.mkdirSync(bare); G(bare, 'init', '--bare');
    G(d, 'remote', 'add', 'origin', bare); G(d, 'push', 'origin', base);
    const main = G(bare, 'rev-parse', base);
    R.createBranch(d, 'office/j', base);
    assert(R.push(d, 'office/j').ok);
    assert(G(bare, 'branch', '--list', 'office/j')); assert.strictEqual(G(bare, 'rev-parse', base), main);
    assert.deepStrictEqual(R.pushTarget(d), { ok: true, url: bare });
    assert.strictEqual(R.push(d, 'office/nope').ok, false, 'a branch that does not exist');
  });

  test('the no-hooks folder is private to the process', () => {
    const fixed = path.join(os.tmpdir(), 'ai-office-no-hooks');
    fs.rmSync(fixed, { recursive: true, force: true }); fs.mkdirSync(fixed); fs.writeFileSync(path.join(fixed, 'planted'), 'x');
    try { assert(R.state(mk('nh')).ok, 'a planted file in the predictable folder changes nothing'); }
    finally { fs.rmSync(fixed, { recursive: true, force: true }); }
  });

  test('a file dropped into the no-hooks folder (as git-lfs does) is never run and does not stop git', () => {
    const d = mk('lfs'); const base = R.state(d).branch;
    const marks = path.join(tmp, 'lmarks'); fs.mkdirSync(marks);
    R.createBranch(d, 'office/l', base);
    const wt = W('lfswt'); assert(R.addWorktree(d, wt, 'office/l1', 'office/l', root).ok);
    const f1 = R.git(d, ['config', 'core.hooksPath']).out;
    const hook = path.join(f1, 'pre-commit'); fs.writeFileSync(hook, `#!/bin/sh\necho x > "${path.join(marks, 'pre-commit')}"\n`); try { fs.chmodSync(hook, 0o755); } catch { /* win */ }
    fs.writeFileSync(path.join(wt, 'l.txt'), 'l');
    const c = R.commitAll(d, wt, 'office/l1', root, 'l'); assert(c.ok && c.committed, c.err);
    assert.deepStrictEqual(fs.readdirSync(marks), []);
    const f2 = R.git(d, ['config', 'core.hooksPath']).out;
    assert.notStrictEqual(f2, f1); assert.deepStrictEqual(fs.readdirSync(f2), []);
  });

  test('state refuses a repo with a planted clean filter and runs nothing', () => {
    const d = mk('stf'); const marks = path.join(tmp, 'smarks'); fs.mkdirSync(marks);
    const sc = path.join(tmp, 'clean.sh'); fs.writeFileSync(sc, `#!/bin/sh\necho x > "${path.join(marks, 'clean')}"\ncat\n`); try { fs.chmodSync(sc, 0o755); } catch { /* win */ }
    fs.writeFileSync(path.join(d, 'f.txt'), 'f'); fs.writeFileSync(path.join(d, '.gitattributes'), '*.txt filter=x\n'); G(d, 'add', '-A'); G(d, 'commit', '-m', 'f');
    fs.rmSync(path.join(marks, 'clean'), { force: true });
    G(d, 'config', 'filter.x.clean', sc);
    fs.utimesSync(path.join(d, 'f.txt'), new Date(), new Date(Date.now() + 5000));
    const s = R.state(d);
    assert.strictEqual(s.ok, false); assert(/git settings/.test(s.err)); assert.strictEqual(s.branch, undefined);
    assert.deepStrictEqual(fs.readdirSync(marks), []);
  });

  test('filter.lfs values other than the standard ones are refused; required may be anything', () => {
    const d = mk('lfsv');
    G(d, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f'); G(d, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f'); G(d, 'config', 'filter.lfs.process', 'git-lfs filter-process'); G(d, 'config', 'filter.lfs.required', 'true');
    assert(R.safeConfig(d).ok);
    for (const k of ['clean', 'smudge', 'process']) {
      G(d, 'config', `filter.lfs.${k}`, '/tmp/evil.sh');
      assert(R.safeConfig(d).err.includes(`filter.lfs.${k}`), k);
      G(d, 'config', `filter.lfs.${k}`, { clean: 'git-lfs clean -- %f', smudge: 'git-lfs smudge -- %f', process: 'git-lfs filter-process' }[k]);
    }
    G(d, 'config', 'filter.lfs.required', '/tmp/evil'); assert(R.safeConfig(d).ok);
  });

  test('Husky, signing and fork-style push settings still work; a signing program is refused', () => {
    const d = mk('husky'); const base = R.state(d).branch;
    const marks = path.join(tmp, 'hmarks'); fs.mkdirSync(marks);
    fs.mkdirSync(path.join(d, '.husky'));
    const hk = path.join(d, '.husky', 'pre-commit'); fs.writeFileSync(hk, `#!/bin/sh\necho x > "${path.join(marks, 'husky')}"\n`); try { fs.chmodSync(hk, 0o755); } catch { /* win */ }
    G(d, 'add', '-A'); G(d, 'commit', '-m', 'husky'); fs.rmSync(path.join(marks, 'husky'), { force: true });
    const b1 = path.join(tmp, 'hb1.git'), b2 = path.join(tmp, 'hb2.git');
    for (const b of [b1, b2]) { fs.mkdirSync(b); G(b, 'init', '--bare'); }
    G(d, 'remote', 'add', 'origin', b1);
    for (const [k, v] of [['core.hooksPath', '.husky'], ['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['user.signingkey', path.join(tmp, 'no-such-key.pub')], ['remote.origin.push', 'refs/heads/*:refs/for/*'], ['remote.origin.pushurl', b2]]) G(d, 'config', k, v);
    assert(R.createBranch(d, 'office/x', base).ok);
    const wt = W('huskywt'); assert(R.addWorktree(d, wt, 'office/hx', 'office/x', root).ok);
    fs.writeFileSync(path.join(wt, 'x.txt'), 'x');
    const c = R.commitAll(d, wt, 'office/hx', root, 'x'); assert(c.ok && c.committed, c.err);
    assert.strictEqual(G(wt, 'log', '-1', '--format=%G?'), 'N', 'unsigned');
    assert(R.merge(d, 'office/x', 'office/hx').ok);
    assert.deepStrictEqual(fs.readdirSync(marks), [], 'no husky hook ran');
    // the caller must show pushTarget() to the boss before pushing: this is where the branch goes
    assert.deepStrictEqual(R.pushTarget(d), { ok: true, url: b2 });
    assert(R.push(d, 'office/x').ok);
    assert.strictEqual(G(b2, 'for-each-ref', '--format=%(refname)'), 'refs/heads/office/x');
    assert.strictEqual(G(b1, 'for-each-ref', '--format=%(refname)'), '');
    G(d, 'config', 'gpg.program', '/bin/true');
    assert(/gpg\.program/.test(R.createBranch(d, 'office/y', base).err));
  });
  test('filter.lfs clean, smudge and process pass only with the standard git-lfs values', () => {
    const d = mk('lfsstd');
    const std = [['clean', 'git-lfs clean -- %f'], ['smudge', 'git-lfs smudge -- %f'], ['smudge', 'git-lfs smudge --skip -- %f'], ['process', 'git-lfs filter-process'], ['process', 'git-lfs filter-process --skip']];
    for (const [k, v] of std) { G(d, 'config', `filter.lfs.${k}`, v); assert(R.safeConfig(d).ok, v); G(d, 'config', '--unset', `filter.lfs.${k}`); }
    const evil = ['git-lfs x; echo y > m', 'git-lfs && x', 'git-lfs process $(touch m)', 'git-lfs clean -- %f; echo evil >> m', 'git-lfs clean -- %f | tee m', 'git-lfs filter-process\necho evil >> m', '/tmp/x.sh', ''];
    for (const k of ['clean', 'smudge', 'process']) {
      for (const v of evil) {
        G(d, 'config', `filter.lfs.${k}`, v);
        const r = R.safeConfig(d); assert(!r.ok && r.err.includes(`filter.lfs.${k}`), `${k}=${JSON.stringify(v)}`);
        G(d, 'config', '--unset', `filter.lfs.${k}`);
      }
    }
    assert(R.safeConfig(d).ok);
  });
  test('an existing office branch opens in a new worktree; checked out, missing or non-office branches are refused', () => {
    const d = dirty('reopen'); const before = snap(d); const base = R.state(d).branch;
    const marks = path.join(tmp, 'remarks'); fs.mkdirSync(marks);
    if (process.platform !== 'win32') for (const h of ['post-checkout', 'pre-commit', 'post-commit']) {
      const f = path.join(d, '.git', 'hooks', h); fs.writeFileSync(f, `#!/bin/sh\necho x > "${path.join(marks, h)}"\n`); fs.chmodSync(f, 0o755);
    }
    const wt = W('rw1'), wt2 = W('rw2'), wt3 = W('rw3');
    assert(R.addWorktree(d, wt, 'office/t1', base, root).ok);
    fs.writeFileSync(path.join(wt, 'r.txt'), 'kept'); assert(R.commitAll(d, wt, 'office/t1', root, 'r').committed);
    const tip = G(wt, 'rev-parse', 'HEAD');
    let r = R.addWorktree(d, wt2, 'office/t1', '', root);
    assert(!r.ok && /checked out/.test(r.err), 'refused while checked out in another worktree');
    assert(!fs.existsSync(wt2) || !fs.readdirSync(wt2).length);
    assert(R.removeWorktree(d, wt, root).ok);
    r = R.addWorktree(d, wt2, 'office/t1', '', root);
    assert(r.ok, r.err);
    assert.strictEqual(G(wt2, 'symbolic-ref', '--short', 'HEAD'), 'office/t1');
    assert.strictEqual(G(wt2, 'rev-parse', 'HEAD'), tip);
    assert.strictEqual(fs.readFileSync(path.join(wt2, 'r.txt'), 'utf8'), 'kept');
    assert(!R.addWorktree(d, wt3, 'office/nope', '', root).ok, 'a branch that does not exist');
    G(d, 'branch', 'feature');
    for (const b of [base, 'feature']) assert(!R.addWorktree(d, wt3, b, '', root).ok, b);
    assert(!R.addWorktree(d, wt3, 'office/t1', undefined, root).ok, 'still checked out (missing from)');
    assert(R.addWorktree(d, wt3, 'office/t2', base, root).ok, 'with a from, a new branch as before');
    assert(!R.addWorktree(d, W('rw4'), 'office/t2', base, root).ok, 'with a from, an existing branch is refused as before');
    assert.strictEqual(snap(d), before, 'the user checkout is unchanged');
    assert.deepStrictEqual(fs.readdirSync(marks), [], 'no hooks ran');
  });
  // A folder link, or null where this platform needs privileges for one (Windows without developer mode).
  const link = (target, at) => { try { fs.symlinkSync(target, at, 'dir'); return true; } catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') return false; throw e; } };
  test('commitAll commits only in a real office worktree of this repo, on its own branch', () => {
    const d = mk('ca'); const base = R.state(d).branch;
    const wt = W('ca1'); assert(R.addWorktree(d, wt, 'office/ca1', base, root).ok);
    fs.writeFileSync(path.join(wt, 'n.txt'), 'n');
    const tip = () => G(d, 'rev-parse', 'office/ca1');
    const t0 = tip();
    const no = (r, what, msg) => { assert(!r.ok, what); if (msg) assert.strictEqual(r.err, msg, what); assert.strictEqual(tip(), t0, `${what}: nothing committed`); };
    no(R.commitAll(d, d, 'office/ca1', root, 'x'), 'the project folder itself');
    no(R.commitAll(d, wt, base, root, 'x'), 'a non-office branch name', 'That branch name is not allowed.');
    fs.mkdirSync(path.join(wt, 'sub')); no(R.commitAll(d, path.join(wt, 'sub'), 'office/ca1', root, 'x'), 'a folder inside the worktree');
    const foreign = W('foreign'); fs.mkdirSync(foreign); G(foreign, 'init', '-q'); G(foreign, 'config', 'user.name', 't'); G(foreign, 'config', 'user.email', 't@t');
    G(foreign, 'checkout', '-q', '-b', 'office/ca1'); fs.writeFileSync(path.join(foreign, 'f.txt'), 'f');
    no(R.commitAll(d, foreign, 'office/ca1', root, 'x'), 'another repo inside root');
    assert(!R.git(foreign, ['rev-parse', '--verify', '-q', 'HEAD']).ok, 'the other repo got no commit');
    G(wt, 'checkout', '-q', '-b', 'feature');
    no(R.commitAll(d, wt, 'office/ca1', root, 'x'), 'a switched branch', 'The work is on branch feature, not office/ca1.');
    assert.strictEqual(G(d, 'rev-parse', 'feature'), t0, 'nothing on feature');
    G(wt, 'checkout', '-q', '--detach');
    no(R.commitAll(d, wt, 'office/ca1', root, 'x'), 'detached', 'The work is on branch no branch, not office/ca1.');
    G(wt, 'checkout', '-q', 'office/ca1');
    if (link(wt, W('calink'))) no(R.commitAll(d, W('calink'), 'office/ca1', root, 'x'), 'a link to the worktree');
    else console.log('  (skip: links need privileges here)');
    const other = mk('caother'), ohead = G(other, 'rev-parse', 'HEAD');
    if (link(other, W('caout'))) { no(R.commitAll(d, W('caout'), 'office/ca1', root, 'x'), 'a link to another repo'); assert.strictEqual(G(other, 'rev-parse', 'HEAD'), ohead); }
    const c = R.commitAll(d, wt, 'office/ca1', root, 'ok'); assert(c.ok && c.committed, c.err);
  });
  test('a root that is a link is refused; the plain delete is only for a real direct child of root', () => {
    const d = mk('lr'); const base = R.state(d).branch;
    const wt = W('lr1'); assert(R.addWorktree(d, wt, 'office/lr1', base, root).ok);
    const deep = W(path.join('deep', 'v1')); fs.mkdirSync(deep, { recursive: true }); fs.writeFileSync(path.join(deep, 'keep.txt'), 'k');
    assert(!R.removeWorktree(d, deep, root).ok); assert(fs.existsSync(path.join(deep, 'keep.txt')), 'a nested folder is not deleted');
    const loose = W('loose'); fs.mkdirSync(loose); fs.writeFileSync(path.join(loose, 'x'), 'x');
    assert(R.removeWorktree(d, loose, root).ok); assert(!fs.existsSync(loose), 'a direct child is still cleaned up');
    const lroot = path.join(tmp, 'lroot');
    if (!link(root, lroot)) { console.log('  (skip: links need privileges here)'); return; }
    assert(!R.addWorktree(d, path.join(lroot, 'lx'), 'office/lx', base, lroot).ok, 'add with a linked root');
    assert(!R.commitAll(d, path.join(lroot, 'lr1'), 'office/lr1', lroot, 'x').ok, 'commit with a linked root');
    assert(!R.removeWorktree(d, path.join(lroot, 'lr1'), lroot).ok, 'remove with a linked root'); assert(fs.existsSync(wt));
    const elsewhere = path.join(tmp, 'elsewhere'); fs.mkdirSync(path.join(elsewhere, 'v1'), { recursive: true }); fs.writeFileSync(path.join(elsewhere, 'v1', 'keep.txt'), 'k');
    const eroot = path.join(tmp, 'eroot'); link(elsewhere, eroot);
    assert(!R.removeWorktree(d, path.join(eroot, 'v1'), eroot).ok); assert(fs.existsSync(path.join(elsewhere, 'v1', 'keep.txt')), 'nothing outside is deleted');
  });
  test("a direct child of root named like a task id is the office's own, whatever branch it is on", () => {
    const d = mk('own'); const base = R.state(d).branch; const before = G(d, 'rev-parse', 'HEAD');
    const e1 = W('e1'); assert(R.addWorktree(d, e1, 'office/e1', base, root).ok);
    G(e1, 'checkout', '-q', '-b', 'feature'); fs.writeFileSync(path.join(e1, 'f.txt'), 'f'); G(e1, 'add', '-A'); G(e1, 'commit', '-q', '-m', 'f');
    const e2 = W('e2'); const r = R.addWorktree(d, e2, 'office/e2', base, root); assert(r.ok, r.err);
    fs.writeFileSync(path.join(e2, 'g.txt'), 'g'); assert(R.commitAll(d, e2, 'office/e2', root, 'g').committed);
    assert(R.removeWorktree(d, e2, root).ok);
    assert(R.removeWorktree(d, e1, root).ok, 'removed whatever its branch'); assert(!fs.existsSync(e1));
    assert.strictEqual(G(d, 'show', 'feature:f.txt'), 'f', 'its commits stay on its branch');
    assert.strictEqual(G(d, 'rev-parse', 'HEAD'), before);
    G(d, 'branch', 'mine'); fs.mkdirSync(W('deeper')); G(d, 'worktree', 'add', path.join(W('deeper'), 'x'), 'mine');
    assert(!R.addWorktree(d, W('e3'), 'office/e3', base, root).ok, 'a nested user worktree still blocks the root');
    assert(!R.removeWorktree(d, path.join(W('deeper'), 'x'), root).ok);
  });
  test('plainRepo: the folder is the top, .git is a real folder of its own, its key entries are not links', () => {
    const d = mk('plainr');
    assert.deepStrictEqual(R.plainRepo(d), { ok: true });
    fs.mkdirSync(path.join(d, 'sub')); assert(!R.plainRepo(path.join(d, 'sub')).ok, 'a folder inside');
    const wt = W('pr1'); assert(R.addWorktree(d, wt, 'office/pr1', R.state(d).branch, root).ok);
    assert(!R.plainRepo(wt).ok, 'a worktree (.git is a file)');
    assert(!R.plainRepo(path.join(tmp, 'nothing-here')).ok);
    const other = mk('plainother'), fake = path.join(tmp, 'plainfake'); fs.mkdirSync(path.join(fake, '.git'), { recursive: true });
    for (const f of ['HEAD', 'config']) fs.copyFileSync(path.join(other, '.git', f), path.join(fake, '.git', f));
    if (!link(path.join(other, '.git', 'objects'), path.join(fake, '.git', 'objects'))) return console.log('  (skip: links need privileges here)');
    link(path.join(other, '.git', 'refs'), path.join(fake, '.git', 'refs'));
    const r = R.plainRepo(fake); assert(!r.ok && r.err, 'shared objects and refs by links');
  });
  test('plainRepo refuses a link anywhere under .git; a normal repo with a worktree and packed objects passes', () => {
    const other = mk('victim'); G(other, 'branch', 'office/x');
    const otherState = () => JSON.stringify([G(other, 'for-each-ref'), G(other, 'count-objects', '-v'), fs.readdirSync(path.join(other, '.git', 'logs', 'refs', 'heads'))]);
    const before = otherState();
    const fresh = (name) => { const d = mk(name); G(d, 'branch', 'office/x'); return d; };
    const objDir = (d) => fs.readdirSync(path.join(d, '.git', 'objects')).find((x) => /^[0-9a-f]{2}$/.test(x));
    const cases = [
      ['refs/heads/office', (d) => { fs.rmSync(path.join(d, '.git', 'refs', 'heads', 'office'), { recursive: true }); return link(path.join(other, '.git', 'refs', 'heads', 'office'), path.join(d, '.git', 'refs', 'heads', 'office')); }],
      ['one objects folder', (d) => { const x = objDir(d), at = path.join(d, '.git', 'objects', x); fs.rmSync(at, { recursive: true }); fs.mkdirSync(path.join(other, '.git', 'objects', x), { recursive: true }); return link(path.join(other, '.git', 'objects', x), at); }],
      ['logs', (d) => { fs.rmSync(path.join(d, '.git', 'logs'), { recursive: true }); return link(path.join(other, '.git', 'logs'), path.join(d, '.git', 'logs')); }],
      ['a ref file', (d) => { const f = path.join(d, '.git', 'refs', 'heads', 'office', 'x'); fs.rmSync(f); try { fs.symlinkSync(path.join(other, '.git', 'refs', 'heads', 'office', 'x'), f, 'file'); return true; } catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') return false; throw e; } }],
      ['three levels deep', (d) => { const at = path.join(d, '.git', 'refs', 'heads', 'deep', 'er'); fs.mkdirSync(at, { recursive: true }); return link(path.join(other, '.git', 'refs'), path.join(at, 'down')); }],
    ];
    let skipped = false;
    for (const [what, plant] of cases) {
      const d = fresh(`plant-${what.replace(/\W+/g, '-')}`);
      assert(R.plainRepo(d).ok, `${what}: fine before`);
      if (!plant(d)) { skipped = true; continue; }
      const r = R.plainRepo(d); assert(!r.ok && r.err, what);
    }
    if (skipped) console.log('  (skip: links need privileges here)');
    assert.strictEqual(otherState(), before, 'the other repo is unchanged');
    const ok = mk('plainok'); const base = R.state(ok).branch;
    for (const n of [1, 2, 3]) { fs.writeFileSync(path.join(ok, `f${n}.txt`), String(n)); G(ok, 'add', '-A'); G(ok, 'commit', '-q', '-m', `c${n}`); }
    assert(R.addWorktree(ok, W('pok'), 'office/pok', base, root).ok);
    G(ok, 'gc', '-q');
    assert.deepStrictEqual(R.plainRepo(ok), { ok: true });
    assert(R.removeWorktree(ok, W('pok'), root).ok);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (process.exitCode) console.log('\nrepo tests FAILED'); else console.log(`\n${n} repo tests passed`);
