// Jobs: a plan the lead writes, a status only the office sets.
//
//   jobs/<id>.md   ---
//                  project: shop              (optional)
//                  status: planned | approved | working | done | stopped     (written by the office; what a staff writes here is overwritten)
//                  ---
//                  <first line: the title>
//                  <the plan>
//
// The real status lives in .office/jobs.json (staff cannot edit it), as { <id>: { status, created } }.
// Tasks name their job with "job: <id>". A job starts planned: its tasks wait for the boss's OK.

const fs = require('fs');
const path = require('path');
const md = require('./md');

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const STATUSES = ['planned', 'approved', 'working', 'done', 'stopped'];
const nowIso = () => new Date().toISOString();

class Jobs {
  // hooks: { tasks?() -> every task (to list a job's task ids), onChange?(job) }
  constructor(dir, hooks = {}) {
    this.dir = dir; this.h = hooks;
    this.root = path.join(dir, 'jobs');
    this.reg = path.join(dir, '.office', 'jobs.json');
  }

  file(id) { return path.join(this.root, `${id}.md`); }
  load() { try { const j = JSON.parse(fs.readFileSync(this.reg, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
  save(data) {
    fs.mkdirSync(path.dirname(this.reg), { recursive: true });
    const tmp = `${this.reg}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, this.reg);
  }
  ids() {
    try { return fs.readdirSync(this.root).filter((n) => n.endsWith('.md') && FILE_ID.test(n.slice(0, -3))).map((n) => n.slice(0, -3)); } catch { return []; }
  }

  // A job from its file and the office's own record. A file the office has not seen yet counts as planned.
  get(id) {
    if (!FILE_ID.test(String(id || ''))) return null;
    let text; try { text = fs.readFileSync(this.file(id), 'utf8'); } catch { return null; }
    const { fields, body } = md.parse(text), rec = this.load()[id] || {};
    let created = rec.created || ''; if (!created) try { created = fs.statSync(this.file(id)).mtime.toISOString(); } catch { created = ''; }
    const all = this.h.tasks ? this.h.tasks() : [];
    return { id, title: body.split('\n')[0].trim().slice(0, 120), project: fields.project || '', status: STATUSES.includes(rec.status) ? rec.status : 'planned', created, tasks: all.filter((t) => t.job === id).map((t) => t.id) };
  }
  list() { return this.ids().map((id) => this.get(id)).filter(Boolean).sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id)); }

  // Safe to call often: records new job files as planned, and writes the real status into a file header only when it differs.
  sync() {
    fs.mkdirSync(this.root, { recursive: true });
    const reg = this.load(); let dirty = false;
    for (const id of Object.keys(reg)) { // a job whose file is gone loses its OK: a file written again under that id starts as planned
      try { fs.statSync(this.file(id)); } catch (e) { if (e.code === 'ENOENT') { delete reg[id]; dirty = true; } }
    }
    for (const id of this.ids()) {
      if (!reg[id] || !STATUSES.includes(reg[id].status)) { reg[id] = { status: 'planned', created: (reg[id] && reg[id].created) || nowIso() }; dirty = true; }
      this.stamp(id, reg[id].status);
    }
    if (dirty) this.save(reg);
  }
  stamp(id, status) {
    try {
      const text = fs.readFileSync(this.file(id), 'utf8');
      if (md.parse(text).fields.status === status) return;
      const tmp = `${this.file(id)}.${process.pid}.tmp`; fs.writeFileSync(tmp, md.setFields(text, { status })); fs.renameSync(tmp, this.file(id));
    } catch { /* file removed */ }
  }

  // The only way a status changes: called by the dashboard's routes and the engine, never from file content.
  setStatus(id, status) {
    if (!STATUSES.includes(status)) { const e = new Error(`A job status is one of: ${STATUSES.join(', ')}.`); e.status = 400; throw e; }
    if (!this.get(id)) { const e = new Error('No such job'); e.status = 404; throw e; }
    const reg = this.load();
    if ((reg[id] || {}).status === status) return this.get(id);
    reg[id] = { created: (reg[id] && reg[id].created) || nowIso(), ...reg[id], status };
    this.save(reg); this.stamp(id, status);
    const job = this.get(id);
    if (this.h.onChange) this.h.onChange(job);
    return job;
  }

  tasksOf(id, all) { return all.filter((t) => t.job === id); }
  // Move a job along from what its tasks did. approved -> working when a task is working or done; -> done when every task is done.
  // A failed or stopped task leaves the job working: the lead or the boss decides. planned and stopped never move here.
  // Returns the new status, or '' when nothing changed.
  settle(id, all) {
    const job = this.get(id); if (!job || ['planned', 'stopped'].includes(job.status)) return '';
    const ts = this.tasksOf(id, all), allDone = ts.length > 0 && ts.every((t) => t.status === 'done');
    const next = allDone ? 'done' : job.status === 'approved' ? (ts.some((t) => ['working', 'done'].includes(t.status)) ? 'working' : 'approved') : job.status === 'done' ? 'working' : job.status;
    if (next === job.status) return '';
    this.setStatus(id, next);
    return next;
  }
}

// What the manager is told when a job is done or stopped: one line per task (the last 20), then what to do.
function doneText(job, status, all, nameOf) {
  const last = (x) => String(x || '').trim().slice(-300), shown = all.slice(-20);
  return `[Office update, not from the boss] The job "${job.title}" is ${status}.\n${[...shown.map((x) => `- ${nameOf(x.staff)}, "${x.title}": ${x.status}. ${last(x.result)}`), ...(all.length > 20 ? [`... and ${all.length - 20} more`] : [])].join('\n')}\n\nCheck it, then tell the boss in a few short lines what is done and what is next. If more work is needed, hand it out with a task file.`;
}

module.exports = { Jobs, STATUSES, doneText };
