# Shared Task Board Implementation Plan (build step 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the office's task engine the agent-team mechanics: tasks that wait for other tasks, tasks any staff of a role can take, follow-ups that resume the same Claude session, and an office-wide limit on parallel runs, all visible on the work board.

**Architecture:** Everything stays in `lib/tasks.js` (the `Tasks` class) and the `tasks/<id>.md` file contract. New header fields are optional, so existing task files and business offices behave as before, except for the new parallel limit. The server exposes the waiting list and the limit; the dashboard draws them.

**Tech Stack:** Plain Node 18+, no new dependencies. Tests are plain Node scripts with a fake `claude` (`test/tasks.test.js` style).

**Spec:** `docs/superpowers/specs/2026-11-28-software-house-team-design.md`, section 2 ("Shared task board") and the `maxParallel` row of section 7. Sections 1 and 3 to 11 are later plans (steps 2 to 4 of the spec's build order) and are out of scope here.

## Global Constraints

- Plain Node, no shell-specific tricks: must run on Windows and Linux. Use `path` functions, never split on `/`.
- No new dependencies. The server listens on localhost only.
- File contracts stay stable: every new `tasks/<id>.md` header field is optional; a file without them runs exactly as today.
- Fields written by the office only, never by staff: `session`, `staff` (when claimed from a `role`).
- `maxParallel` default is 3 (spec section 7).
- All text the user sees is plain, short English in the existing voice ("the boss", "staff", no jargon). No em dashes.
- `npm test` is green at the end of every task.

## Review Focus

1. A needed task's file is removed while others wait for it (Settings > Clean up > Task history): the waiting task must fail with a plain reason, not wait forever. Test in Task 1.
2. The office restarts while tasks are waiting: on start they are picked up again and start when their needs are done; nothing is lost because waiting is computed from files. Test in Task 1.
3. A staff is archived while a `role:` task waits for someone of that role: the task fails with a plain reason at the next scan. Test in Task 2.
4. `needs:` written loosely by the manager (`a, b`, `a b`, trailing `# comment`, Windows line ends): all read as the same list. Test in Task 1.
5. `maxParallel` hand-edited to nonsense in `office.json` (`0`, `"abc"`, `99`): the engine uses 1 to 8, default 3, and never stalls. Test in Task 4.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/tasks.js` | modify | Waiting, claiming, follow-ups, parallel limit, `board()` |
| `lib/office.js` | modify | `setParallel(dir, n)` |
| `lib/server.js` | modify | `/api/tasks` returns `waiting`; `PUT /api/parallel`; blocked notice to the manager |
| `lib/templates.js` | modify | OFFICE.md task section; manager and staff instructions |
| `dashboard/app.js`, `dashboard/app.css` | modify | Waiting rows on the work board; limit control in Settings > General |
| `test/tasks.test.js`, `test/server.test.js`, `test/generate.test.js` | modify | Tests |
| `CLAUDE.md`, `README.md` | modify | Status line; one README sentence |

`lib/tasks.js` grows from about 195 to about 300 lines. That is within the size of its neighbours (`lib/office.js` is 527), so no split.

---

### Task 1: Tasks wait for the tasks they need

**Files:**
- Modify: `lib/tasks.js` (header comment, `scan`, `pump`, `finish`, `stop`; new helpers)
- Test: `test/tasks.test.js`

**Interfaces:**
- Produces, on `Tasks`:
  - `needsOf(t) -> string[]`: ids from the `needs` field, split on commas and spaces.
  - `waitingFor(t, all) -> string[]`: needs that are not met yet. A need is met when that task is `done`, or when a task carrying `again: <need id>` is met (a rerun stands in for the original).
  - `blockedBy(t, all) -> string[]`: unmet needs whose task ended `failed` or `stopped` and has no rerun in progress (`new` or `working`).
  - `board() -> { waiting: [{ id, staff, role, job, title, created, waitingFor: string[], blockedBy: string[] }] }`: every `new` task that is not queued or running.
  - Hook `onBlocked(task, needIds: string[])`: called once per task per set of blocking needs.
  - `pumpAll()`: replaces `pump(staff)`; Task 2 and Task 4 extend it.
- `read(id)` already returns every header field, so `t.needs`, `t.role`, `t.job`, `t.kind`, `t.continues` need no parsing change.

- [ ] **Step 1: Write the failing tests** (append inside the async block of `test/tasks.test.js`, before the final summary line). Add a helper next to `put`:

```js
const putH = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
const endedOf = (id) => ended.find((e) => e[0] === id);
```

```js
await test('a task waits for the tasks it needs, then starts on its own', async () => {
  putH('n1', 'staff: siti', 'LONG first part');
  putH('n2', 'staff: nurul\nneeds: n1', 'second part');
  tasks.scan();
  await until(() => tasks.active().some((a) => a.id === 'n1'));
  assert.strictEqual(tasks.read('n2').status, 'new');
  assert.deepStrictEqual(tasks.board().waiting.map((w) => [w.id, w.waitingFor]), [['n2', ['n1']]]);
  await until(() => endedOf('n2'));
  assert.strictEqual(tasks.read('n2').status, 'done');
  assert.ok(tasks.read('n2').started >= tasks.read('n1').finished);
});

await test('needs can be written loosely', async () => {
  putH('n3', 'staff: siti\nneeds: n1,n2   # both first', 'x');
  fs.writeFileSync(path.join(dir, 'tasks', 'n4.md'), '---\r\nstaff: siti\r\nneeds: n1 n2\r\nstatus: new\r\n---\r\ny\r\n');
  assert.deepStrictEqual(tasks.needsOf(tasks.read('n3')), ['n1', 'n2']);
  assert.deepStrictEqual(tasks.needsOf(tasks.read('n4')), ['n1', 'n2']);
  tasks.scan(); await until(() => endedOf('n3') && endedOf('n4'));
});

await test('a need that does not exist, or a circle, fails with a plain reason', async () => {
  putH('n5', 'staff: siti\nneeds: nope', 'x');
  putH('n6', 'staff: siti\nneeds: n7', 'x'); putH('n7', 'staff: nurul\nneeds: n6', 'y');
  putH('n8', 'staff: siti\nneeds: n8', 'x');
  tasks.scan();
  assert.strictEqual(tasks.read('n5').result, 'Task "nope" in needs does not exist.');
  assert.match(tasks.read('n6').result, /^These tasks need each other in a circle: /);
  assert.strictEqual(tasks.read('n7').status, 'failed');
  assert.strictEqual(tasks.read('n8').result, 'A task cannot need itself.');
});

await test('when a needed task fails or is stopped, the rest keeps waiting and the office is told once; a rerun unblocks it', async () => {
  const blocked = []; tasks.h.onBlocked = (t, ids) => blocked.push([t.id, ids]);
  putH('n9', 'staff: siti', 'LONG will be stopped');
  putH('n10', 'staff: nurul\nneeds: n9', 'after');
  tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'n9'));
  tasks.stop('n9'); await until(() => tasks.read('n9').status === 'stopped');
  tasks.scan(); tasks.scan();
  assert.deepStrictEqual(blocked, [['n10', ['n9']]]);
  assert.deepStrictEqual(tasks.board().waiting[0].blockedBy, ['n9']);
  tasks.rerun('n9');
  await until(() => endedOf('n10'), 20000);
  assert.strictEqual(tasks.read('n10').status, 'done');
});

