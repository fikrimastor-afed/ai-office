// Gates: what the office does around a coding task in a software office (kind: code or test, with a project).
// Before it starts: its own worktree <office>/worktrees/<task id> on branch office/<task id>, cut from the
// job's branch office/<job id> (or the project's current branch for a task with no job).
// A new worktree first runs the project's setup command (office.json projectChecks), then the staff's run.
// After its run: leftovers committed, the project's tests run (a failure gives the author a follow-up),
// then (a task of a job, or one with review: yes) a reviewer's review, the branch merged into the job's branch,
// the worktree removed. Test failures and review changes share one round count: past MAX_ROUNDS the boss decides
// (an approval of kind rounds: accept, again or stop).
// The office's own record of every worktree lives in .office/gates.json (staff cannot edit it);
// the branch:, worktree: and base: lines in a task file are copies for people and are never read back.
// Staff can write in the office folder, so every folder the office runs git in is checked first: no links.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const R = require('./repo');
const { linkedFolders } = require('./generate');
const { chatEnv } = require('./chat');
const { commandOk } = require('../office-files/guard');
const O = require('./office');

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const NOT_READY = 'The project folder has changes that are not committed (or no branch checked out). Commit or stash them, then press Start again on the job.';
const NOT_READY_TASK = 'The project folder has changes that are not committed (or no branch checked out). Commit or stash them and the task will start.';
const NO_REPO = 'No branch: the project folder is not a git repository.';
const CODE_BAD = "The project's code folder is not a plain folder inside the office.";
const ROOT_BAD = (dir) => `The office's worktrees folder is not a plain folder. Remove what is at ${path.join(dir, 'worktrees')} and try again.`;
const CLASH = (id) => `A task and a job cannot have the same name ("${id}").`;
// a link inside the project's .git shows as the code folder text; a git folder too big to check says so
const plainWhy = (pl) => (/too large/.test(pl.err || '') ? pl.err : CODE_BAD);
const FIX_GONE = 'The follow-up to fix the merge did not finish.';
const TESTS_GONE = 'The follow-up to fix the tests did not finish.';
const MAX_ROUNDS = 2; // rounds of fixes (failing tests or review changes, one count) before the boss decides
const STOPPED = (b) => `Stopped by the boss while the office was finishing it. Branch ${b} is in the project folder.`;
const NO_REVIEWER = 'Review: no reviewer on the team.';
const REVIEW_GONE = 'The review did not finish.';
const REVIEW_FIX_GONE = "The follow-up with the reviewer's changes did not finish.";
const ACCEPTED = 'Accepted by the boss without a passing review.';
const NO_VERDICT = 'The reviewer gave no verdict line.';
const CHOICES = 'Accept merges it as it is. One more round sends it back once more. Stop ends the task; its branch stays in the project.';
// Every line indented four spaces: no line of it can start a heading or close the fence.
const indent = (s) => String(s).split('\n').map((l) => `    ${l}`).join('\n');
const gone = (r) => (r && r.why === 'tests' ? TESTS_GONE : r && r.why === 'review' ? REVIEW_FIX_GONE : FIX_GONE); // a fix follow-up that did not finish
const fence = (tail) => `\`\`\`\n${indent(tail)}\n\`\`\``;
// A review's first non-empty line decides: VERDICT: pass or VERDICT: changes. findings: the rest (at most 6,000 characters).
const VERDICT = /^VERDICT\s*:\s*(pass|changes)[\s.!?,;:]*$/i;
function verdict(text) {
  const lines = String(text || '').split(/\r?\n/), i = lines.findIndex((l) => l.trim()), m = i >= 0 ? VERDICT.exec(lines[i].trim()) : null;
  return { pass: !!m && m[1].toLowerCase() === 'pass', none: !m, findings: (m ? lines.slice(i + 1) : lines).join('\n').trim().slice(0, 6000) };
}
const WIP = 'Work in progress (uncommitted when the task ended)';
const LIVE = ['new', 'working', 'checking'];
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const key = (p) => { try { return fold(fs.realpathSync(p)); } catch { return fold(path.resolve(p)); } };
const plain = (p) => { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } }; // also a broken link

// projects/<id>/code may be used only when every part is a real folder inside the real office folder.
function ownOk(dir, id) {
  const base = path.join(fs.realpathSync(dir), 'projects', id), pdir = path.join(dir, 'projects', id), code = path.join(pdir, 'code');
  if (!plain(path.join(dir, 'projects')) || !plain(pdir) || key(pdir) !== fold(base)) return false;
  if (!there(code)) return true; // the office makes it
  if (!plain(code) || key(code) !== fold(path.join(base, 'code'))) return false;
  const gd = path.join(code, '.git');
  if (!there(gd)) return true;
  if (!plain(gd)) return false;
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  return !['objects', 'refs', path.join('refs', 'heads'), 'HEAD', 'config', 'worktrees'].some((e) => isLink(path.join(gd, e)));
}

// The repo of a project: its boss-set linked folder when that is a git repo; else projects/<id>/code when it has none.
function projectRepo(dir, id) {
  if (!FILE_ID.test(String(id || '')) || !fs.existsSync(path.join(dir, 'projects', id))) return { repo: '', how: 'none', why: `There is no project "${id}".` };
  const link = linkedFolders(dir).find((l) => l.project === id);
  if (link) return R.isRepo(link.path) ? { repo: path.resolve(link.path), how: 'linked', why: '' } : { repo: '', how: 'none', why: NO_REPO };
  let ok = false; try { ok = ownOk(dir, id); } catch { ok = false; }
  return { repo: path.join(dir, 'projects', id, 'code'), how: 'own', why: ok ? '' : CODE_BAD };
}

