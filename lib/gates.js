// Gates: what the office does around a coding task in a software office (kind: code or test, with a project).
// Before it starts: its own worktree <office>/worktrees/<task id> on branch office/<task id>, cut from the
// job's branch office/<job id> (or the project's current branch for a task with no job).
// After its run: leftovers committed, the branch merged into the job's branch, the worktree removed.
// The office's own record of every worktree lives in .office/gates.json (staff cannot edit it);
// the branch:, worktree: and base: lines in a task file are copies for people and are never read back.

const fs = require('fs');
const path = require('path');
const R = require('./repo');
const { linkedFolders } = require('./generate');

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const NOT_READY = 'The project folder has changes that are not committed (or no branch checked out). Commit or stash them, then press Start again on the job.';
const NO_REPO = 'No branch: the project folder is not a git repository.';
const WIP = 'Work in progress (uncommitted when the task ended)';
const LIVE = ['new', 'working', 'checking'];
const key = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The repo of a project: its boss-set linked folder when that is a git repo; else projects/<id>/code when it has none.
function projectRepo(dir, id) {
  if (!FILE_ID.test(String(id || '')) || !fs.existsSync(path.join(dir, 'projects', id))) return { repo: '', how: 'none', why: `There is no project "${id}".` };
  const link = linkedFolders(dir).find((l) => l.project === id);
  if (link) return R.isRepo(link.path) ? { repo: path.resolve(link.path), how: 'linked', why: '' } : { repo: '', how: 'none', why: NO_REPO };
  return { repo: path.join(dir, 'projects', id, 'code'), how: 'own', why: '' };
}

class Gates {
  // opts: { dir, loadCfg(), say?(text) (one line in the manager's chat), jobOf?(id) -> job | null }; .tasks is set by whoever made the Tasks
  constructor({ dir, loadCfg, say, jobOf }) {
    this.dir = dir; this.loadCfg = loadCfg; this.say = say || (() => {}); this.jobOf = jobOf || (() => null);
    this.root = path.join(dir, 'worktrees');
    this.reg = path.join(dir, '.office', 'gates.json');
    this.told = new Set(); // jobs (or small tasks) whose hold was already said in the chat
    this.chain = new Map(); // repo -> the last merge in line
    this.tasks = null;
  }