await test('a waiting task can be cancelled, survives a restart, and fails plainly if its need is deleted', async () => {
  putH('n11', 'staff: siti', 'LONG base'); putH('n12', 'staff: nurul\nneeds: n11', 'a'); putH('n13', 'staff: nurul\nneeds: n11', 'b');
  tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'n11'));
  assert.deepStrictEqual(tasks.stop('n12'), { ok: true });
  assert.strictEqual(tasks.read('n12').result, 'Cancelled by the boss before it started.');
  await until(() => endedOf('n13'));                       // n13 ran after n11
  putH('n14', 'staff: siti', 'LONG base 2'); putH('n15', 'staff: nurul\nneeds: n14', 'c');
  tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'n14'));
  fs.unlinkSync(path.join(dir, 'tasks', 'n14.md')); tasks.stopAll();
  await until(() => tasks.active().length === 0);
  const again = new Tasks(dir, tasks.h); again.scan();     // "restart": a fresh engine over the same files
  assert.strictEqual(again.read('n15').result, 'Task "n14" in needs does not exist.');
  // a waiting task whose need finished while the office was off starts after the restart
  fs.writeFileSync(path.join(dir, 'tasks', 'n16.md'), '---\nstaff: siti\nstatus: done\n---\nbase 3\n\n## Result\n\nok\n');
  putH('n17', 'staff: nurul\nneeds: n16', 'd');
  new Tasks(dir, tasks.h).scan();
  await until(() => endedOf('n17'));
  assert.strictEqual(tasks.read('n17').status, 'done');
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node test/tasks.test.js`
Expected: the seven existing tests print `ok`, then a failure in "a task waits for the tasks it needs" (`tasks.board is not a function` or n2 starting at once).

- [ ] **Step 3: Implement in `lib/tasks.js`**

Add the helpers named under Interfaces, and restructure `scan`, `pump` and `finish` to this shape (Task 2 and Task 4 add to the marked places):

```js
scan() {
  const cfg = this.h.loadCfg();
  const all = this.list();                       // newest first
  for (const t of [...all].reverse()) {          // oldest first
    if (t.status !== 'new' || this.isHeld(t.id)) continue;   // isHeld: running or in a queue
    const bad = this.problem(t, all, cfg);       // a plain reason, or ''
    if (bad) { this.fail(t, bad); continue; }
    if (this.waitingFor(t, all).length) { this.tellBlocked(t, all); continue; }
    this.enqueue(t);                             // Task 2: a role task goes to the pool instead
  }
  this.pumpAll();
}
pumpAll() {                                      // Task 4 adds the limit; Task 2 adds claiming
  for (const staff of this.queued.keys()) {
    if (this.running.has(staff)) continue;
    const id = (this.queued.get(staff) || []).shift();
    if (id) this.start(staff, id);
  }
}
```

- `problem(t, all, cfg)` returns, in this order: `A task cannot need itself.`; `Task "<id>" in needs does not exist.`; `These tasks need each other in a circle: <ids, comma separated, in id order>.` (every task in the circle fails with the same text); then the three existing checks with their existing texts.
- `fail(t, reason)` is the existing "write failed + `onEnd`" pair, pulled out of `scan`.
- `tellBlocked(t, all)` calls `this.h.onBlocked(t, ids)` when `blockedBy` is non-empty and that exact `t.id + ids` pair has not been told before (remember in a `Set` on the instance; forget the entry when the task leaves `new`).
- `finish` ends with `this.scan()` instead of `this.pump(staff)`, so dependants start when their need is done.
- `stop(id)`: after the running and queued cases, a `new` task that is waiting is written `stopped` with `Cancelled by the boss before it started.` and returns `{ ok: true }`.
- Update the header comment at the top of the file with the `needs:` line.

- [ ] **Step 4: Run the tests**

Run: `node test/tasks.test.js`
Expected: all tests print `ok`, including the five new ones.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/tasks.test.js
git commit -m "Tasks: wait for the tasks they need, unblock on their own"
```

