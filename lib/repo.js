// The office's own git commands. Every call is spawnSync('git', args) with one argument per
// value, never a shell. Nothing here throws for a git failure: it returns { ok: false, err }.
// The user's checked-out branch and working files are never touched.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bad = (err) => ({ ok: false, err });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const idOk = (id) => typeof id === 'string' && ID.test(id) && !id.endsWith('.lock') && !id.endsWith('.') && !id.includes('..') && id !== 'HEAD';
const nameOk = (name) => typeof name === 'string' && name.startsWith('office/') && idOk(name.slice(7));
const refOk = (ref) => typeof ref === 'string' && ref !== '' && !ref.startsWith('-') && !/[\0\r\n]/.test(ref);

// Staff can write into .git, so every call runs with hooks and fsmonitor off (an empty hooks folder).
// The folder is made fresh for this process (a predictable name could be pre-made by someone else).
let noHooks = null;
process.on('exit', () => { try { if (noHooks) fs.rmSync(noHooks, { recursive: true, force: true }); } catch { /* best effort */ } });
function hooksDir() {
  // A file in there (git-lfs writes hooks into core.hooksPath) is never run: the folder is dropped for a fresh one.
  if (noHooks && (!fs.existsSync(noHooks) || fs.readdirSync(noHooks).length)) {
    try { fs.rmSync(noHooks, { recursive: true, force: true }); } catch { /* best effort */ }
    noHooks = null;
  }
  if (!noHooks) noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-no-hooks-'));
  return noHooks;
}

function git(cwd, args, pre = []) {
  let hooks;
  try { hooks = hooksDir(); } catch (e) { return bad(e.message); }
  const r = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...pre, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) return { ok: false, out: '', err: r.error.code === 'ENOENT' ? 'git or the folder was not found.' : r.error.message };
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  return r.status === 0 ? { ok: true, out, err } : { ok: false, out, err: err || out || `git exited with ${r.status}` };
}

const win = process.platform === 'win32';
const rp = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const fold = (p) => (win ? p.toLowerCase() : p);
// real path of a folder that may not exist yet: the parent's real path plus the name
const real = (p) => (fs.existsSync(p) ? rp(p) : path.join(rp(path.dirname(p)), path.basename(p)));
// dir must be absolute and strictly inside root
function inside(root, dir) {
  if (typeof root !== 'string' || typeof dir !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(dir)) return false;
  const rel = path.relative(fold(rp(root)), fold(real(dir)));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Settings in a project's own .git/config that would run code or redirect a push. The office
// refuses to change or push such a project (the user's own global settings are not checked).
const RISKY = [/^include(if)?\./, /^filter\.(?!lfs\.)/, /^merge\..+\.driver$/, /^diff\..+\.command$/, /^diff\.external$/, /^gpg\.program$/, /^gpg\..+\.program$/,
  /^credential\./, /^protocol\./, /^url\./, /^remote\..+\.(receivepack|uploadpack|proxy|vcs)$/,
  /^core\.(sshcommand|askpass|gitproxy|editor|pager)$/, /^sequence\.editor$/, /^alias\./];
// git-lfs filters are allowed only with the exact values git-lfs itself writes (git runs them through a shell).
const LFS_STD = { clean: ['git-lfs clean -- %f'], smudge: ['git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f'], process: ['git-lfs filter-process', 'git-lfs filter-process --skip'] };
const LFS_CMD = /^filter\.lfs\.(clean|smudge|process)$/;

function safeConfig(repo) {
  const r = git(repo, ['config', '--list', '--show-scope', '-z']);
  if (!r.ok) return r;
  const names = [];
  const parts = r.out.split('\0'); // scope, "key\nvalue", scope, ...
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== 'local' && parts[i] !== 'worktree') continue;
    const nl = parts[i + 1].indexOf('\n');
    const key = nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl), value = nl < 0 ? '' : parts[i + 1].slice(nl + 1);
    const lower = key.toLowerCase();
    const risky = LFS_CMD.test(lower) ? !LFS_STD[lower.slice(11)].includes(value.trim()) : RISKY.some((re) => re.test(lower));
    if (risky && !names.includes(key)) names.push(key);
  }
  return names.length ? bad(`This project has git settings the office will not run with: ${names.slice(0, 5).join(', ')}. Ask Claude in a terminal to look at the project's .git/config with you, or do this step yourself.`) : { ok: true };
}

