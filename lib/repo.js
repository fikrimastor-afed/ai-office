// The office's own git commands. Every call is spawnSync('git', args) with one argument per
// value, never a shell. Nothing here throws for a git failure: it returns { ok: false, err }.
// The user's checked-out branch and working files are never touched.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const idOk = (id) => typeof id === 'string' && ID.test(id) && !id.endsWith('.lock') && !id.endsWith('.') && !id.includes('..');
const nameOk = (name) => typeof name === 'string' && name.startsWith('office/') && idOk(name.slice(7));
const refOk = (ref) => typeof ref === 'string' && ref !== '' && !ref.startsWith('-') && !/[\0\r\n]/.test(ref);
const bad = (err) => ({ ok: false, err });

function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) return { ok: false, out: '', err: r.error.code === 'ENOENT' ? 'git or the folder was not found.' : r.error.message };
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  return r.status === 0 ? { ok: true, out, err } : { ok: false, out, err: err || out || `git exited with ${r.status}` };
}

const isRepo = (folder) => git(folder, ['rev-parse', '--git-dir']).ok;

function state(folder) {
  const s = git(folder, ['status', '--porcelain']);
  if (!s.ok) return { ok: false, err: s.err, branch: '', clean: false, hasCommits: false, detached: false };
  const b = git(folder, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return {
    ok: true,
    branch: b.ok ? b.out : '',
    clean: s.out === '',
    hasCommits: git(folder, ['rev-parse', '--verify', '-q', 'HEAD']).ok,
    detached: !b.ok,
  };
}

// A folder that is not a repo gets git init and one empty first commit.
function ensureRepo(folder) {
  if (isRepo(folder)) return { ok: true, created: false };
  fs.mkdirSync(folder, { recursive: true });
  const i = git(folder, ['init']);
  if (!i.ok) return i;
  if (!git(folder, ['config', 'user.name']).out) git(folder, ['config', '--local', 'user.name', 'AI Office']);
  if (!git(folder, ['config', 'user.email']).out) git(folder, ['config', '--local', 'user.email', 'office@localhost']);
  const c = git(folder, ['commit', '--allow-empty', '-m', 'Start of the project']);
  return c.ok ? { ok: true, created: true } : c;
}

const branchExists = (repo, name) => nameOk(name) && git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).ok;

function createBranch(repo, name, from) {
  if (!nameOk(name)) return bad('That branch name is not allowed.');
  if (!refOk(from)) return bad('That base is not allowed.');
  return git(repo, ['branch', name, from]);
}

function addWorktree(repo, dir, branch, from) {
  if (!nameOk(branch)) return bad('That branch name is not allowed.');
  if (!refOk(from)) return bad('That base is not allowed.');
  return git(repo, ['worktree', 'add', '-b', branch, dir, from]);
}

function listWorktrees(repo) {
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  return r.out.split(/\r?\n\r?\n/).map((blk) => {
    const dir = /^worktree (.*)$/m.exec(blk), br = /^branch refs\/heads\/(.*)$/m.exec(blk);
    return dir ? { dir: dir[1], branch: br ? br[1] : '' } : null;
  }).filter(Boolean);
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Removes a worktree folder. It only ever deletes a folder that is a worktree of this repo.
function removeWorktree(repo, dir) {
  if (!dir || typeof dir !== 'string') return bad('No folder given.');
  const listed = listWorktrees(repo).some((w) => same(w.dir, dir));
  let mine = listed;
  if (!listed) {
    // already unregistered: its .git FILE must point into this repo's .git/worktrees/
    try {
      const f = path.join(dir, '.git');
      if (fs.statSync(f).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(f, 'utf8'));
        const common = git(repo, ['rev-parse', '--git-common-dir']);
        if (m && common.ok) {
          const root = path.resolve(repo, common.out, 'worktrees') + path.sep;
          mine = path.resolve(dir, m[1].trim()).toLowerCase().startsWith(root.toLowerCase());
        }
      }
    } catch { /* not a worktree */ }
  }
  if (!mine) return bad('That folder is not a worktree of this project.');
  const r = listed ? git(repo, ['worktree', 'remove', '--force', dir]) : { ok: true };
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return bad(e.message); }
  }
  git(repo, ['worktree', 'prune']);
  return fs.existsSync(dir) ? bad(r.err || 'Could not remove the folder.') : { ok: true };
}

// Stage and commit what a staff left behind.
function commitAll(worktree, message) {
  const a = git(worktree, ['add', '-A']);
  if (!a.ok) return a;
  if (git(worktree, ['diff', '--cached', '--quiet']).ok) return { ok: true, committed: false };
  const c = git(worktree, ['commit', '-m', String(message || 'Work in progress')]);
  return c.ok ? { ok: true, committed: true } : c;
}

// Merge `branch` into `into` in a temporary worktree: the user's checkout is never touched.
function merge(repo, into, branch) {
  if (!refOk(into) || !refOk(branch)) return bad('That branch name is not allowed.');
  const here = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (here.ok && here.out === into) return bad('That branch is checked out in the project folder.');
  let tmp;
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-merge-')); } catch (e) { return bad(e.message); }
  const dir = path.join(tmp, 'wt');
  try {
    const add = git(repo, ['worktree', 'add', dir, into]);
    if (!add.ok) return add;
    const m = git(dir, ['merge', '--no-ff', '--no-edit', branch]);
    if (m.ok) return { ok: true, conflict: false, files: [] };
    const files = git(dir, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
    git(dir, ['merge', '--abort']);
    return files.length ? { ok: false, conflict: true, files, err: 'The changes overlap.' } : { ok: false, conflict: false, files: [], err: m.err };
  } finally {
    git(repo, ['worktree', 'remove', '--force', dir]);
    git(repo, ['worktree', 'prune']);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leave it */ }
  }
}

function diffStat(repo, from, to) {
  if (!refOk(from) || !refOk(to)) return '';
  const r = git(repo, ['diff', '--stat', `${from}...${to}`]);
  return r.ok ? r.out.slice(0, 4000) : '';
}

const hasRemote = (repo, name) => git(repo, ['remote']).out.split(/\r?\n/).includes(name);

// Only an office/<id> branch, only to origin, never forced.
function push(repo, branch) {
  if (!nameOk(branch)) return bad('That branch name is not allowed.');
  if (!hasRemote(repo, 'origin')) return bad('This project has no remote called origin.');
  return git(repo, ['push', 'origin', branch]);
}

module.exports = { git, isRepo, state, ensureRepo, branchExists, createBranch, addWorktree, removeWorktree, listWorktrees, commitAll, merge, diffStat, hasRemote, push };