---

### Task 2: A task for a role, taken by whoever is free

**Files:**
- Modify: `lib/tasks.js`
- Test: `test/tasks.test.js`

**Interfaces:**
- Consumes: `scan`, `pumpAll`, `problem`, `fail`, `isHeld`, `board` from Task 1.
- Produces: `this.pool: string[]` (ids of role tasks ready to start, oldest first); `board().waiting` entries for pooled tasks carry `waitingFor: []` and `role`.

The test office has Aina (Customer Service), Siti (Sales), Nurul (Finance).

- [ ] **Step 1: Write the failing tests**

```js
await test('a task for a role goes to a free staff with that role, and the office writes who took it', async () => {
  putH('r1', 'role: sales', 'Quote for a role');           // role match ignores case
  tasks.scan(); await until(() => endedOf('r1'));
  const t = tasks.read('r1');
  assert.strictEqual(t.staff, 'siti'); assert.strictEqual(t.status, 'done');
});

await test('a role task waits while everyone with that role is busy', async () => {
  putH('r2', 'staff: siti', 'LONG busy'); putH('r3', 'role: Sales', 'next');
  tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'r2'));
  assert.strictEqual(tasks.read('r3').staff || '', '');
  assert.deepStrictEqual(tasks.board().waiting.find((w) => w.id === 'r3').waitingFor, []);
  await until(() => endedOf('r3'));
  assert.strictEqual(tasks.read('r3').staff, 'siti');
});

await test('no staff and no role, or a role nobody has, fails with a plain reason', async () => {
  putH('r4', 'role: Plumber', 'x'); putH('r5', 'project:', 'y');
  tasks.scan();
  assert.strictEqual(tasks.read('r4').result, 'There is no active staff with the role "Plumber".');
  assert.strictEqual(tasks.read('r5').result, 'A task needs a staff or a role.');
});

await test('if the last staff with a role is archived while a role task waits, it fails plainly', async () => {
  putH('r6', 'staff: siti', 'LONG busy'); putH('r7', 'role: Sales', 'later');
  tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'r6'));
  const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...cfg, staff: cfg.staff.filter((s) => s.id !== 'siti') }));
  tasks.scan();
  assert.strictEqual(tasks.read('r7').result, 'There is no active staff with the role "Sales".');
  fs.writeFileSync(f, JSON.stringify(cfg)); tasks.stopAll(); await until(() => tasks.active().length === 0);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node test/tasks.test.js`
