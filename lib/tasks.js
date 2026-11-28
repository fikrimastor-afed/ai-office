// Staff tasks. In dashboard chats the PA hands out work by writing tasks/<id>.md; the office
// runs each task as the staff's own Claude Code run (in staff/<id>/), so the PA's chat is
// free again in seconds. One task at a time per staff; different staff work in parallel.
//
//   tasks/<id>.md   ---
//                   staff: shah
//                   role: Sales                      (used when staff is empty: any active staff with this role takes it)
//                   from: pa | <staff id>            (who asked; the answer goes back to them)
//                   project: kedai-ali-website      (optional)
//                   needs: <task id>, <task id>      (optional: waits until those tasks are done)
//                   continues: <task id>             (optional: a follow-up; same staff, resumes that task's Claude session, waits until it has ended)
//                   again: <task id>                 (written on Run again; this task stands in for that one in needs)
//                   session: <Claude session id>     (written by the office when the task runs)
//                   status: new | working | checking | done | failed | stopped   (checking: the run ended fine and the office is finishing it, see lib/gates.js)
//                   kind: code | test | ...          (optional; in a software office a code or test task of a project gets its own branch)
//                   branch / worktree / base         (written by the office for a coding task: copies for people, never read back)
//                   created / started / finished: times
//                   ---
//                   <the task>
//                   ## Result      (written by the office: the staff's report)

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const md = require('./md');
const { describe } = require('./chat');

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/; // a Claude session id; anything else (say "--flag") is never passed on
const nowIso = () => new Date().toISOString();

class Tasks {
  // hooks: { access(staffId) -> {allowed, paths, note, shell}, claude() -> {cmd, pre}, env(cwd), loadCfg(),
  //          onStart(task), onEnd(task, result), onBlocked?(task, needIds),
  //          jobOf?(task) -> { status } | null  (the job a task names; null: no such job; absent: jobs are not wired and job: changes nothing),
  //          gates?: a Gates (lib/gates.js): hold, prepare, owns, fixOf, afterRun (absent: every task runs in place, as before) }
  constructor(dir, hooks) {
    this.dir = dir; this.h = hooks;
    this.root = path.join(dir, 'tasks');
    this.running = new Map(); // staff id -> { id, child }
    this.queued = new Map(); // staff id -> [task id]
    this.pool = []; // ids of role tasks ready to start, oldest first; the first free staff with the role takes it
    this.told = new Map(); // task id -> the blocking needs the office was already told about
    this.holds = new Map(); // task id -> why the office holds it (its project's repo is not ready)
    this.checking = new Map(); // task id -> { staff, stage, busy }: the run ended, the office is finishing it
    this.notes = new Map(); // task id -> a line for the board and the result (a coding task that runs in place)
    fs.mkdirSync(this.root, { recursive: true });
  }

