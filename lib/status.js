// Works out who is working from .office/events.jsonl (written by the hooks).
//
//   PreToolUse  Agent (PA session)        -> the PA hands a task to a staff (task text)
//   PostToolUse Agent  {aid, staff, task} -> that task's id
//   SubagentStart / SubagentStop {aid}    -> the staff starts / finishes it
//   events with an aid                    -> the staff is busy (tool, file)
//   a session in staff/<id>/              -> the boss is talking to that staff directly
//   Notification "needs your permission"  -> someone waits for the boss in the terminal
//
// Pending approvals make a staff "waiting". Nothing heard for STALE ms = not working.

const fs = require('fs');
const path = require('path');

const STALE = 15 * 60 * 1000;
const FIRST_READ = 512 * 1024; // on start, only look at the end of a long log

class Status {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, '.office', 'events.jsonl');
    this.offset = null; this.rest = '';
    this.tasks = new Map(); // aid -> { staff, task, sid, started, last, running }
    this.handed = new Map(); // `${sid}|${staff}` -> [task, ...] waiting for their aid
    this.sessions = new Map(); // sid -> { who, busy, last, notify }
    this.last = {}; // person id -> last time heard
    this.feed = []; // recent plain-words activity
  }

  reset() { // after the event log was cleared
    this.offset = null; this.rest = '';
    this.tasks.clear(); this.handed.clear(); this.sessions.clear(); this.last = {}; this.feed = [];
  }

  whoOf(cwd) {
    if (!cwd) return 'pa';
    const rel = path.relative(this.dir, cwd).split(path.sep);
    return rel[0] === 'staff' && rel[1] ? rel[1] : 'pa';
  }

  // Read whatever was appended since last time.
  readNew() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return false; }
    if (this.offset === null) this.offset = Math.max(0, size - FIRST_READ);
    if (size < this.offset) { this.offset = 0; this.rest = ''; } // file was cut or replaced
    if (size === this.offset) return false;
    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    const lines = (this.rest + buf.toString('utf8')).split('\n');
    this.rest = lines.pop(); // a half-written last line waits for the next read
    for (const l of lines) { if (!l.trim()) continue; try { this.apply(JSON.parse(l)); } catch { /* skip a bad line */ } }
    return true;
  }

  say(at, who, text) {
    this.feed.push({ at, who, text });
    if (this.feed.length > 100) this.feed.splice(0, this.feed.length - 100);
  }

  apply(e) {
    if (e.ev === 'TeammateIdle' || e.ev === 'TaskCreated' || e.ev === 'TaskCompleted') return; // agent teams in the terminal: logged only
    const at = Date.parse(e.at) || Date.now();
    const sid = e.sid || '';
    if (e.aid) { // inside a staff task (or the PostToolUse that names it)
      let t = this.tasks.get(e.aid);
      if (!t) { t = { staff: e.staff, sid, started: at, last: at, running: false, task: '' }; this.tasks.set(e.aid, t); }
      if (e.staff) t.staff = e.staff;
      if (e.task) t.task = e.task;
      t.last = at;
      if (e.ev === 'SubagentStart' || e.ev === 'TaskStart') { // TaskStart: a dashboard task (lib/tasks.js)
        t.running = true; t.started = at;
        if (!t.task) { const q = this.handed.get(`${sid}|${t.staff}`); if (q && q.length) t.task = q.shift(); }
        this.say(at, t.staff, `started: ${t.task || 'a task'}`);
      } else if (e.ev === 'SubagentStop' || e.ev === 'TaskEnd') {
        if (t.running) this.say(at, t.staff, `finished: ${t.task || 'a task'}`);
        t.running = false;
      } else if (e.ev === 'PostToolUse' && (e.tool === 'Agent' || e.tool === 'Task')) {
        const q = this.handed.get(`${sid}|${t.staff}`); if (q && q.length && q[0] === t.task) q.shift();
      }
      if (t.staff) this.last[t.staff] = at;
      return;
    }
    const who = this.whoOf(e.cwd);
    let s = this.sessions.get(sid);
    if (!s) { s = { who, busy: false, last: at, notify: null }; if (sid) this.sessions.set(sid, s); }
    s.last = at; this.last[who] = at;
    switch (e.ev) {
      case 'SessionStart': s.busy = false; break;
      case 'UserPromptSubmit': s.busy = true; s.notify = null; break;
      case 'PreToolUse': case 'PostToolUse':
        s.busy = true; s.notify = null;
        if (e.ev === 'PreToolUse' && (e.tool === 'Agent' || e.tool === 'Task') && e.staff) {
          const k = `${sid}|${e.staff}`;
          if (!this.handed.has(k)) this.handed.set(k, []);
          this.handed.get(k).push(e.task || '');
        }
        break;
      case 'Notification': if (/permission|approv|allow/i.test(e.msg || '')) s.notify = e.msg; break;
      case 'Stop': s.busy = false; s.notify = null; break;
      case 'SessionEnd': this.sessions.delete(sid); break;
      case 'Approval': case 'Setting': case 'Extension': if (e.msg) this.say(at, e.staff || who, e.msg); break;
      default: break;
    }
  }

  // people: [{ id }] including { id: 'pa' }; pendingFrom: Set of staff ids with a pending approval
  snapshot(people, pendingFrom = new Set(), now = Date.now()) {
    const fresh = (t) => now - t < STALE;
    const out = {};
    const running = [...this.tasks.values()].filter((t) => t.running && fresh(t.last));
    for (const p of people) {
      const mine = running.filter((t) => t.staff === p.id);
      const direct = [...this.sessions.values()].some((s) => s.who === p.id && s.busy && fresh(s.last));
      let status = 'sleeping', task = '';
      if (p.id === 'pa') {
        const paBusy = [...this.sessions.values()].some((s) => s.who === 'pa' && s.busy && fresh(s.last));
        if (paBusy && running.length) { status = 'working'; task = `Handing out ${running.length} task${running.length > 1 ? 's' : ''}`; }
        else if (paBusy) { status = 'working'; task = 'Working on your request'; }
        else if (running.length) { status = 'working'; task = `Following up ${running.length} task${running.length > 1 ? 's' : ''}`; }
      } else if (mine.length) {
        status = 'working';
        task = mine.length > 1 ? `${mine.length} tasks: ${mine[0].task || 'working'}` : (mine[0].task || 'Working');
      } else if (direct) { status = 'working'; task = 'Talking with you'; }
      if (status === 'sleeping' && pendingFrom.has(p.id)) status = 'waiting';
      out[p.id] = { status, task, last: this.last[p.id] ? new Date(this.last[p.id]).toISOString() : null };
    }
    const asking = [...this.sessions.values()].find((s) => s.notify && fresh(s.last));
    return { people: out, banner: asking ? { who: asking.who, msg: asking.notify } : null };
  }
}

module.exports = { Status, STALE };