// ---- project checks: the office itself runs the boss's test or setup command (no guard in front, so commandOk is strict)
const CHECK_MS = 10 * 60 * 1000, TAIL_CHARS = 6000, TAIL_LINES = 60;
const live = new Map(); // pid -> ledger file of each check running now: killed (and unrecorded) with the office if it exits
const keepTail = (kept, chunk) => (kept + chunk).slice(-TAIL_CHARS); // only the end of the output is ever kept
// The whole process tree: taskkill /t on Windows; elsewhere the check's own process group (it was started detached).
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}
process.on('exit', () => { for (const [pid, f] of live) { killTree(pid); ledgerSet(f, pid, null); } });
// The office's own environment without its markers (no AI_OFFICE_*, no Claude session variables), plus CI=1.
function checkEnv(cwd) {
  const env = chatEnv(cwd, '');
  for (const k of Object.keys(env)) if (/^AI_OFFICE_/i.test(k)) delete env[k];
  return { ...env, CI: '1' };
}
// The office's list of checks running now (.office/checks.json { <pid>: { cmd, at } }): a restart kills what an office that died left.
const readLedger = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };
function ledgerSet(f, pid, v) {
  if (!f || !pid) return;
  try {
    const all = readLedger(f); if (v) all[pid] = v; else delete all[pid];
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, f);
  } catch { /* best effort */ }
}
// The time this computer started, in ms (to the second): a record from another boot names a pid that means nothing now.
const bootTime = () => Math.round((Date.now() - require('os').uptime() * 1000) / 1000) * 1000;
// Linux: when the process started, in ms (field 22 of /proc/<pid>/stat is clock ticks since boot, usually 100 a second).
// null when it cannot be read: then only the record's boot and age decide.
function startedAt(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), ticks = Number(f.slice(f.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(ticks) ? bootTime() + ticks * 10 : null;
  } catch { return null; }
}
// Kill the recorded checks an office that died left running. Only a record of this boot, not in the future and no older
// than maxAge, whose process group exists (Linux: and started within 5 s of the record) is killed; every record is dropped.
function killRecorded(f, maxAge) {
  const all = readLedger(f), now = Date.now(), boot = bootTime();
  for (const [k, x] of Object.entries(all)) {
    const pid = Number(k);
    if (!Number.isInteger(pid) || pid <= 1 || !x || typeof x.at !== 'number' || typeof x.boot !== 'number') continue;
    if (Math.abs(x.boot - boot) > 5000 || x.at > now || now - x.at > maxAge) continue;
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 0); } catch { continue; } // no such group: the pid leads nothing
      const st = startedAt(pid);
      if (st != null && Math.abs(st - x.at) > 5000) continue; // a different process now has that pid
    }
    killTree(pid);
  }
  const left = readLedger(f); for (const k of Object.keys(all)) delete left[k]; // handled: dropped (a check recorded meanwhile stays)
  if (Object.keys(all).length) try { fs.writeFileSync(f, JSON.stringify(left)); } catch { /* gone */ }
}
// Runs one project check in cwd. Resolves { ok, code, tail, timedOut, stopped?, refused? }; the promise has stop().
// ledger (optional): the .office/checks.json file the running check is recorded in.
// Only the last lines of output are kept as it streams. Windows: npm, pnpm, yarn and composer are .cmd files, which
// need cmd.exe, so there (only there) it runs through the shell: commandOk allows no character cmd.exe reads specially.
function runCheck(cwd, cmd, { timeoutMs = CHECK_MS, ledger = '' } = {}) {
  let child = null, stopped = false, timedOut = false, out = '';
  const p = new Promise((resolve) => {
    const c = commandOk(cmd); // again, right before it runs: the stored value may be from an older version
    if (!c.ok) return resolve({ ok: false, code: null, tail: `That command cannot be used as a project check: ${c.reason}`, timedOut: false, refused: true });
    const win = process.platform === 'win32', [prog, ...args] = cmd.split(' '), opts = { cwd, env: checkEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    let done = false, err = '', timer = null;
    const settle = (code) => {
      if (done) return; done = true; clearTimeout(timer); if (child) { live.delete(child.pid); ledgerSet(ledger, child.pid, null); }
      const lines = out.split(/\r?\n/); while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const tail = [...lines.slice(-TAIL_LINES), ...(err ? [err] : []), ...(timedOut ? [`The check timed out after ${timeoutMs < 60000 ? `${timeoutMs / 1000} seconds` : `${Math.round(timeoutMs / 60000)} minutes`}.`] : [])].join('\n').slice(-TAIL_CHARS);
      resolve({ ok: code === 0 && !err && !timedOut && !stopped, code: code == null ? null : code, tail, timedOut, ...(stopped ? { stopped: true } : {}) });
    };
    let isDir = false; try { isDir = fs.statSync(cwd).isDirectory(); } catch { isDir = false; }
    if (!isDir) { err = "The task's folder is missing."; return settle(null); }
    const plainErr = (e) => (e && e.code === 'ENOENT' ? `The program "${prog}" was not found on this computer.` : e.message);
    try { child = win ? spawn(cmd, { ...opts, shell: true }) : spawn(prog, args, { ...opts, detached: true }); } catch (e) { err = plainErr(e); return settle(null); }
    if (child.pid) { live.set(child.pid, ledger); ledgerSet(ledger, child.pid, { pid: child.pid, cmd, at: Date.now(), boot: bootTime() }); }
    const add = (d) => { out = keepTail(out, d); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', add); child.stderr.on('data', add);
    timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on('error', (e) => { err = plainErr(e); settle(null); });
    child.on('exit', () => { if (!win) killTree(child.pid); }); // what the check left running goes too
    child.on('close', (code) => settle(code));
  });
  p.stop = () => { stopped = true; if (child) killTree(child.pid); };
  return p;
}

class Gates {
  // opts: { dir, loadCfg(), say?(text) (one line in the manager's chat), jobOf?(id) -> job | null, checkMs? (time limit of a check) }; .tasks is set by whoever made the Tasks
  constructor({ dir, loadCfg, say, jobOf, checkMs }) {
    this.dir = dir; this.loadCfg = loadCfg; this.say = say || (() => {}); this.jobOf = jobOf || (() => null);
    this.checkMs = checkMs || CHECK_MS;
    this.runs = new Map(); // task id -> its tests check while it runs
    this.ledger = path.join(dir, '.office', 'checks.json');
    this.queue = new Set(); // tasks waiting in their repo's line for afterRun (no step of theirs has started)
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
  ok(r) { return r && typeof r === 'object' && r.repo && r.wt && r.branch ? r : null; }
  rec(id) { return this.ok(this.load()[id]); }
  setRec(id, r) { const all = this.load(); if (r) all[id] = r; else delete all[id]; this.save(all); }
  read(id) { try { return this.tasks.read(id); } catch { return null; } }
  // <office>/worktrees is a real folder (made when missing) that really is there, not a link elsewhere.
  rootReady() {
    try {
      if (!there(this.root)) fs.mkdirSync(this.root);
      return plain(this.root) && key(this.root) === fold(path.join(fs.realpathSync(this.dir), 'worktrees'));
    } catch { return false; }
  }

  // The boss's test and setup commands for a project (office.json projectChecks; never the project file).
  checksOf(project) {
    let all = {}; try { all = (this.loadCfg() || {}).projectChecks || {}; } catch { /* none */ }
    const c = FILE_ID.test(String(project || '')) && Object.prototype.hasOwnProperty.call(all, project) ? all[project] || {} : {};
    return { test: String(c.test || '').trim(), setup: String(c.setup || '').trim() };
  }
  // Only in a software office, for code and test tasks of a project.
  software() { try { return (this.loadCfg() || {}).type === 'software'; } catch { return false; } }
  coding(t) { return this.software() && ['code', 'test'].includes(String(t.kind || '').trim()) && !!String(t.project || '').trim(); }
  // A coding task, or a follow-up of one (whatever its kind).
  applies(t) { return this.coding(t) || (this.software() && !!this.via(t)); }
  // A follow-up of a task the office made a worktree for: it shares that worktree and branch.
  via(t) { return t.continues && FILE_ID.test(String(t.continues)) && this.rec(t.continues) ? t.continues : ''; }
  // The office's own conflict follow-up for task <orig>: its end sends the office back to <orig>.
  // Known by the id the office recorded, not by the fixes: line in the file.
  fixOf(t) { const reg = this.load(); return Object.keys(reg).find((o) => FILE_ID.test(o) && this.ok(reg[o]) && reg[o].fix === t.id) || ''; }
  // The task ends through afterRun (it has its own worktree record and is not a conflict follow-up).
  owns(t) { return this.applies(t) && !!this.rec(t.id) && !this.fixOf(t) && !this.reviewOf(t); }
  // The office's own review task for task <orig>: known by the id the office recorded, never by the reviews: line.
  reviewOf(t) { const reg = this.load(); return Object.keys(reg).find((o) => FILE_ID.test(o) && this.ok(reg[o]) && reg[o].reviewTask === t.id) || ''; }
  // A rounds approval the office made: the task it is for, or ''. Every rounds card the office made for a task is in its roundsApprovals (the current one is roundsApproval).
  taskOfApproval(aid) {
    const reg = this.load(), mine = (r) => r.roundsApproval === aid || (Array.isArray(r.roundsApprovals) && r.roundsApprovals.includes(aid));
    return Object.keys(reg).find((o) => FILE_ID.test(o) && this.ok(reg[o]) && mine(reg[o])) || '';
  }
  // A repo the office keeps itself (projects/<id>/code) must still be a plain repo before any git step.
  repoOk(repo) {
    const own = key(repo).startsWith(fold(path.join(key(this.dir), 'projects')) + path.sep);
    if (!own) return true;
    let ok = false; try { ok = ownOk(this.dir, path.basename(path.dirname(repo))); } catch { ok = false; }
    if (!ok) return false;
    return R.plainRepo(repo).ok;
  }
  repoWhy(repo) { if (this.repoOk(repo)) return ''; const pl = R.plainRepo(repo); return pl.ok ? CODE_BAD : plainWhy(pl); }
  // The worktree a task uses (its own record, or the one of the task it continues).
  wtOf(t, reg) { const r = this.ok(reg[t.id]) || (t.continues && this.ok(reg[t.continues])); return r ? key(r.wt) : ''; }

  // Job and task ids share the office/ branch names.
  clash(t) { return this.coding(t) && this.jobOf(t.id) ? CLASH(t.id) : ''; }
  jobClash(jobId) { return this.software() && this.rec(jobId) ? CLASH(jobId) : ''; }
  // A planned job whose id is a task's branch: no plan card; said once.
  planHold(jobId) {
    const why = this.jobClash(jobId);
    if (why && !this.told.has(jobId)) { this.told.add(jobId); const j = this.jobOf(jobId); this.say(`Job "${(j && j.title) || jobId}": ${why}`); }
    return why;
  }

  // Why the repo cannot take this task yet ('' when it can). Creates the job branch (and projects/<id>/code) when needed.
  ready(t, memo) {
    const pr = projectRepo(this.dir, String(t.project).trim());
    if (pr.how === 'none') return '';
    const job = t.job ? String(t.job) : '', k = `${pr.repo}\n${job}`;
    if (memo && memo.has(k)) return memo.get(k);
    const why = !this.rootReady() ? ROOT_BAD(this.dir) : (job && this.jobClash(job)) || this.check(pr, job);
    if (memo) memo.set(k, why);
    const tell = job || `task:${t.id}`;
    if (!why) this.told.delete(tell);
    else if (!this.told.has(tell)) { this.told.add(tell); const j = job && this.jobOf(job); this.say(`${j ? `Job "${j.title}"` : `Task "${t.title || t.id}"`}: ${why}`); }
    return why;
  }
  check(pr, job) {
    if (pr.why) return pr.why;
    if (pr.how === 'own') { const e = R.ensureRepo(pr.repo); if (!e.ok) return e.err; const pl = R.plainRepo(pr.repo); if (!pl.ok) return plainWhy(pl); }
    if (job && R.branchExists(pr.repo, `office/${job}`)) { const c = R.safeConfig(pr.repo); return c.ok ? '' : c.err; }
    const st = R.state(pr.repo);
    if (!st.ok) return st.err || (job ? NOT_READY : NOT_READY_TASK);
    if (!st.hasCommits || st.detached || !st.clean) return job ? NOT_READY : NOT_READY_TASK;
    if (!job) return '';
    const b = R.createBranch(pr.repo, `office/${job}`, st.branch);
    return b.ok ? '' : `Could not make the job's branch: ${b.err}`;
  }

  // Called by the engine for a new task that is otherwise ready: a reason to hold it, or ''.
  hold(t, memo) {
    if (this.coding(t) && !this.via(t)) return this.ready(t, memo);
    return this.software() && this.via(t) && !this.rootReady() ? ROOT_BAD(this.dir) : '';
  }
  // A follow-up waits while another task that uses the same worktree is working, checking, or new and ahead of it.
  // Returns that task's id, or ''. The office's own conflict follow-up never waits here (its task is checking for it).
  turn(t, all) {
    if (!this.software() || !this.via(t) || this.fixOf(t)) return '';
    const reg = this.load(), wt = this.wtOf(t, reg);
    const ahead = (x) => x.created < t.created || (x.created === t.created && x.id < t.id);
    const other = all.find((x) => x.id !== t.id && (['working', 'checking'].includes(x.status) || (x.status === 'new' && ahead(x))) && this.wtOf(x, reg) === wt);
    return other ? other.id : '';
  }
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
    if (String(t.kind || '').trim() === 'review' || this.reviewOf(t)) { // a review reads, never writes (a staff-written one too; only the recorded one counts)
      const of = this.reviewOf(t), r = of && this.rec(of);
      return { ok: true, readOnly: true, ...(r ? { cwdNote: `The change to review is in ${r.wt} (branch ${r.branch}). Read it there. Do not edit anything.` } : {}) };
    }
    if (!this.applies(t)) return { ok: true };
    if (!this.rootReady()) return { ok: false, hold: true, reason: ROOT_BAD(this.dir) };
    const from = this.via(t);
    let r;
    if (from) { // a follow-up: the same worktree and branch, opened again if it was removed
      r = { ...this.rec(from) };
      for (const k of ['fix', 'tries', 'round', 'why', 'reviewTask', 'reviewTries', 'verdict', 'reviewed', 'tested', 'roundsApproval', 'roundsApprovals', 'wait', 'extra', 'last', 'accepted', 'resend']) delete r[k];
      if (!there(r.wt)) {
        const bad = this.repoWhy(r.repo);
        if (bad) return { ok: false, hold: true, reason: bad };
        const a = R.addWorktree(r.repo, r.wt, r.branch, '', this.root);
        if (!a.ok) return { ok: false, reason: `Could not open the branch ${r.branch} again: ${a.err}` };
        delete r.setup; // a new worktree: its setup runs again
      } else if (!plain(r.wt)) return { ok: false, reason: `The task's own copy of the project at ${r.wt} is not a plain folder.` };
    } else {
      const pr = projectRepo(this.dir, String(t.project).trim());
      if (pr.how === 'none') return { ok: true, note: pr.why };
      const why = this.ready(t);
      if (why) return { ok: false, hold: true, reason: why };
      const job = t.job ? String(t.job) : '';
      const base = job ? `office/${job}` : R.state(pr.repo).branch;
      if (!base) return { ok: false, hold: true, reason: NOT_READY_TASK };
      r = { repo: pr.repo, wt: path.join(this.root, t.id), branch: `office/${t.id}`, base, into: job ? base : '', project: String(t.project).trim(),
        ...(!job && String(t.review || '').trim().toLowerCase() === 'yes' ? { review: true } : {}) }; // asked for when it started (a later edit changes nothing)
      const a = R.addWorktree(r.repo, r.wt, r.branch, base, this.root);
      if (!a.ok) return { ok: false, reason: `Could not make the task's own copy of the project: ${a.err}` };
    }
    this.setRec(t.id, r);
    try { this.tasks.write(t.id, { branch: r.branch, worktree: r.wt, base: r.base }); } catch { /* file removed */ }
    const setup = this.checksOf(r.project || t.project).setup; // once per worktree, before the staff's run
    return { ok: true, worktree: r.wt, cwdNote: `Work only in ${r.wt}. It is its own copy of the project on branch ${r.branch}. Commit your work there (git -C "${r.wt}" add ... then commit). Do not switch branches.`,
      ...(setup && r.setup !== 'done' ? { setup } : {}) };
  }
  // The project's setup in the task's new worktree. A promise (with stop()) of { ok, tail, note, stopped? }.
  setUp(id, cmd) {
    const r = this.rec(id);
    const run = r && plain(r.wt) ? runCheck(r.wt, cmd, { timeoutMs: this.checkMs, ledger: this.ledger }) : Object.assign(Promise.resolve({ ok: false, tail: 'The task\'s own copy of the project is not there.' }), { stop() {} });
    const p = run.then((res) => {
      if (res.ok) { // every record of this worktree knows its setup ran
        const all = this.load(), wt = key(r.wt);
        for (const [k, x] of Object.entries(all)) if (this.ok(x) && key(x.wt) === wt) all[k] = { ...x, setup: 'done' };
        this.save(all);
      }
      return { ...res, note: res.ok ? '' : res.refused ? res.tail : `The project's setup failed (${cmd}).\n\n${fence(res.tail)}` };
    });
    p.stop = run.stop;
    return p;
  }
  // The boss stops a task still waiting in its repo's line: it leaves the line (true), and stops like a task between steps.
  unqueue(id) { return this.queue.delete(id); }
  // The boss stops a task while its tests run: the check is killed (afterRun then ends it as stopped).
  stopTests(id) { const run = this.runs.get(id); if (!run) return false; run.stop(); return true; }

  // After the run ended fine (the task is checking): leftovers committed, then the merge, one at a time per repo.
  // Resolves { status: 'done' | 'failed' | 'checking', note }; 'checking' means a follow-up was written and
  // the engine calls afterRun again when that follow-up ends.
  afterRun(t) {
    const r = this.rec(t.id);
    if (!r) return Promise.resolve({ status: 'failed', note: 'The office has no record of this task\'s branch.' });
    const prev = this.chain.get(r.repo) || Promise.resolve();
    this.queue.add(t.id);
    const turn = () => (this.queue.delete(t.id) ? this.finishOne(t.id) : { status: 'stopped' }); // stopped while in line: nothing to do
    const next = prev.then(turn, turn)
      .catch((e) => ({ status: 'failed', note: `Could not finish the task: ${e.message}` }));
    this.chain.set(r.repo, next);
    return next;
  }
  async finishOne(id) {
    let r = this.rec(id);
    if (!r) return { status: 'failed', note: 'The office has no record of this task\'s branch.' };
    const fix = r.fix && this.read(r.fix);
    if (fix && ['new', 'working'].includes(fix.status)) return { status: 'checking', ...(['tests', 'review'].includes(r.why) ? { stage: r.why } : {}) }; // its follow-up is still on the way
    if (r.wait === 'boss') return { status: 'checking', stage: (r.last || {}).kind === 'tests' ? 'tests' : 'review' }; // the boss decides (a rounds approval)
    if (r.resend) return this.giveBack(id, r); // the boss chose one more round
    const rv = r.reviewTask && !r.verdict && this.read(r.reviewTask);
    if (rv && ['new', 'working'].includes(rv.status)) return { status: 'checking', stage: 'review' }; // the review is on the way
    if (!this.rootReady()) return { status: 'failed', note: ROOT_BAD(this.dir) };
    const bad = this.repoWhy(r.repo); if (bad) return { status: 'failed', note: bad };
    if (!there(r.wt)) return { status: 'failed', note: `The task's own copy of the project at ${r.wt} is gone. Nothing was merged.` };
    const c = R.commitAll(r.repo, r.wt, r.branch, this.root, WIP);
    if (!c.ok) {
      const wb = /^The work is on branch (.+), not \S+\.$/.exec(c.err);
      return { status: 'failed', note: !wb ? `Could not save the work in ${r.wt}: ${c.err}`
        : wb[1] === 'no branch' ? `The work is not on a branch (detached), not on ${r.branch}. Nothing was merged. The worktree is still at ${r.wt} until the office restarts.`
          : `The work is on branch ${wb[1]}, not ${r.branch}. Nothing was merged. The worktree is still at ${r.wt} until the office restarts; commits on ${wb[1]} stay in the project.` };
    }
    const lines = [];
    if (r.accepted) lines.push(ACCEPTED); // the boss's choice: no more gates
    else {
      // the tests gate: the boss's test command for the project, in the worktree (not again for commits that already passed)
      const tests = this.checksOf(r.project || (this.read(id) || {}).project).test;
      let said = 'Tests: none set for this project.';
      const head = tests ? this.head(r) : '';
      if (tests && head && r.tested && r.tested.sha === head) said = r.tested.said;
      else if (tests) {
        const stage = (s) => { if (this.tasks && this.tasks.setStage) this.tasks.setStage(id, s); };
        stage('tests');
        const run = runCheck(r.wt, tests, { timeoutMs: this.checkMs, ledger: this.ledger });
        this.runs.set(id, run);
        let res; try { res = await run; } finally { this.runs.delete(id); stage('merge'); }
        r = this.rec(id) || r;
        if (res.stopped) { this.drop(r, id); return { status: 'stopped', note: STOPPED(r.branch) }; } // leftovers were saved before the tests
        if (res.refused) { this.drop(r, id); return { status: 'failed', note: res.tail }; }
        if (!res.ok) return this.testsFail(id, r, tests, res.tail);
        if (!this.rootReady()) return { status: 'failed', note: ROOT_BAD(this.dir) };
        const bad2 = this.repoWhy(r.repo); if (bad2) { this.drop(r, id); return { status: 'failed', note: bad2 }; } // drop() leaves a repo that is not plain alone
        said = `Tests: passed (${tests}).`;
        this.setRec(id, { ...this.rec(id), tested: { sha: head, said } });
      }
      // the review gate (a task of a job, or one with review: yes)
      const rev = this.reviewStep(id, this.rec(id) || r);
      if (rev.end) return rev.end;
      lines.push(...[rev.line, said].filter(Boolean));
    }
    r = this.rec(id) || r;
    const said = lines.join('\n');
    if (!r.into) {
      this.drop(r, id);
      return { status: 'done', note: `${said}\nThe branch ${r.branch} is left in the project folder for the boss.\nBranch: ${r.branch}.` };
    }
    const m = R.merge(r.repo, r.into, r.branch);
    if (m.ok) { this.drop(r, id); return { status: 'done', note: `${said}\nBranch: ${r.into}.` }; }
    if (!m.conflict) return { status: 'failed', note: `Could not merge into ${r.into}: ${m.err}` };
    const files = m.files.join(', ');
    if ((r.tries || 0) >= 1) { this.drop(r, id); return { status: 'failed', note: `The branch ${r.branch} still does not merge into ${r.into}. Files: ${files}.` }; }
    const t = this.read(id);
    if (!t || !t.staff || !this.tasks) return { status: 'failed', note: `The branch ${r.branch} does not merge into ${r.into}. Files: ${files}.` };
    this.setRec(id, { ...r, tries: 1, fix: '', why: 'merge' });
    const fid = this.tasks.add(t.staff, `Your branch does not merge into the job's branch. Files: ${files}. In ${r.wt}, run git merge ${r.into}, fix the conflicts, commit, and report.`,
      { from: 'pa', project: t.project || '', job: t.job || '', kind: 'code', continues: id, fixes: id });
    this.setRec(id, { ...this.rec(id), fix: fid });
    setImmediate(() => { try { this.tasks.scan(); } catch { /* next change */ } }); // the follow-up waited for the record
    return { status: 'checking', note: `Merge conflict in ${files}: a follow-up was given to the author.` };
  }
  // The commit the task's branch is on now ('' when it cannot be read).
  head(r) { const x = R.git(r.repo, ['rev-parse', '--verify', '-q', `refs/heads/${r.branch}`]); return x.ok ? x.out : ''; }
  // The tests failed: one more round for the author, or the boss decides.
  testsFail(id, r, cmd, tail) { return this.roundOrBoss(id, r, { kind: 'tests', cmd, text: String(tail || '').slice(-6000) }); }
  // last: { kind: 'tests' | 'review', text (the tail or the findings), cmd?, none? (no verdict line) }.
  // Test failures and review changes share one count: past MAX_ROUNDS (plus each round the boss added) the boss decides.
  roundOrBoss(id, r, last) {
    const t = this.read(id);
    if (!t || !t.staff || !this.tasks) return this.noAuthor(id, r, last);
    const next = { ...r, last };
    return (Number(r.round) || 0) >= MAX_ROUNDS + (Number(r.extra) || 0) ? this.askBoss(id, next) : this.giveBack(id, next);
  }
  noAuthor(id, r, last) {
    this.drop(r, id);
    return { status: 'failed', note: last.kind === 'tests' ? `The project's tests fail (${last.cmd}).\n\n${fence(last.text)}` : `The reviewer asked for changes.\n\n${fence(last.text)}` };
  }
  // A follow-up for the author in the same worktree with the last findings (round goes up).
  giveBack(id, r) {
    const t = this.read(id), last = r.last || {}, tests = last.kind === 'tests', round = (Number(r.round) || 0) + 1;
    if (!t || !t.staff || !this.tasks) return this.noAuthor(id, r, last);
    const next = { ...r, round, fix: '', why: tests ? 'tests' : 'review', reviewTask: '', reviewTries: 0 };
    for (const k of ['verdict', 'wait', 'resend']) delete next[k];
    this.setRec(id, next);
    try { this.tasks.write(id, { round }); } catch { /* a copy for people */ }
    const text = tests ? `The project's tests fail after your change (${last.cmd}). Fix it in ${r.wt}, commit, and report.\n\n${fence(last.text)}`
      : `The reviewer asked for changes.${last.none ? ` ${NO_VERDICT}` : ''}\n\n${fence(last.text)}\n\nFix these in ${r.wt}, commit, and report.`;
    const fid = this.tasks.add(t.staff, text, { from: 'pa', project: t.project || '', job: t.job || '', kind: 'code', continues: id, fixes: id });
    this.setRec(id, { ...this.rec(id), fix: fid });
    setImmediate(() => { try { this.tasks.scan(); } catch { /* next change */ } });
    return { status: 'checking', stage: tests ? 'tests' : 'review', note: `${tests ? "The project's tests fail" : 'The reviewer asked for changes'}: a follow-up was given to the author.` };
  }
  // Past the rounds: an approval of kind rounds (recorded here, where staff cannot write), and the task waits for the boss.
  askBoss(id, r) {
    this.setRec(id, { ...r, wait: 'boss' });
    this.card(id);
    return { status: 'checking', stage: (r.last || {}).kind === 'tests' ? 'tests' : 'review' };
  }
  card(id) {
    const r = this.rec(id);
    const a = O.addApproval(this.dir, { from: 'Office', ...this.roundsCard(id), project: r.project || '', kind: 'rounds', ref: id }, { office: true, avoid: r.roundsApproval });
    const cur = this.rec(id);
    this.setRec(id, { ...cur, roundsApproval: a.id, roundsApprovals: [...(Array.isArray(cur.roundsApprovals) ? cur.roundsApprovals : []), a.id].slice(-20) });
  }
  // The rounds card the boss sees, built from the office's own record (never from the approval file, which staff can write).
  roundsCard(id) {
    const r = this.rec(id); if (!r) return null;
    const t = this.read(id) || {}, last = r.last || {}, job = r.into ? r.into.replace(/^office\//, '') : '', j = job ? this.jobOf(job) : null;
    let team = []; try { team = (this.loadCfg() || {}).staff || []; } catch { team = []; }
    const text = `${last.none ? `${NO_VERDICT}\n` : ''}${String(last.text || '').trim()}`.trim();
    return { action: `Task "${t.title || id}" has not passed after ${Number(r.round) || 0} rounds`,
      details: [`Written by ${(team.find((s) => s.id === t.staff) || {}).name || t.staff || 'a staff'}.`, ...(job ? [`Job: ${(j && j.title) || job}.`] : []),
        ...(r.project ? [`Project: ${r.project}.`] : []), `Branch: ${r.branch}.`, '', 'Last findings:',
        indent((last.kind === 'tests' ? text.slice(-3000) : text.slice(0, 3000)) || '(none)'), '', CHOICES].join('\n') };
  }
  // A task waiting for the boss whose card was deleted or no longer pending (edited) gets a fresh card.
  roundsCards() {
    if (!this.tasks) return;
    for (const [id, r] of Object.entries(this.load())) {
      if (!FILE_ID.test(id) || !this.ok(r) || r.wait !== 'boss') continue;
      const t = this.read(id); if (!t || t.status !== 'checking') continue;
      let live = false; try { live = !!r.roundsApproval && O.getApproval(this.dir, r.roundsApproval).status === 'pending'; } catch { /* gone */ }
      if (!live) this.card(id);
    }
  }
  // The boss can still decide this card: the task is checking and waits for exactly this approval.
  waitsFor(id, aid) { const r = this.rec(id), t = this.read(id); return !!(r && t && t.status === 'checking' && r.wait === 'boss' && r.roundsApproval === aid); }
  // The boss decided (only through the decide route): accept merges as it is, again gives one more round, stop ends the task.
  decided(id, decision) {
    const r = this.rec(id); if (!r || !this.tasks) return;
    const rest = { ...r }; delete rest.wait;
    if (decision === 'stop') { this.setRec(id, rest); this.tasks.stop(id); return; }
    this.setRec(id, decision === 'accept' ? { ...rest, accepted: true } : { ...rest, extra: (Number(r.extra) || 0) + 1, resend: true });
    this.tasks.check(id);
  }

  // The review gate. { line } to go on (merge), or { end } (what afterRun answers now).
  reviewStep(id, r) {
    if (!r.into && r.review !== true) return { line: '' };
    if (r.reviewed) return { line: r.reviewed };
    const t = this.read(id), who = t ? this.reviewer(t.staff) : null;
    if (!who) return { line: NO_REVIEWER };
    if (r.reviewTask) {
      const v = r.verdict && r.verdict.task === r.reviewTask ? r.verdict : null; // what the office saw when the run ended, never the task file
      if (v && v.status === 'done') {
        const p = verdict(v.result);
        if (p.pass) { const line = `Review: passed (${v.name || 'the reviewer'}).`; this.setRec(id, { ...r, reviewed: line }); return { line }; }
        return { end: this.roundOrBoss(id, r, { kind: 'review', text: p.findings, none: p.none }) };
      }
      if ((Number(r.reviewTries) || 0) >= 2) { this.drop(r, id); return { end: { status: 'failed', note: REVIEW_GONE } }; } // a fresh one did not finish either
    }
    return { end: this.writeReview(id, r, t, who) };
  }
  // Any active staff whose role says review, never the author: { role } (the first free one takes it), or { staff } when
  // the author has that same role. null: no reviewer on the team.
  reviewer(author) {
    let team = []; try { team = (this.loadCfg() || {}).staff || []; } catch { team = []; }
    const role = (s) => String(s.role || '').trim(), revs = team.filter((s) => s.id !== author && /review/i.test(role(s)));
    if (!revs.length) return null;
    const mine = role(team.find((s) => s.id === author) || {}).toLowerCase(), pick = revs.find((s) => role(s).toLowerCase() !== mine);
    return pick ? { role: role(pick) } : { staff: revs[0].id };
  }
  writeReview(id, r, t, who) {
    let team = []; try { team = (this.loadCfg() || {}).staff || []; } catch { team = []; }
    const author = (team.find((s) => s.id === t.staff) || {}).name || t.staff || 'a staff', job = r.into ? r.into.replace(/^office\//, '') : '';
    const text = `Review task ${id} ("${t.title || id}") by ${author}. Branch ${r.branch}, in ${r.wt}. See the change with git -C "${r.wt}" diff ${r.base}...HEAD (or log -p). Read the diff, not just the summary. Start your report with VERDICT: pass or VERDICT: changes, then your findings with file and line. Do not edit anything.`;
    const rid = this.tasks.add(who.staff || '', text, { from: 'pa', project: r.project || '', job, kind: 'review', reviews: id, ...(who.staff ? {} : { role: who.role }), ...(r.reviewTask ? { again: r.reviewTask } : {}) }, { scan: false, avoid: r.reviewTask });
    const next = { ...r, reviewTask: rid, reviewTries: r.reviewTask ? 2 : 1 }; delete next.verdict;
    this.setRec(id, next);
    setImmediate(() => { try { this.tasks.scan(); } catch { /* next change */ } }); // recorded first: its run gets the review's tools and folder
    return { status: 'checking', stage: 'review' };
  }
  // The engine tells the office how its review task ended (status and report), into the office's own record.
  reviewEnded(id, rid, status, result, name) {
    const r = this.rec(id);
    if (r && r.reviewTask === rid) this.setRec(id, { ...r, verdict: { task: rid, status, result: String(result || '').slice(0, 20000), name: String(name || '') } });
  }
  // A checking task whose review ended (or was stopped or deleted while waiting): the office goes on with it.
  reviewGone(t) {
    const r = this.rec(t.id); if (!r || !r.reviewTask || r.wait === 'boss') return false;
    if (r.verdict && r.verdict.task === r.reviewTask) return true;
    const rv = this.read(r.reviewTask); return !rv || !['new', 'working'].includes(rv.status);
  }
  // What a checking task waits for in the review gate, for the board ('' when nothing of it).
  reasonOf(t, nameOf) {
    const r = this.rec(t.id); if (!r) return '';
    if (r.wait === 'boss') return `Waiting for the boss: not passed after ${Number(r.round) || 0} rounds`;
    const rv = r.reviewTask && !r.verdict && this.read(r.reviewTask);
    if (rv && ['new', 'working'].includes(rv.status)) return `Waiting for ${rv.staff ? nameOf(rv.staff) : `the next free ${rv.role || 'reviewer'}`} to review`;
    const f = r.why === 'review' && r.fix && this.read(r.fix);
    return f && ['new', 'working'].includes(f.status) ? `Waiting for ${nameOf(f.staff)} to fix (round ${Number(r.round) || 0})` : '';
  }
  // What the follow-up a checking task waits for fixes ('tests' or 'merge'), its round, and the line when it did not finish.
  fixWhat(t) { const r = this.rec(t.id); return r && r.why === 'tests' ? 'tests' : 'merge'; }
  roundOf(t) { const r = this.rec(t.id); return r ? Number(r.round) || 0 : 0; }
  fixGone(id) { return gone(this.rec(id)); }
  // Remove a worktree, unless another live task still uses it, or the folders are not what the office made.
  drop(r, id) {
    if (!there(r.wt) || !this.rootReady() || !this.repoOk(r.repo)) return;
    const reg = this.load(), wt = key(r.wt);
    if (this.tasks && this.tasks.list().some((x) => x.id !== id && LIVE.includes(x.status) && this.wtOf(x, reg) === wt)) return;
    R.removeWorktree(r.repo, r.wt, this.root);
  }

  // Leftovers saved, then the worktree removed (also when it was left on another branch: its commits stay on that branch).
  saveAndDrop(r, id) {
    if (!there(r.wt) || !this.rootReady() || !this.repoOk(r.repo)) return;
    const c = R.commitAll(r.repo, r.wt, r.branch, this.root, WIP);
    if (c.ok || /^The work is on branch /.test(c.err)) this.drop(r, id);
  }
  // A conflict follow-up ended: when its task is over (the boss stopped it meanwhile), its worktree goes now.
  release(id) { const t = this.read(id), r = this.rec(id); if (t && r && !LIVE.includes(t.status)) this.saveAndDrop(r, id); }
  // A checking task waiting on a conflict follow-up that is gone or ended another way: why it cannot go on, or ''.
  stuck(t) {
    const r = this.rec(t.id); if (!r || !r.fix) return '';
    const f = this.read(r.fix);
    return !f || ['failed', 'stopped'].includes(f.status) ? gone(r) : '';
  }
  // The id of the conflict follow-up a checking task is waiting for, or ''.
  waitingFix(t) { const r = this.rec(t.id), f = r && r.fix && this.read(r.fix); return f && ['new', 'working'].includes(f.status) ? f.id : ''; }
  // The boss stops a checking task: its follow-up is cancelled, leftovers saved, the worktree removed; the branch stays.
  stopCheck(t) {
    const r = this.rec(t.id);
    if (!r) return { ok: true, note: 'Stopped by the boss while the office was finishing it.' };
    const f = r.fix && this.read(r.fix), rv = r.reviewTask && this.read(r.reviewTask);
    if (f && ['new', 'working'].includes(f.status) && this.tasks) this.tasks.stop(f.id);
    if (rv && ['new', 'working'].includes(rv.status) && this.tasks) this.tasks.stop(rv.id); // its review is no longer needed
    if (!f || f.status !== 'working') this.saveAndDrop(r, t.id); // a running follow-up is stopped first; release() removes the worktree when it has ended
    return { ok: true, note: STOPPED(r.branch) };
  }

  // Start-up: worktrees of tasks that are over (or gone) are removed, leftovers saved first; tasks left checking finish.
  // Records of tasks that are over and whose worktree is gone are dropped.
  recover() {
    killRecorded(this.ledger, this.checkMs + 5 * 60 * 1000); // checks an office that died left running
    if (!this.software() || !this.tasks) return;
    const all = this.tasks.list(), reg = this.load(), byId = new Map(all.map((t) => [t.id, t]));
    const repos = new Set(Object.values(reg).filter((r) => this.ok(r)).map((r) => r.repo));
    for (const p of (() => { try { return fs.readdirSync(path.join(this.dir, 'projects')); } catch { return []; } })()) {
      const pr = projectRepo(this.dir, p); if (pr.how !== 'none' && !pr.why && R.isRepo(pr.repo)) repos.add(pr.repo);
    }
    for (const repo of [...repos]) if (!this.repoOk(repo)) repos.delete(repo);
    const rootOk = this.rootReady(); // a worktrees folder that is a link: no worktree is touched, nothing is pruned
    if (rootOk) for (const repo of repos) R.prune(repo);
    const inUse = new Set(all.filter((t) => LIVE.includes(t.status)).map((t) => this.wtOf(t, reg)).filter(Boolean));
    for (const [id, r] of Object.entries(reg)) {
      if (!this.ok(r)) continue;
      if (!rootOk || inUse.has(key(r.wt)) || !there(r.wt) || !repos.has(r.repo)) continue;
      const c = R.commitAll(r.repo, r.wt, r.branch, this.root, WIP);
      if (c.ok || /^The work is on branch /.test(c.err)) R.removeWorktree(r.repo, r.wt, this.root); // a switched branch keeps its commits on that branch
    }
    for (const repo of rootOk ? repos : []) { // office worktrees the record does not know (it was lost): only empty task ids that are over
      for (const w of R.listWorktrees(repo)) {
        const id = w.branch.startsWith('office/') ? w.branch.slice(7) : '';
        if (!id || inUse.has(key(w.dir)) || key(w.dir) !== key(path.join(this.root, id))) continue;
        const t = byId.get(id); if (t && LIVE.includes(t.status)) continue;
        R.removeWorktree(repo, w.dir, this.root);
      }
    }
    let dirty = false;
    for (const [id, r] of Object.entries(reg)) {
      const t = byId.get(id);
      if (!t || (!LIVE.includes(t.status) && !(this.ok(r) && there(r.wt)))) { delete reg[id]; dirty = true; }
    }
    if (dirty) this.save(reg);
    for (const t of all) if (t.status === 'checking') this.tasks.check(t.id);
  }
}

Gates.runCheck = runCheck;

module.exports = { Gates, projectRepo, runCheck, keepTail, verdict, NOT_READY, NOT_READY_TASK, NO_REPO, CODE_BAD, ROOT_BAD, CLASH, MAX_ROUNDS };