Expected: FAIL in "a task for a role goes to a free staff" (r1 fails with `There is no active staff with id ""`).

- [ ] **Step 3: Implement**

- `problem`: when `staff` is empty, the reason is `A task needs a staff or a role.` if `role` is empty too, or `There is no active staff with the role "<role as written>".` when no entry of `cfg.staff` has that role (trimmed, case-insensitive).
- `scan`: a ready task with empty `staff` goes to `this.pool` instead of a staff queue. Each scan re-checks pooled tasks with `problem` (this is what catches the archived staff) and drops ids whose file is gone or no longer `new`.
- `pumpAll`: after the per-staff queues, for each pooled task (oldest first) pick the first staff in `cfg.staff` order with that role who is not running and has an empty queue; write `staff: <id>` into the file with `this.write`, remove it from the pool, and `start` it.
- `isHeld` and `stop` also cover the pool (a pooled task stops as `Cancelled by the boss before it started.`).
- `board().waiting` includes pooled tasks.
- Header comment: add the `role:` line ("used when staff is empty: any active staff with this role takes it").

- [ ] **Step 4: Run the tests**

Run: `node test/tasks.test.js`
Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/tasks.test.js
git commit -m "Tasks: a task for a role is taken by a free staff with that role"
```

---

### Task 3: Follow-ups resume the same Claude session

**Files:**
- Modify: `lib/tasks.js` (`start`, `problem`, `waitingFor`)
- Test: `test/tasks.test.js` (also the fake `claude` at the top)

**Interfaces:**
- Consumes: Task 1's `problem` and `waitingFor`.
- Produces: header field `session` on every task that ran (written by the office when Claude reports it); header field `continues` honoured by `start`.

- [ ] **Step 1: Teach the fake `claude` about sessions.** In the `fake` string of `test/tasks.test.js`, before the `setTimeout`:

```js
const sid = a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'sess-' + Date.now() + '-' + process.pid;
out({ type: 'system', subtype: 'init', session_id: sid });
```

- [ ] **Step 2: Write the failing tests**

```js
await test('the office notes the Claude session of a task; a follow-up resumes it, as the same staff', async () => {
  putH('f1', 'staff: nurul', 'Draft the invoice');
  tasks.scan(); await until(() => endedOf('f1'));
  const sid = tasks.read('f1').session; assert.match(sid, /^sess-/);
  putH('f2', 'continues: f1', 'Fix the total');             // staff may be left out
  tasks.scan(); await until(() => endedOf('f2'));
  const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('task f2'));
  assert.strictEqual(c.args[c.args.indexOf('--resume') + 1], sid);
  assert.strictEqual(path.resolve(c.cwd), path.resolve(dir, 'staff', 'nurul'));
  assert.strictEqual(tasks.read('f2').staff, 'nurul');
  assert.strictEqual(tasks.read('f2').session, sid);
  assert.match(c.args[c.args.indexOf('-p') + 1], /^Follow-up from Hana \(task f2, continuing task f1\):/);
});