  load() { try { const j = JSON.parse(fs.readFileSync(this.reg, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
  save(data) {
    fs.mkdirSync(path.dirname(this.reg), { recursive: true });
    const tmp = `${this.reg}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, this.reg);
  }
  rec(id) { const r = this.load()[id]; return r && typeof r === 'object' && r.repo && r.wt && r.branch ? r : null; }
  setRec(id, r) { const all = this.load(); if (r) all[id] = r; else delete all[id]; this.save(all); }
  read(id) { try { return this.tasks.read(id); } catch { return null; } }

  // Only in a software office, for code and test tasks of a project.
  software() { try { return (this.loadCfg() || {}).type === 'software'; } catch { return false; } }
  coding(t) { return this.software() && ['code', 'test'].includes(String(t.kind || '').trim()) && !!String(t.project || '').trim(); }
  // A coding task, or a follow-up of one (whatever its kind).
  applies(t) { return this.coding(t) || (this.software() && !!this.via(t)); }
  // A follow-up of a task the office made a worktree for: it shares that worktree and branch.
  via(t) { return t.continues && FILE_ID.test(String(t.continues)) && this.rec(t.continues) ? t.continues : ''; }
  // The office's own conflict follow-up for task <orig>: its end sends the office back to <orig>.
  fixOf(t) { const o = String(t.fixes || ''), r = FILE_ID.test(o) && this.rec(o); return r && r.fix === t.id ? o : ''; }
  // The task ends through afterRun (it has its own worktree record and is not a conflict follow-up).
  owns(t) { return this.applies(t) && !!this.rec(t.id) && !this.fixOf(t); }

  // Why the repo cannot take this task yet ('' when it can). Creates the job branch (and projects/<id>/code) when needed.
  ready(t, memo) {
    const pr = projectRepo(this.dir, String(t.project).trim());
    if (pr.how === 'none') return '';
    const job = t.job ? String(t.job) : '', key = `${pr.repo}\n${job}`;
    if (memo && memo.has(key)) return memo.get(key);
    const why = this.check(pr, job);
    if (memo) memo.set(key, why);
    const tell = job || `task:${t.id}`;
    if (!why) this.told.delete(tell);
    else if (!this.told.has(tell)) { this.told.add(tell); const j = job && this.jobOf(job); this.say(`${j ? `Job "${j.title}"` : `Task "${t.title || t.id}"`}: ${why}`); }
    return why;
  }
  check(pr, job) {
    if (pr.how === 'own') { const e = R.ensureRepo(pr.repo); if (!e.ok) return e.err; }
    if (job && R.branchExists(pr.repo, `office/${job}`)) { const c = R.safeConfig(pr.repo); return c.ok ? '' : c.err; }
    const st = R.state(pr.repo);
    if (!st.ok) return st.err || NOT_READY;
    if (!st.hasCommits || st.detached || !st.clean) return NOT_READY;
    if (!job) return '';
    const b = R.createBranch(pr.repo, `office/${job}`, st.branch);
    return b.ok ? '' : `Could not make the job's branch: ${b.err}`;
  }

  // Called by the engine for a new task that is otherwise ready: a reason to hold it, or ''.
  hold(t, memo) { return this.coding(t) && !this.via(t) ? this.ready(t, memo) : ''; }
  // A job was approved: its branch is made now (or the hold is said once).
  jobApproved(jobId) {
    if (!this.tasks || !this.software()) return;
    try {
      const t = this.tasks.list().filter((x) => x.job === jobId && x.status === 'new' && this.coding(x) && !this.via(x)).pop(); // oldest
      if (t) this.ready(t);
    } catch { /* looked at again when its task is ready */ }
  }
  // Start a held job again (the Start button): forget that it was said, look again now.
  recheck(jobId) {
    this.told.delete(jobId);
    const t = this.tasks ? this.tasks.list().filter((x) => x.job === jobId && x.status === 'new' && this.coding(x) && !this.via(x)).pop() : null;
    const reason = t ? this.ready(t) : '';
    if (this.tasks) this.tasks.scan();
    return { ok: !reason, reason };
  }

  // Before a coding task starts. { ok, cwdNote (for the prompt), note (for the board), hold?, reason }
  prepare(t) {
    if (!this.applies(t)) return { ok: true };
    const from = this.via(t);
    let r;
    if (from) { // a follow-up: the same worktree and branch, opened again if it was removed
      r = { ...this.rec(from) };
      delete r.fix; delete r.tries;
      if (!fs.existsSync(r.wt) || !fs.readdirSync(r.wt).length) {
        fs.mkdirSync(this.root, { recursive: true });
        const a = R.addWorktree(r.repo, r.wt, r.branch, '', this.root);
        if (!a.ok) return { ok: false, reason: `Could not open the branch ${r.branch} again: ${a.err}` };
      }
    } else {
      const pr = projectRepo(this.dir, String(t.project).trim());
      if (pr.how === 'none') return { ok: true, note: pr.why };
      const why = this.ready(t);
      if (why) return { ok: false, hold: true, reason: why };
      const job = t.job ? String(t.job) : '';
      const base = job ? `office/${job}` : R.state(pr.repo).branch;
      if (!base) return { ok: false, hold: true, reason: NOT_READY };
      r = { repo: pr.repo, wt: path.join(this.root, t.id), branch: `office/${t.id}`, base, into: job ? base : '' };
      fs.mkdirSync(this.root, { recursive: true });
      const a = R.addWorktree(r.repo, r.wt, r.branch, base, this.root);
      if (!a.ok) return { ok: false, reason: `Could not make the task's own copy of the project: ${a.err}` };
    }
    this.setRec(t.id, r);
    try { this.tasks.write(t.id, { branch: r.branch, worktree: r.wt, base: r.base }); } catch { /* file removed */ }
    return { ok: true, worktree: r.wt, cwdNote: `Work only in ${r.wt}. It is its own copy of the project on branch ${r.branch}. Commit your work there (git -C "${r.wt}" add ... then commit). Do not switch branches.` };
  }

  // After the run ended fine (the task is checking): leftovers committed, then the merge, one at a time per repo.
  // Resolves { status: 'done' | 'failed' | 'checking', note }; 'checking' means a follow-up was written and
  // the engine calls afterRun again when that follow-up ends.
  afterRun(t) {
    const r = this.rec(t.id);
    if (!r) return Promise.resolve({ status: 'failed', note: 'The office has no record of this task\'s branch.' });
    const prev = this.chain.get(r.repo) || Promise.resolve();
    const next = prev.then(() => this.finishOne(t.id), () => this.finishOne(t.id))
      .catch((e) => ({ status: 'failed', note: `Could not finish the task: ${e.message}` }));
    this.chain.set(r.repo, next);
    return next;
  }
  finishOne(id) {
    const r = this.rec(id);
    if (!r) return { status: 'failed', note: 'The office has no record of this task\'s branch.' };
    const fix = r.fix && this.read(r.fix);
    if (fix && ['new', 'working'].includes(fix.status)) return { status: 'checking' }; // its conflict follow-up is still on the way
    if (fs.existsSync(r.wt)) {
      const c = R.commitAll(r.repo, r.wt, r.branch, this.root, WIP);
      if (!c.ok) return { status: 'failed', note: `Could not save the work in ${r.wt}: ${c.err}` };
    }
    if (!r.into) {
      this.drop(r);
      return { status: 'done', note: `The branch ${r.branch} is left in the project folder for the boss.\nBranch: ${r.branch}.` };
    }
    const m = R.merge(r.repo, r.into, r.branch);
    if (m.ok) { this.drop(r); return { status: 'done', note: `Branch: ${r.into}.` }; }
    if (!m.conflict) return { status: 'failed', note: `Could not merge into ${r.into}: ${m.err}` };
    const files = m.files.join(', ');
    if ((r.tries || 0) >= 1) { this.drop(r); return { status: 'failed', note: `The branch ${r.branch} still does not merge into ${r.into}. Files: ${files}.` }; }
    const t = this.read(id);
    if (!t || !t.staff || !this.tasks) return { status: 'failed', note: `The branch ${r.branch} does not merge into ${r.into}. Files: ${files}.` };
    this.setRec(id, { ...r, tries: 1, fix: '' });
    const fid = this.tasks.add(t.staff, `Your branch does not merge into the job's branch. Files: ${files}. In ${r.wt}, run git merge ${r.into}, fix the conflicts, commit, and report.`,
      { from: 'pa', project: t.project || '', job: t.job || '', kind: 'code', continues: id, fixes: id });
    this.setRec(id, { ...this.rec(id), fix: fid });
    setImmediate(() => { try { this.tasks.scan(); } catch { /* next change */ } }); // the follow-up waited for the record
    return { status: 'checking', note: `Merge conflict in ${files}: a follow-up was given to the author.` };
  }
  drop(r) { if (fs.existsSync(r.wt)) R.removeWorktree(r.repo, r.wt, this.root); }

  // Start-up: worktrees of tasks that are over (or gone) are removed, leftovers saved first; tasks left checking finish.
  recover() {
    if (!this.software() || !this.tasks) return;
    const all = this.tasks ? this.tasks.list() : [], reg = this.load(), byId = new Map(all.map((t) => [t.id, t]));
    const repos = new Set(Object.values(reg).filter((r) => r && r.repo).map((r) => r.repo));
    for (const p of (() => { try { return fs.readdirSync(path.join(this.dir, 'projects')); } catch { return []; } })()) {
      const pr = projectRepo(this.dir, p); if (pr.how !== 'none' && R.isRepo(pr.repo)) repos.add(pr.repo);
    }
    for (const repo of repos) R.prune(repo);
    const wtOf = (t) => { const r = reg[t.id] || (t.continues && reg[t.continues]); return r && r.wt ? key(r.wt) : ''; };
    const inUse = new Set(all.filter((t) => LIVE.includes(t.status)).map(wtOf).filter(Boolean));
    let dirty = false;
    for (const [id, r] of Object.entries(reg)) {
      if (!r || !r.wt || !r.repo) continue;
      if (!byId.has(id)) { delete reg[id]; dirty = true; }
      if (inUse.has(key(r.wt)) || !fs.existsSync(r.wt)) continue;
      R.commitAll(r.repo, r.wt, r.branch, this.root, WIP);
      R.removeWorktree(r.repo, r.wt, this.root);
    }
    for (const repo of repos) { // office worktrees the record does not know (it was lost): only empty task ids that are over
      for (const w of R.listWorktrees(repo)) {
        const id = w.branch.startsWith('office/') ? w.branch.slice(7) : '';
        if (!id || inUse.has(key(w.dir)) || key(w.dir) !== key(path.join(this.root, id))) continue;
        const t = byId.get(id); if (t && LIVE.includes(t.status)) continue;
        R.removeWorktree(repo, w.dir, this.root);
      }
    }
    if (dirty) this.save(reg);
    for (const t of all) if (t.status === 'checking' && this.tasks) this.tasks.check(t.id);
  }
}

module.exports = { Gates, projectRepo, NOT_READY, NO_REPO };