  file(id) { return path.join(this.root, `${id}.md`); }
  read(id) {
    const text = fs.readFileSync(this.file(id), 'utf8');
    const { fields, body } = md.parse(text);
    const task = (md.section(`\n${body}`, 'Result') !== null ? body.slice(0, body.search(/^## Result/m)) : body).trim();
    let created = String(fields.created || ''); // hand-written tasks have none: use when the file was written (not saved into it)
    if (!created) try { created = fs.statSync(this.file(id)).mtime.toISOString(); } catch { created = ''; }
    return { id, ...fields, created, status: fields.status || 'new', task, title: task.split('\n')[0].slice(0, 120), result: md.section(body, 'Result') || '', _text: text };
  }
  write(id, fields, result) {
    let text = md.setFields(fs.readFileSync(this.file(id), 'utf8'), fields);
    if (result != null) text = md.setSection(text, 'Result', result || '(no report)');
    const tmp = `${this.file(id)}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, this.file(id));
  }
  list() {
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return []; }
    return names.filter((n) => n.endsWith('.md') && FILE_ID.test(n.slice(0, -3))).map((n) => { try { return this.read(n.slice(0, -3)); } catch { return null; } })
      .filter(Boolean).map(({ _text, ...t }) => t).sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
  }

  // The office itself gives a staff a task (for example: do what the boss just approved).
  add(staff, text, fields = {}) {
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const who = staff || String(fields.role || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task'; // a role task has no staff yet
    let id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${who}`;
    for (let n = 2, base = id; fs.existsSync(this.file(id)); n++) id = `${base}-${n}`;
    fs.writeFileSync(this.file(id), md.make({ staff, from: 'pa', project: '', status: 'new', created: nowIso(), ...fields }, text));
    this.scan();
    return id;
  }

  // After a restart nothing is running any more: say so in the file, and mark it so the boss can run it again.
  recover() {
    const out = [];
    for (const t of this.list()) if (t.status === 'working') {
      this.write(t.id, { status: 'stopped', finished: nowIso(), interrupted: 'yes' }, 'Stopped: the office was restarted while this task was running.');
      out.push({ id: t.id, staff: t.staff, title: t.title });
    }
    return out;
  }
  // Tasks a restart cut off that the boss has not run again or dismissed yet.
  interrupted() { return this.list().filter((t) => t.interrupted === 'yes').map(({ id, staff, from, title, finished }) => ({ id, staff, from, title, finished })); }
  // Run a stopped or failed task again, as a new task with the same text; the old one stays as it was.
  rerun(id) {
    const t = this.read(id);
    if (!['stopped', 'failed'].includes(t.status)) { const e = new Error('Only a stopped or failed task can run again.'); e.status = 409; throw e; }
    if (t.interrupted === 'yes') this.write(id, { interrupted: 'rerun' });
    const keep = Object.fromEntries(['continues', 'job', 'kind', ...(t.staff ? [] : ['role'])].filter((k) => t[k]).map((k) => [k, t[k]]));
    return { ok: true, id: this.add(t.staff || '', t.task, { from: t.from || 'pa', project: t.project || '', ...keep, again: id }) };
  }
  dismiss(id) { const t = this.read(id); if (t.interrupted === 'yes') this.write(id, { interrupted: 'dismissed' }); return { ok: true }; }

  // needs: the tasks this one waits for ("a, b" or "a b")
  needsOf(t) { return String(t.needs || '').split(/[\s,]+/).filter(Boolean); }
  // A need is met when that task is done, or when a rerun of it (again: <id>) is met.
  isMet(id, all, seen = new Set()) {
    if (seen.has(id)) return false;
    seen.add(id);
    const x = all.find((y) => y.id === id);
    return !!x && (x.status === 'done' || all.some((y) => y.again === id && this.isMet(y.id, all, seen)));
  }
  // A follow-up also waits while the task it continues is new or working.
  waitingFor(t, all) {
    const w = this.needsOf(t).filter((id) => !this.isMet(id, all)), c = t.continues && all.find((y) => y.id === t.continues);
    if (c && (['new', 'working'].includes(c.status) || (c.status === 'checking' && this.gate('fixOf', t) !== c.id)) && !w.includes(c.id)) w.push(c.id);
    const turn = this.gate('turn', t, all); // follow-ups sharing one worktree take turns
    if (turn && !w.includes(turn)) w.push(turn);
    return w;
  }
  // Unmet needs that failed or were stopped, with no rerun on the way.
  blockedBy(t, all) {
    return this.waitingFor(t, all).filter((id) => {
      const x = all.find((y) => y.id === id);
      return x && ['failed', 'stopped'].includes(x.status) && !all.some((y) => y.again === id && ['new', 'working'].includes(y.status));
    });
  }
  // Every task this one needs or continues, directly or through others.
  reach(id, all) {
    const seen = new Set(), todo = [id];
    while (todo.length) { const cur = todo.pop(), x = all.find((y) => y.id === cur); if (x) for (const n of [...this.needsOf(x), ...(x.continues ? [x.continues] : [])]) if (!seen.has(n)) { seen.add(n); todo.push(n); } }
    return seen;
  }
  // A gates call that never throws into the engine.
  gate(fn, ...a) { const g = this.h.gates; if (!g) return fn === 'prepare' ? { ok: true } : ''; try { return g[fn](...a); } catch (e) { return fn === 'prepare' ? { ok: false, reason: e.message } : ''; } }
  hasRole(s, role) { return String(s.role || '').trim().toLowerCase() === role.toLowerCase(); }
  isRunning(id) { return [...this.running.values()].some((r) => r.id === id); }
  isHeld(id) { return [...this.running.values()].some((r) => r.id === id) || [...this.queued.values()].some((q) => q.includes(id)) || this.pool.includes(id); }
  // The job a task names, when jobs are wired and it exists.
  jobStatus(t) { const j = t.job && this.h.jobOf ? this.h.jobOf(t) : null; return j ? j.status : ''; }
  // A task of a job still waiting for the boss's OK on the plan waits for that.
  jobWait(t) { return this.jobStatus(t) === 'planned' ? "Waiting for the boss's OK on the plan" : ''; }
  // Why a new task cannot run at all (a plain reason), or ''.
  problem(t, all, cfg) {
    const needs = this.needsOf(t), from = t.from || 'pa';
    if (t.job && this.h.jobOf && !this.h.jobOf(t)) return `There is no job "${t.job}". Write jobs/${t.job}.md first.`;
    if (needs.includes(t.id)) return 'A task cannot need itself.';
    if (t.continues === t.id) return 'A task cannot continue itself.';
    const clash = this.gate('clash', t); if (clash) return clash;
    const gone = needs.find((id) => !all.some((y) => y.id === id));
    if (gone) return `Task "${gone}" in needs does not exist.`;
    if (this.reach(t.id, all).has(t.id)) return `These tasks need each other in a circle: ${[...this.reach(t.id, all)].filter((id) => this.reach(id, all).has(t.id)).sort().join(', ')}.`;
    const cont = t.continues && all.find((y) => y.id === t.continues);
    if (t.continues && !cont) return `Task "${t.continues}" in continues does not exist.`;
    if (cont && t.staff && cont.staff && t.staff !== cont.staff) return `A follow-up goes to the same staff as the task it continues (${cont.staff}).`;
    const team = cfg.staff || [], role = String(t.role || '').trim();
    if (!t.staff && cont && !cont.staff && cont.status === 'new') return ''; // waits for the role task it continues to be claimed
    if (!t.staff) return !role ? 'A task needs a staff or a role.' : !team.some((s) => this.hasRole(s, role)) ? `There is no active staff with the role "${role}".`
      : !team.some((s) => this.hasRole(s, role) && s.id !== from) ? `Only the one who asked has the role "${role}", and a staff cannot give a task to themselves.` : '';
    return !team.some((s) => s.id === t.staff) ? `There is no active staff with id "${t.staff || ''}".`
      : from !== 'pa' && !team.some((s) => s.id === from) ? `"${from}" is not on the team, so the task has nobody to report to.`
      : from === t.staff ? 'A staff cannot give a task to themselves.' : '';
  }
  fail(t, reason) {
    this.write(t.id, { status: 'failed', finished: nowIso() }, reason);
    this.h.onEnd({ ...t, from: t.from || 'pa', status: 'failed' }, reason);
  }
  tellBlocked(t, all) {
    const ids = this.blockedBy(t, all), key = ids.join(',');
    if (!ids.length) return this.told.delete(t.id);
    if (this.told.get(t.id) === key) return;
    this.told.set(t.id, key);
    if (this.h.onBlocked) this.h.onBlocked(t, ids);
  }
  // Tasks that are not started yet, with what each one is waiting for.
  board() {
    const all = this.list(), cfg = this.h.loadCfg(), nameOf = (id) => ((cfg.staff || []).find((x) => x.id === id) || {}).name || id;
    const turnWait = (t) => { const id = this.gate('turn', t, all), x = id && all.find((y) => y.id === id); return x ? `Waiting for ${x.title || x.id}` : ''; };
    const fixWait = (t) => { const id = this.gate('waitingFix', t), x = id && all.find((y) => y.id === id); return x ? `Waiting for ${nameOf(x.staff)} to fix the merge` : ''; };
    return { waiting: all.filter((t) => t.status === 'new' && !this.isRunning(t.id)).map((t) => {
      const reason = this.jobWait(t) || this.holds.get(t.id) || turnWait(t);
      return { id: t.id, staff: t.staff, role: t.role, job: t.job, title: t.title, created: t.created, waitingFor: this.waitingFor(t, all), blockedBy: this.blockedBy(t, all), ...(reason ? { reason } : {}) };
    }),
    checking: all.filter((t) => t.status === 'checking').map((t) => {
      const reason = fixWait(t);
      return { id: t.id, staff: t.staff, title: t.title, job: t.job, stage: (this.checking.get(t.id) || {}).stage || 'merge', round: Number(t.round) || 0, ...(reason ? { reason } : {}) };
    }) };
  }

  // Pick up new task files (called when tasks/ changes). Never runs inside itself: a task that ends while a
  // scan is starting others (spawn failed) asks for one more round instead.
  scan() {
    if (this.scanning) { this.again = true; return; }
    this.scanning = true;
    try { do { this.again = false; this.scanOnce(); } while (this.again); } finally { this.scanning = false; }
  }
  scanOnce() {
    const cfg = this.h.loadCfg();
    const all = this.list(); // newest first
    const failed = new Set(), memo = new Map(); // memo: one look at each project's repo per scan
    this.pool = this.pool.filter((id) => { // a pooled task may have gone, or lost its role
      const t = all.find((y) => y.id === id);
      if (!t || t.status !== 'new') return false;
      const bad = this.problem(t, all, cfg);
      if (bad) { this.fail(t, bad); failed.add(id); }
      return !bad;
    });
    for (const t of [...all].reverse()) { // oldest first
      if (t.status === 'checking' && !(this.checking.get(t.id) || {}).busy) { // its fix follow-up was cancelled, failed or deleted: it cannot go on
        const why = this.gate('stuck', t); if (why) this.endCheck(t.id, 'failed', why);
      }
      if (t.status !== 'new') { this.told.delete(t.id); this.holds.delete(t.id); continue; }
      if (this.jobStatus(t) === 'stopped' && !this.isRunning(t.id)) { // the job was stopped: its tasks that have not started are cancelled
        for (const q of this.queued.values()) { const i = q.indexOf(t.id); if (i >= 0) q.splice(i, 1); }
        this.pool = this.pool.filter((id) => id !== t.id); this.told.delete(t.id);
        this.write(t.id, { status: 'stopped', finished: nowIso() }, 'Stopped: the job was stopped.');
        continue;
      }
      if (this.isHeld(t.id) || failed.has(t.id)) continue;
      const cont = !t.staff && t.continues && all.find((y) => y.id === t.continues); // a follow-up goes to the same staff
      if (cont && cont.staff) { t.staff = cont.staff; this.write(t.id, { staff: cont.staff }); }
      const prev = cfg.type === 'software' && t.continues && all.find((y) => y.id === t.continues); // a follow-up of a coding task stays one
      const inherit = prev ? Object.fromEntries(['kind', 'job', 'project'].filter((k) => !String(t[k] || '').trim() && String(prev[k] || '').trim()).map((k) => [k, prev[k]])) : {};
      if (Object.keys(inherit).length) { Object.assign(t, inherit); this.write(t.id, inherit); }
      const bad = this.problem(t, all, cfg);
      if (bad) { this.fail(t, bad); continue; }
      if (this.waitingFor(t, all).length || this.jobWait(t)) { this.tellBlocked(t, all); continue; }
      const held = this.gate('hold', t, memo);
      if (held) { this.holds.set(t.id, held); continue; }
      this.holds.delete(t.id);
      if (!t.staff) { this.pool.push(t.id); continue; }
      if (!this.queued.has(t.staff)) this.queued.set(t.staff, []);
      this.queued.get(t.staff).push(t.id);
    }
    this.pumpAll();
  }

  // How many staff may run at once: maxParallel from office.json, 1 to 8, default 3.
  limit() { const n = Math.floor(Number(this.h.loadCfg().maxParallel)); return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 3; }

  pumpAll() {
    const cfg = this.h.loadCfg(), cand = []; // everything that could start now: [staff, id, created]
    for (const [staff, q] of this.queued) {
      if (this.running.has(staff) || !q.length) continue;
      let t; try { t = this.read(q[0]); } catch { q.shift(); continue; }
      cand.push([staff, q[0], t.created]);
    }
    const taken = new Set(cand.map((c) => c[0]));
    for (const id of [...this.pool]) { // role tasks: the first free staff with the role
      let t; try { t = this.read(id); } catch { continue; }
      const free = (cfg.staff || []).find((s) => this.hasRole(s, String(t.role || '').trim()) && s.id !== (t.from || 'pa') && !this.running.has(s.id) && !taken.has(s.id) && !(this.queued.get(s.id) || []).length);
      if (!free) continue;
      taken.add(free.id); cand.push([free.id, id, t.created]);
    }
    cand.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1])); // oldest first
    for (const [staff, id] of cand) {
      if (this.running.size >= this.limit()) break;
      if (this.running.has(staff) || this.isRunning(id)) continue; // a task that ended meanwhile may have changed things
      const q = this.queued.get(staff), p = this.pool.indexOf(id), inQ = !!q && q[0] === id;
      if (!inQ && p < 0) continue;
      let t = null; try { t = this.read(id); } catch { /* gone */ }
      if (inQ) q.shift(); else this.pool.splice(p, 1);
      if (!t || t.status !== 'new') continue;
      if (!inQ) try { this.write(id, { staff }); } catch { continue; }
      this.start(staff, id);
    }
  }