await test('a follow-up waits until the task it continues has ended', async () => {
  putH('f3', 'staff: siti', 'LONG quote'); putH('f4', 'continues: f3', 'one more line');
  tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'f3'));
  assert.deepStrictEqual(tasks.board().waiting.find((w) => w.id === 'f4').waitingFor, ['f3']);
  await until(() => endedOf('f4'));
  assert.ok(tasks.read('f4').started >= tasks.read('f3').finished);
});

await test('follow-up mistakes fail plainly; with no session to resume it starts fresh and is told to read the old task', async () => {
  putH('f5', 'continues: nope', 'x'); putH('f6', 'staff: siti\ncontinues: f1', 'x');
  put('f7', 'aina', 'old'); fs.writeFileSync(path.join(dir, 'tasks', 'f7.md'), '---\nstaff: aina\nstatus: done\n---\nold task\n\n## Result\n\nok\n');
  putH('f8', 'continues: f7', 'go on');
  tasks.scan(); await until(() => endedOf('f8'));
  assert.strictEqual(tasks.read('f5').result, 'Task "nope" in continues does not exist.');
  assert.strictEqual(tasks.read('f6').result, 'A follow-up goes to the same staff as the task it continues (nurul).');
  const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('task f8'));
  assert.ok(!c.args.includes('--resume'));
  assert.match(c.args[c.args.indexOf('-p') + 1], /You have no memory of task f7: read .*f7\.md first\./);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `node test/tasks.test.js`
Expected: FAIL in "the office notes the Claude session" (`session` is undefined).

- [ ] **Step 4: Implement**

- `start`: in the stdout loop, on `j.type === 'system' && j.subtype === 'init' && j.session_id`, write `session: <id>` to the task file once.
- `problem`: `Task "<id>" in continues does not exist.`; `A follow-up goes to the same staff as the task it continues (<their staff id>).` when `staff` is set and differs.
- `scan`: a follow-up with empty `staff` gets the continued task's `staff` written into its file before queueing (so it never enters the role pool).
- `waitingFor`: the continued task counts as an unmet need while it is `new` or `working` (any ended status releases it; a follow-up to a failed task is allowed).
- `start` for a follow-up: first prompt line `Follow-up from <from> (task <id>, continuing task <continues>):`; add `--resume <session>` when the continued task has one; otherwise add the line `You have no memory of task <continues>: read <absolute path of that task file> first.` The existing test's assertion "each task starts fresh" still holds for tasks without `continues`.
- Header comment: add `continues:` and `session:` lines.

- [ ] **Step 5: Run the tests**

Run: `node test/tasks.test.js`
Expected: all `ok`.

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js test/tasks.test.js
git commit -m "Tasks: follow-ups resume the session of the task they continue"
```

---

### Task 4: At most N staff runs at once

**Files:**
- Modify: `lib/tasks.js` (`pumpAll`), `lib/office.js`, `lib/server.js`
- Test: `test/tasks.test.js`, `test/server.test.js`

**Interfaces:**
- Produces:
  - `Tasks.limit() -> number`: `cfg.maxParallel` rounded down to a whole number and clamped to 1..8; missing, not a number, or below 1 is 3.
  - `O.setParallel(dir, n) -> { maxParallel: number }` in `lib/office.js`: saves the integer; throws `OfficeError('Pick a number from 1 to 8')` otherwise. Exported.
  - Route `PUT /api/parallel` with body `{ n }`: calls `O.setParallel`, then `tasks.scan()`.
  - `GET /api/tasks` gains `waiting: tasks.board().waiting` and `limit: tasks.limit()`.

- [ ] **Step 1: Write the failing tests.** In `test/tasks.test.js`:

```js
await test('the office-wide limit: never more runs at once than maxParallel, oldest first', async () => {
  const f = path.join(dir, 'office.json'), cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  const set = (v) => fs.writeFileSync(f, JSON.stringify({ ...cfg, maxParallel: v }));
  for (const [v, want] of [[0, 3], ['abc', 3], [99, 8], [2.9, 2], [undefined, 3], [1, 1]]) { set(v); assert.strictEqual(tasks.limit(), want); }
  let most = 0; const watch = setInterval(() => { most = Math.max(most, tasks.active().length); }, 20);
  putH('p1', 'staff: siti', 'LONG a'); putH('p2', 'staff: nurul', 'LONG b'); putH('p3', 'staff: aina', 'c');
  tasks.scan(); await until(() => endedOf('p1') && endedOf('p2') && endedOf('p3'), 20000);
  clearInterval(watch); assert.strictEqual(most, 1);
  assert.ok(tasks.read('p2').started >= tasks.read('p1').finished);
  fs.writeFileSync(f, JSON.stringify(cfg));
});
```

In `test/server.test.js`, in the style of its existing API tests: `PUT /api/parallel {n: 2}` answers `{ maxParallel: 2 }` and `office.json` holds it; `{n: 0}` and `{n: 'x'}` answer 400 with `Pick a number from 1 to 8`; `GET /api/tasks` has `limit: 2` and an array `waiting`.

- [ ] **Step 2: Run to see them fail**

Run: `node test/tasks.test.js && node test/server.test.js`
Expected: FAIL with `tasks.limit is not a function`.

- [ ] **Step 3: Implement**

- `pumpAll`: collect every startable candidate (the head of each idle staff's queue, and each pooled task that has a free staff), sort by `created` then id, and start them one by one while `this.running.size < this.limit()`.
- `O.setParallel`, the route, and the two new keys on `GET /api/tasks`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js lib/office.js lib/server.js test/tasks.test.js test/server.test.js
git commit -m "Tasks: office-wide limit on staff runs at once (default 3)"
```

---

### Task 5: The work board shows what is waiting

**Files:**
- Modify: `lib/server.js` (the `Tasks` hooks), `dashboard/app.js`, `dashboard/app.css`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `GET /api/tasks` -> `{ active, list, interrupted, waiting, limit }`; `PUT /api/parallel`; hook `onBlocked(task, needIds)`.
- Produces: dashboard state `S.waiting` and `S.limit`.

- [ ] **Step 1: Write the failing server test.** With the test's fake `claude`, write task `b1` (a staff) and `b2` (`needs: b1`), stop `b1` through `POST /api/tasks/b1/stop`, then assert the manager's chat (`GET` of the pa chat, as the existing tests read it) contains exactly one system line of kind `error` with the text:

`<Staff name>'s task "<b2 title>" is waiting for a task that was stopped ("<b1 title>"). Run that one again from the work board, or stop the waiting one.`

(`failed` instead of `stopped` when the need failed; with several blocking needs, name the first and add `and N more`.)

- [ ] **Step 2: Run to see it fail**

Run: `node test/server.test.js`
Expected: FAIL, no such line in the chat.

- [ ] **Step 3: Implement the server side.** In `lib/server.js` add `onBlocked` to the `Tasks` hooks: `chats.add('pa', { from: 'system', kind: 'error', task: t.id, text })` and `broadcast('tasks', tasks.active())`. Use `chats.add`, not `chats.notify`: the stopped or failed task's own `onEnd` already wakes the manager, so this costs no extra Claude run.

- [ ] **Step 4: Run the server test**

Run: `node test/server.test.js`
Expected: PASS.

- [ ] **Step 5: Implement the dashboard.**

- Wherever `S.tasks` is filled from `api('tasks')` (two places, around lines 919 and 941), also set `S.waiting = r.waiting || []` and `S.limit = r.limit`.
- `renderWork`: the board is shown when there is anything working, interrupted **or waiting**. After the working rows, a section headed `Waiting` with one row per `S.waiting` entry, in the existing `.wk` row style with a grey avatar (or a role chip when no staff yet): the title, and one faint line:
  - `Waiting for <names of the staff doing those tasks, or the task titles>` when `waitingFor` is non-empty;
  - `Stuck: a task it needs was stopped or failed` when `blockedBy` is non-empty (takes priority);
  - `Next free <role>` for a role task with nothing to wait for;
  - `In line (at most <S.limit> work at once)` otherwise.
  Each row has the same Stop button (`data-stoptask`), which now cancels a waiting task.
- The board's header label gains `, N waiting`. The top-bar count stays "working" only.
- Settings > General: one row "Staff working at the same time" with a number input (1 to 8, value `S.limit`) and the hint `More at once is faster and uses your Claude plan faster.` Saving calls `PUT /api/parallel` and shows the existing toast.
- `dashboard/app.css`: only what the waiting rows need, reusing the `.wk.cut` look.

- [ ] **Step 6: Check it in the real dashboard.** Use the `run` skill (or `node bin/ai-office.js` against a scratch office built like `test/tasks.test.js` does, with the fake `claude` first on `PATH`). Write three task files: one `LONG` task, one with `needs:` on it, one with a `role:`. Confirm in the browser: the waiting rows and their lines appear, they move to working on their own, Stop cancels a waiting row, and the Settings number saves. Take one screenshot of the board with a waiting row for the owner.

- [ ] **Step 7: Commit**

```bash
git add lib/server.js dashboard/app.js dashboard/app.css test/server.test.js
git commit -m "Work board: show waiting tasks and why; setting for staff at once"
```

---

### Task 6: Tell the office how to use it

**Files:**
- Modify: `lib/templates.js` (`officeMd`, `paClaude`, `staffClaude`, `agentMd`), `CLAUDE.md`, `README.md`
- Test: `test/generate.test.js`

**Interfaces:**
- Consumes: the field names and behaviours of Tasks 1 to 4. Nothing later depends on this task.

- [ ] **Step 1: Write the failing test.** In `test/generate.test.js`, on a generated office: `OFFICE.md` contains the strings `needs:`, `role:`, `continues:` and `maxParallel`; the manager's `CLAUDE.md` contains `needs:` and `continues:`; a staff's `CLAUDE.md` does not contain `continues:` (staff ask colleagues with a plain task, as today).

- [ ] **Step 2: Run to see it fail**

Run: `node test/generate.test.js`
Expected: FAIL on the first new assertion.

- [ ] **Step 3: Implement**

- `officeMd`, section "Task": extend the example header with the optional lines and one-line comments, and add this table under it:

| Field | Meaning |
|---|---|
| `needs:` | Task ids, separated by commas, that must be done first. The office starts this task when they are |
| `role:` | Leave `staff:` empty and name a role: the first free staff with that role takes it |
| `continues:` | A task id: this is a follow-up to the same staff, who still remembers that task |
| `job:`, `kind:` | Labels for grouping; no effect yet |
| `session:` | Written by the office. Do not edit |

  Add one sentence: the office runs at most `maxParallel` staff at once (`office.json`, default 3, Settings > General).
- `paClaude`: three short bullets in the hand-out section. Split bigger work into tasks that each own different files, and order them with `needs:`. Use `role:` when any staff of that role will do. To send work back to the same staff (a fix, a change), write a follow-up with `continues:` instead of a new task: it is cheaper and they remember.
- `staffClaude` and `agentMd`: unchanged, except the staff's "ask a colleague" line may mention `needs:` is not for them. Keep it to at most one line.
- `CLAUDE.md` (repo): add a dated status line for this step under "Status". `README.md`: one sentence in "Using it" > Office row about waiting tasks on the work board.

Generated instruction files of existing offices are not rewritten by an update (existing behaviour); the new fields work there anyway, and `OFFICE.md` regenerates the way it does today.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/templates.js test/generate.test.js CLAUDE.md README.md
git commit -m "Docs: needs, role and continues in OFFICE.md and the manager's instructions"
```

---

## Not in this plan (later plans, from the spec's build order)

2. Software office type, default team, guard presets, native-teams setting, skills spike and switch, GitHub read-only preset.
3. Jobs and plan OK, worktrees, test and review gates, push approval.
4. Per-task and per-job cost, budget stop.
