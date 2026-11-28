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
//                   session: <Claude session id>     (written by the office when the task runs)
//                   status: new | working | done | failed | stopped
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
const nowIso = () => new Date().toISOString();

class Tasks {
  // hooks: { access(staffId) -> {allowed, paths, note, shell}, claude() -> {cmd, pre}, env(cwd), loadCfg(),
  //          onStart(task), onEnd(task, result), onBlocked?(task, needIds) }
  constructor(dir, hooks) {
    this.dir = dir; this.h = hooks;
    this.root = path.join(dir, 'tasks');
    this.running = new Map(); // staff id -> { id, child }
    this.queued = new Map(); // staff id -> [task id]
    this.pool = []; // ids of role tasks ready to start, oldest first; the first free staff with the role takes it
    this.told = new Map(); // task id -> the blocking needs the office was already told about
    fs.mkdirSync(this.root, { recursive: true });
  }

  file(id) { return path.join(this.root, `${id}.md`); }
  read(id) {
    const text = fs.readFileSync(this.file(id), 'utf8');
    const { fields, body } = md.parse(text);
    const task = (md.section(`\n${body}`, 'Result') !== null ? body.slice(0, body.search(/^## Result/m)) : body).trim();
    return { id, ...fields, status: fields.status || 'new', task, title: task.split('\n')[0].slice(0, 120), result: md.section(body, 'Result') || '', _text: text };
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
      .filter(Boolean).map(({ _text, ...t }) => t).sort((a, b) => (b.created || b.id).localeCompare(a.created || a.id));
  }

  // The office itself gives a staff a task (for example: do what the boss just approved).
  add(staff, text, fields = {}) {
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    let id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${staff}`;
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
    return { ok: true, id: this.add(t.staff, t.task, { from: t.from || 'pa', project: t.project || '', again: id }) };
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
    if (c && ['new', 'working'].includes(c.status) && !w.includes(c.id)) w.push(c.id);
    return w;
  }
  // Unmet needs that failed or were stopped, with no rerun on the way.
  blockedBy(t, all) {
    return this.waitingFor(t, all).filter((id) => {
      const x = all.find((y) => y.id === id);
      return x && ['failed', 'stopped'].includes(x.status) && !all.some((y) => y.again === id && ['new', 'working'].includes(y.status));
    });
  }
  // Every task this one needs, directly or through others.
  reach(id, all) {
    const seen = new Set(), todo = [id];
    while (todo.length) { const cur = todo.pop(), x = all.find((y) => y.id === cur); if (x) for (const n of this.needsOf(x)) if (!seen.has(n)) { seen.add(n); todo.push(n); } }
    return seen;
  }
  hasRole(s, role) { return String(s.role || '').trim().toLowerCase() === role.toLowerCase(); }
  isHeld(id) { return [...this.running.values()].some((r) => r.id === id) || [...this.queued.values()].some((q) => q.includes(id)) || this.pool.includes(id); }
  // Why a new task cannot run at all (a plain reason), or ''.
  problem(t, all, cfg) {
    const needs = this.needsOf(t), from = t.from || 'pa';
    if (needs.includes(t.id)) return 'A task cannot need itself.';
    const gone = needs.find((id) => !all.some((y) => y.id === id));
    if (gone) return `Task "${gone}" in needs does not exist.`;
    if (this.reach(t.id, all).has(t.id)) return `These tasks need each other in a circle: ${[...this.reach(t.id, all)].filter((id) => this.reach(id, all).has(t.id)).sort().join(', ')}.`;
    const cont = t.continues && all.find((y) => y.id === t.continues);
    if (t.continues && !cont) return `Task "${t.continues}" in continues does not exist.`;
    if (cont && t.staff && cont.staff && t.staff !== cont.staff) return `A follow-up goes to the same staff as the task it continues (${cont.staff}).`;
    const team = cfg.staff || [], role = String(t.role || '').trim();
    if (!t.staff) return !role ? 'A task needs a staff or a role.' : !team.some((s) => this.hasRole(s, role)) ? `There is no active staff with the role "${role}".` : '';
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
    const all = this.list();
    return { waiting: all.filter((t) => t.status === 'new' && (!this.isHeld(t.id) || this.pool.includes(t.id))).map((t) => ({ id: t.id, staff: t.staff, role: t.role, job: t.job, title: t.title, created: t.created,
      waitingFor: this.waitingFor(t, all), blockedBy: this.blockedBy(t, all) })) };
  }

  // Pick up new task files (called when tasks/ changes).
  scan() {
    const cfg = this.h.loadCfg();
    const all = this.list(); // newest first
    const failed = new Set();
    this.pool = this.pool.filter((id) => { // a pooled task may have gone, or lost its role
      const t = all.find((y) => y.id === id);
      if (!t || t.status !== 'new') return false;
      const bad = this.problem(t, all, cfg);
      if (bad) { this.fail(t, bad); failed.add(id); }
      return !bad;
    });
    for (const t of [...all].reverse()) { // oldest first
      if (t.status !== 'new') { this.told.delete(t.id); continue; }
      if (this.isHeld(t.id) || failed.has(t.id)) continue;
      const cont = !t.staff && t.continues && all.find((y) => y.id === t.continues); // a follow-up goes to the same staff
      if (cont && cont.staff) { t.staff = cont.staff; this.write(t.id, { staff: cont.staff }); }
      const bad = this.problem(t, all, cfg);
      if (bad) { this.fail(t, bad); continue; }
      if (this.waitingFor(t, all).length) { this.tellBlocked(t, all); continue; }
      if (!t.staff) { this.pool.push(t.id); continue; }
      if (!this.queued.has(t.staff)) this.queued.set(t.staff, []);
      this.queued.get(t.staff).push(t.id);
    }
    this.pumpAll();
  }

  pumpAll() {
    for (const staff of this.queued.keys()) {
      if (this.running.has(staff)) continue;
      const id = (this.queued.get(staff) || []).shift();
      if (id) this.start(staff, id);
    }
    for (const id of [...this.pool]) { // role tasks, oldest first: the first free staff with the role
      let t; try { t = this.read(id); } catch { continue; }
      const free = (this.h.loadCfg().staff || []).find((s) => this.hasRole(s, String(t.role || '').trim()) && !this.running.has(s.id) && !(this.queued.get(s.id) || []).length);
      if (!free) continue;
      this.pool.splice(this.pool.indexOf(id), 1);
      this.write(id, { staff: free.id });
      this.start(free.id, id);
    }
  }

  start(staff, id) {
    const t = this.read(id);
    const cfg = this.h.loadCfg();
    const s = cfg.staff.find((x) => x.id === staff);
    const cwd = path.join(this.dir, 'staff', staff);
    const acc = this.h.access(staff, { task: true });
    const pa = (cfg.pa && cfg.pa.name) || 'the manager';
    const from = t.from && t.from !== 'pa' ? ((cfg.staff.find((x) => x.id === t.from) || {}).name || t.from) : pa;
    let prior = null; try { prior = t.continues ? this.read(t.continues) : null; } catch { /* gone */ }
    const prompt = [prior ? `Follow-up from ${from} (task ${id}, continuing task ${t.continues}):` : `Task from ${from} (task ${id}):`, '', t.task, '',
      ...(prior && !prior.session ? [`You have no memory of task ${t.continues}: read ${path.resolve(this.file(t.continues))} first.`, ''] : []),
      `The office folder is ${this.dir}.${t.project ? ` Project: ${path.join(this.dir, 'projects', t.project)} (read its CLAUDE.md first).` : ''}`,
      `Do the work now. End with a short report for ${from}: what you did (or the answer), file paths, and anything waiting for the boss's OK.`].join('\n');
    const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(acc.shell ? ['Bash'] : [])];
    const mcp = this.h.mcp ? this.h.mcp(cfg, staff) : { args: [], env: {} }; // only the MCP servers this job needs
    const args = ['-p', prompt, ...(prior && prior.session ? ['--resume', prior.session] : []), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default',
      '--tools', tools.join(','), '--allowedTools', acc.allowed.filter((x) => x !== 'Agent').join(','), '--disallowedTools', (acc.denied || []).join(','),
      ...acc.paths.flatMap((d) => ['--add-dir', d]), '--append-system-prompt', acc.note, ...require('./templates').runFlags(cfg, staff), ...mcp.args];
    const { cmd, pre } = this.h.claude();
    this.write(id, { status: 'working', started: nowIso() });
    let child;
    try { child = spawn(cmd, [...pre, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...this.h.env(cwd), ...mcp.env } }); } catch (e) {
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
          if (!saved && j.type === 'system' && j.subtype === 'init' && j.session_id) { saved = true; try { this.write(id, { session: j.session_id }); } catch { /* file removed */ } }
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
    try { this.write(id, { status, finished: nowIso() }, result); } catch { /* file removed */ }
    let t = { id, staff, status };
    try { t = { ...this.read(id), status }; } catch { /* gone */ }
    const cfg = this.h.loadCfg();
    this.h.onEnd({ ...t, from: t.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === staff) || {}).name || staff }, result);
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
    for (const q of this.queued.values()) { const i = q.indexOf(id); if (i >= 0) { q.splice(i, 1); this.write(id, { status: 'stopped', finished: nowIso() }, 'Cancelled by the boss before it started.'); return { ok: true }; } }
    const p = this.pool.indexOf(id); if (p >= 0) this.pool.splice(p, 1);
    try { if (this.read(id).status === 'new') { this.write(id, { status: 'stopped', finished: nowIso() }, 'Cancelled by the boss before it started.'); this.told.delete(id); return { ok: true }; } } catch { /* no such task */ }
    return { ok: false };
  }

  stopAll() { for (const r of this.running.values()) this.stop(r.id); }
  active() { return [...this.running.entries()].map(([staff, r]) => ({ staff, id: r.id, step: r.step || '' })); }
  // what the staff is doing right now ("Writing index.html")
  step(staff, text) {
    const r = this.running.get(staff); if (!r) return;
    r.step = text;
    if (this.h.onStep) this.h.onStep({ staff, id: r.id, step: text });
  }
}

module.exports = { Tasks };