  start(staff, id) {
    let t; try { t = this.read(id); } catch { return; } // the file went away: nothing to run
    const cfg = this.h.loadCfg();
    const s = cfg.staff.find((x) => x.id === staff);
    const cwd = path.join(this.dir, 'staff', staff);
    const acc = this.h.access(staff, { task: true });
    const pa = (cfg.pa && cfg.pa.name) || 'the manager';
    const from = t.from && t.from !== 'pa' ? ((cfg.staff.find((x) => x.id === t.from) || {}).name || t.from) : pa;
    const prep = this.gate('prepare', t) || { ok: true };
    if (!prep.ok && prep.hold) { this.holds.set(id, prep.reason); return; } // stays new; looked at again on the next scan
    if (!prep.ok) return this.finish(staff, id, 'failed', prep.reason || 'Could not start.');
    if (prep.note) this.notes.set(id, prep.note);
    let prior = null; try { prior = t.continues ? this.read(t.continues) : null; } catch { /* gone */ }
    const resume = prior && SESSION.test(String(prior.session || '')) ? prior.session : '';
    const prompt = [prior ? `Follow-up from ${from} (task ${id}, continuing task ${t.continues}):` : `Task from ${from} (task ${id}):`, '', t.task, '',
      ...(prior && !resume ? [`You have no memory of task ${t.continues}: read ${path.resolve(this.file(t.continues))} first.`, ''] : []),
      `The office folder is ${this.dir}.${t.project ? ` Project: ${path.join(this.dir, 'projects', t.project)} (read its CLAUDE.md first).` : ''}`,
      ...(prep.cwdNote ? [prep.cwdNote] : []),
      `Do the work now. End with a short report for ${from}: what you did (or the answer), file paths, and anything waiting for the boss's OK.`].join('\n');
    const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(acc.shell ? ['Bash'] : [])];
    const mcp = this.h.mcp ? this.h.mcp(cfg, staff) : { args: [], env: {} }; // only the MCP servers this job needs
    const args = ['-p', prompt, ...(resume ? ['--resume', resume] : []), '--output-format', 'stream-json', '--verbose', '--permission-mode', acc.auto ? 'auto' : 'default',
      '--tools', tools.join(','), '--allowedTools', acc.allowed.filter((x) => x !== 'Agent').join(','), '--disallowedTools', (acc.denied || []).join(','),
      ...acc.paths.flatMap((d) => ['--add-dir', d]), '--append-system-prompt', acc.note, ...(acc.auto ? ['--settings', require('./templates').autoSettings(cfg, this.dir, acc.linked)] : []), ...require('./templates').runFlags(cfg, staff), ...mcp.args];
    const { cmd, pre } = this.h.claude();
    try { this.write(id, { status: 'working', started: nowIso() }); } catch (e) { return this.finish(staff, id, 'failed', `Could not start: ${e.message}`); }
    let child;
    try { child = spawn(cmd, [...pre, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...this.h.env(cwd, staff === 'pa' ? 'task' : staff), ...mcp.env } }); } catch (e) {
      return this.finish(staff, id, 'failed', `Could not start Claude Code: ${e.message}`);
    }
    this.running.set(staff, { id, child });
    this.h.onStart({ ...t, from: t.from || 'pa', status: 'working', name: s ? s.name : staff });
    let saved = false, buf = '', said = '', err = '', lastErr = '';
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const j = JSON.parse(line);
          if (!saved && j.type === 'system' && j.subtype === 'init' && SESSION.test(String(j.session_id || ''))) { saved = true; try { this.write(id, { session: j.session_id }); } catch { /* file removed */ } }
          if (this.h.onUsage) this.h.onUsage(j, staff, 'task', id);
          if (j.type === 'assistant' && !j.parent_tool_use_id) {
            const x = (j.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(); if (x) said = x;
            for (const c of j.message.content || []) if (c.type === 'tool_use') this.step(staff, describe(c.name, c.input, (sid) => ((cfg.staff || []).find((y) => y.id === sid) || {}).name || sid));
          }
          if (j.type === 'result' && j.is_error) lastErr = String(j.result || j.subtype || 'error');
        } catch { /* not ours */ }
      }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { lastErr = e.message; });
    child.on('close', (code) => {
      if (child.stopped) return this.finish(staff, id, 'stopped', 'Stopped by the boss.');
      if (lastErr || (code !== 0 && !said)) return this.finish(staff, id, 'failed', (lastErr || err || 'Claude stopped with an error').trim().slice(0, 1500));
      return this.finish(staff, id, 'done', said);
    });
  }

  finish(staff, id, status, result) {
    this.running.delete(staff);
    let t0 = null; try { t0 = this.read(id); } catch { /* gone */ }
    const note = this.notes.get(id); this.notes.delete(id);
    if (note && status === 'done') result = [result, note].filter(Boolean).join('\n\n');
    if (t0 && status === 'done' && this.gate('owns', t0)) { // a coding task: the office finishes it (merge) before it is done
      try { this.write(id, { status: 'checking' }, result); } catch { /* file removed */ }
      this.check(id);
      return this.scan();
    }
    try { this.write(id, { status, finished: nowIso() }, result); } catch { /* file removed */ }
    let t = { id, staff, status };
    try { t = { ...this.read(id), status }; } catch { /* gone */ }
    const cfg = this.h.loadCfg();
    this.h.onEnd({ ...t, from: t.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === staff) || {}).name || staff }, result);
    const orig = t0 ? this.gate('fixOf', t0) : ''; // the office's conflict follow-up ended: back to the task it fixes
    if (orig) { if (status === 'done') this.check(orig); else this.endCheck(orig, 'failed', 'The follow-up to fix the merge did not finish.'); this.gate('release', orig); }
    this.scan();
  }

  // A checking task: the office's steps after the run (lib/gates.js afterRun), then done or failed.
  // afterRun answering checking means it gave the author a follow-up; this runs again when that ends.
  check(id) {
    const cur = this.checking.get(id), g = this.h.gates;
    if (!g || (cur && cur.busy)) return;
    let t; try { t = this.read(id); } catch { this.checking.delete(id); return; }
    if (t.status !== 'checking') { this.checking.delete(id); return; }
    this.checking.set(id, { staff: t.staff, stage: 'merge', busy: true });
    Promise.resolve().then(() => g.afterRun(t)).catch((e) => ({ status: 'failed', note: `Could not finish the task: ${e.message}` })).then((r) => {
      r = r || {};
      if (r.status === 'checking') { this.checking.set(id, { staff: t.staff, stage: 'merge', busy: false }); this.scan(); return; }
      this.endCheck(id, r.status === 'done' ? 'done' : 'failed', r.note);
    }).catch(() => { /* never throws out of the engine */ });
  }
  endCheck(id, status, note) {
    this.checking.delete(id);
    let t; try { t = this.read(id); } catch { return this.scan(); }
    if (t.status !== 'checking') return this.scan();
    const result = [t.result, note].filter(Boolean).join('\n\n');
    try { this.write(id, { status, finished: nowIso() }, result); } catch { /* file removed */ }
    const cfg = this.h.loadCfg();
    this.h.onEnd({ ...t, status, from: t.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === t.staff) || {}).name || t.staff }, result);
    this.scan();
  }

  stop(id) {
    for (const [staff, r] of this.running) {
      if (r.id !== id) continue;
      r.child.stopped = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(r.child.pid), '/t', '/f'], { windowsHide: true });
      else r.child.kill('SIGTERM');
      return { ok: true };
    }
    let cur = null; try { cur = this.read(id); } catch { /* no such task */ }
    if (cur && cur.status === 'checking') { // the office is finishing it: stop it unless a git step is running right now
      if ((this.checking.get(id) || {}).busy) return { ok: false, reason: 'The office is in the middle of a git step for this task. Try again in a moment.' };
      const r = this.gate('stopCheck', cur) || {};
      this.checking.delete(id);
      const result = [cur.result, r.note || 'Stopped by the boss while the office was finishing it.'].filter(Boolean).join('\n\n');
      try { this.write(id, { status: 'stopped', finished: nowIso() }, result); } catch { /* file removed */ }
      const cfg = this.h.loadCfg();
      this.h.onEnd({ ...cur, status: 'stopped', from: cur.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === cur.staff) || {}).name || cur.staff }, result);
      this.scan();
      return { ok: true };
    }
    for (const q of this.queued.values()) { const i = q.indexOf(id); if (i >= 0) { q.splice(i, 1); this.write(id, { status: 'stopped', finished: nowIso() }, 'Cancelled by the boss before it started.'); return { ok: true }; } }
    const p = this.pool.indexOf(id); if (p >= 0) this.pool.splice(p, 1);
    try { if (this.read(id).status === 'new') { this.write(id, { status: 'stopped', finished: nowIso() }, 'Cancelled by the boss before it started.'); this.told.delete(id); return { ok: true }; } } catch { /* no such task */ }
    return { ok: false };
  }

  stopAll() { for (const r of this.running.values()) this.stop(r.id); }
  active() { return [...this.running.entries()].map(([staff, r]) => ({ staff, id: r.id, step: r.step || '', ...(this.notes.get(r.id) ? { note: this.notes.get(r.id) } : {}) })); }
  // what the staff is doing right now ("Writing index.html")
  step(staff, text) {
    const r = this.running.get(staff); if (!r) return;
    r.step = text;
    if (this.h.onStep) this.h.onStep({ staff, id: r.id, step: text });
  }
}

module.exports = { Tasks };