// The worktrees folder must be a real folder that is not the project, inside it, or around it.
function rootOk(repo, root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.existsSync(root)) return bad('The worktrees folder is not usable.');
  const rr = fold(rp(root));
  if (path.parse(rr).root === rr) return bad('The worktrees folder is not usable.');
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return top;
  const guard = [top.out, ...listWorktrees(repo).filter((w) => !w.branch.startsWith('office/')).map((w) => w.dir)];
  const near = (a, b) => { const rel = path.relative(a, b); return !rel.startsWith('..') && !path.isAbsolute(rel); }; // b is a or inside a
  for (const g of guard) {
    const f = fold(real(g));
    if (near(rr, f) || near(f, rr)) return bad('The worktrees folder overlaps the project.');
  }
  return { ok: true };
}

// A repo of its own: the top of its working tree is this folder (not a folder inside another repo).
function isRepo(folder) {
  const r = git(folder, ['rev-parse', '--show-toplevel']);
  return r.ok && fold(rp(r.out)) === fold(rp(folder));
}

function state(folder) {
  const c = safeConfig(folder); if (!c.ok) return c; // status runs clean filters
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
  if (isRepo(folder)) { const c = safeConfig(folder); return c.ok ? { ok: true, created: false } : c; }
  fs.mkdirSync(folder, { recursive: true });
  const i = git(folder, ['init']);
  if (!i.ok) return i;
  if (!git(folder, ['config', 'user.name']).out) git(folder, ['config', '--local', 'user.name', 'AI Office']);
  if (!git(folder, ['config', 'user.email']).out) git(folder, ['config', '--local', 'user.email', 'office@localhost']);
  const c = git(folder, ['commit', '--allow-empty', '-m', 'Start of the project']);
  return c.ok ? { ok: true, created: true } : bad(c.err);
}

const branchExists = (repo, name) => nameOk(name) && git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).ok;

function createBranch(repo, name, from) {
  if (!nameOk(name)) return bad('That branch name is not allowed.');
  if (!refOk(from)) return bad('That base is not allowed.');
  const c = safeConfig(repo); if (!c.ok) return c;
  return git(repo, ['branch', name, from]);
}

// With a `from`: a new branch cut from it. With no `from`: an existing office branch that no worktree has checked out.
function addWorktree(repo, dir, branch, from, root) {
  if (!nameOk(branch)) return bad('That branch name is not allowed.');
  const open = from == null || from === '';
  if (!open && !refOk(from)) return bad('That base is not allowed.');
  if (!inside(root, dir)) return bad('That folder is not inside the office worktrees folder.');
  try {
    if (fs.existsSync(dir)) {
      if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length) return bad('That folder is already in use.');
    }
  } catch (e) { return bad(e.message); }
  const c = safeConfig(repo); if (!c.ok) return c;
  const ro = rootOk(repo, root); if (!ro.ok) return ro;
  if (!open) return git(repo, ['worktree', 'add', '-b', branch, '--', dir, from]);
  if (!branchExists(repo, branch)) return bad('That branch does not exist.');
  if (listWorktrees(repo).some((w) => w.branch === branch)) return bad('That branch is checked out in another worktree.');
  return git(repo, ['worktree', 'add', '--', dir, branch]);
}

function listWorktrees(repo) {
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  return r.out.split(/\r?\n\r?\n/).map((blk) => {
    const dir = /^worktree (.*)$/m.exec(blk), br = /^branch refs\/heads\/(.*)$/m.exec(blk);
    return dir ? { dir: dir[1], branch: br ? br[1] : '' } : null;
  }).filter(Boolean);
}

// Removes a worktree the office made: strictly inside `root` (the office's worktrees folder),
// never a symbolic link, never the main working tree, only an office/ branch. A folder git no
// longer knows about is just deleted, because it passed the same checks.
function removeWorktree(repo, dir, root) {
  if (!inside(root, dir)) return bad('That folder is not inside the office worktrees folder.');
  try { if (fs.lstatSync(dir).isSymbolicLink()) return bad('That folder is a link.'); } catch { /* not there */ }
  const c = safeConfig(repo); if (!c.ok) return c;
  const ro = rootOk(repo, root); if (!ro.ok) return ro;
  const want = fold(real(dir));
  const list = listWorktrees(repo);
  const at = list.findIndex((w) => fold(real(w.dir)) === want);
  if (at >= 0) {
    if (at === 0) return bad('That is the project folder.');
    if (!list[at].branch.startsWith('office/')) return bad('That worktree was not made by the office.');
    const r = git(repo, ['worktree', 'remove', '--force', '--', dir]);
    if (!r.ok) return r;
  } else if (fs.existsSync(dir)) {
    const holds = list.some((w) => { const rel = path.relative(want, fold(real(w.dir))); return !rel.startsWith('..') && !path.isAbsolute(rel); });
    if (holds) return bad('A worktree of this project is inside that folder.');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return bad(e.message); }
  }
  git(repo, ['worktree', 'prune']);
  return { ok: true };
}

const prune = (repo) => git(repo, ['worktree', 'prune']);

// Stage and commit what a staff left behind.
function commitAll(worktree, message) {
  const c0 = safeConfig(worktree); if (!c0.ok) return c0;
  const a = git(worktree, ['add', '-A']);
  if (!a.ok) return a;
  if (git(worktree, ['diff', '--cached', '--quiet']).ok) return { ok: true, committed: false };
  const c = git(worktree, ['commit', '-m', String(message || 'Work in progress')]);
  return c.ok ? { ok: true, committed: true } : c;
}

// `into` is a plain local branch name, like main or office/job-1.
const intoOk = (n) => typeof n === 'string' && /^[A-Za-z0-9._\/-]+$/.test(n) && !/^[-\/]/.test(n) && !n.includes('..') && !/(^|\/)\.|\/$|\.lock$|\/\//.test(n)
  && !/^(refs|heads)\//.test(n) && n !== 'HEAD';

// Merge `branch` into `into` in a temporary worktree: the user's checkout is never touched.
function merge(repo, into, branch) {
  if (!intoOk(into) || !refOk(branch)) return bad('That branch name is not allowed.');
  const c0 = safeConfig(repo); if (!c0.ok) return c0;
  const ref = `refs/heads/${into}`;
  if (!git(repo, ['show-ref', '--verify', '--quiet', ref]).ok) return bad('That branch does not exist.');
  if (git(repo, ['symbolic-ref', '-q', 'HEAD']).out === ref) return bad('That branch is checked out in the project folder.');
  let tmp;
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-merge-')); } catch (e) { return bad(e.message); }
  const dir = path.join(tmp, 'wt');
  try {
    const add = git(repo, ['worktree', 'add', '--', dir, into]);
    if (!add.ok) return add;
    if (git(dir, ['symbolic-ref', '-q', 'HEAD']).out !== ref) return bad('The merge folder is not on that branch.');
    const m = git(dir, ['merge', '--no-ff', '--no-edit', branch]);
    if (m.ok) return { ok: true, conflict: false, files: [] };
    const files = git(dir, ['diff', '--name-only', '-z', '--diff-filter=U']).out.split('\0').filter(Boolean);
    git(dir, ['merge', '--abort']);
    return files.length ? { ok: false, conflict: true, files, err: 'The changes overlap.' } : { ok: false, conflict: false, files: [], err: m.err };
  } finally {
    git(repo, ['worktree', 'remove', '--force', '--', dir]);
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

// Only an office/<id> branch, only to origin, never forced. The caller must show pushTarget()
// to the boss first: a project's remote.origin.pushurl decides where the branch really goes.
function push(repo, branch) {
  if (!nameOk(branch)) return bad('That branch name is not allowed.');
  const c = safeConfig(repo); if (!c.ok) return c;
  if (!hasRemote(repo, 'origin')) return bad('This project has no remote called origin.');
  return git(repo, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], ['-c', 'core.sshCommand=ssh']);
}

// Where a push would go, for the boss to see.
function pushTarget(repo) {
  const r = git(repo, ['remote', 'get-url', '--push', 'origin']);
  return r.ok ? { ok: true, url: r.out } : r;
}

module.exports = { git, isRepo, state, ensureRepo, branchExists, createBranch, addWorktree, removeWorktree, listWorktrees, commitAll, merge, diffStat, hasRemote, push, prune, safeConfig, pushTarget };
