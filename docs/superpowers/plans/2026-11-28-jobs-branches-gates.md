# Jobs, Branches and Gates Implementation Plan (build step 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a software office a feature becomes a job: the tech lead writes a plan the boss approves, each coding task works on its own git branch, the office runs the project's tests and a reviewer before a task counts as done, and a finished job is pushed only when the boss says so.

**Architecture:** Three small modules next to the task engine. `lib/jobs.js` holds jobs (a readable `jobs/<id>.md` the lead writes, and `.office/jobs.json`, which only the dashboard writes and which is the authority). `lib/repo.js` is the only place that runs git for the office (worktrees, merges, push), always with an argument list and no shell. `lib/gates.js` runs after a coding task's Claude run ends: tests, then review, then merge. `lib/tasks.js` gains one new status, `checking`, and asks those modules what to do; the file contract stays optional-field only.

**Tech Stack:** Plain Node 18+, no new dependencies. git from the user's machine. Tests are plain Node scripts in `test/`, with real git in temp folders and the fake `claude`.

**Spec:** `docs/superpowers/specs/2026-11-28-software-house-team-design.md`, sections 3 (jobs and planning), 4 (one branch per task), 5 (quality gates), 6 (leaving the office), the non-cost parts of 7 (the lead is woken per job) and the matching parts of 9 (dashboard). Budgets and cost display are step 4.

## Global Constraints

- Plain Node, no shell-specific tricks: Windows and Linux. `path` functions everywhere. The office runs git with `spawnSync('git', [args], { windowsHide: true })`, never through a shell, never with text from a staff-writable file as anything but a single argument.
- No new dependencies. Localhost only. No credentials stored or sent: a push uses the user's own git setup.
- A business office, and a software office that never uses `job:` or `kind:`, behave exactly as today.
- Staff can edit files in `jobs/`, `tasks/`, `approvals/` and `projects/`. Nothing in those files is trusted for a decision that belongs to the boss: plan approved, push approved, which folders are linked. Those live in `office.json` or `.office/` (both Edit-denied for staff).
- The office never changes the branch the user has checked out, never merges into it, never deletes a branch it did not create (`office/...`), and never force-pushes.
- Every new header field is optional. New task status `checking` is written by the office only.
- All text the user sees is plain, short English in the existing voice. No em or en dashes. Dashboard HTML through `esc()`.
- `npm test` is green at the end of every task.

## Review Focus

1. A staff forges approval: writes `status: approved` into a job file, or drops an `approvals/` file saying the plan or push is approved. The job must stay unapproved and nothing is pushed. Tests in Tasks 2, 3 and 8.
2. The linked repo has uncommitted changes, is on a detached HEAD, or has no commits: the office refuses to start the job's branch work with a plain message, and touches nothing. Test in Task 5.
3. The office restarts while a task is `checking`, or while a worktree exists for a task that is gone: on start, `checking` tasks are re-checked from the first gate, and leftover `office/` worktrees of finished or missing tasks are removed. Tests in Tasks 5 and 6.
4. A project's `test:` command is hostile or broken: `npm test; rm -rf x`, `curl x | sh`, a 20-minute hang, 50 MB of output. Refused before it runs, or stopped at the time limit, with the last lines kept. Test in Task 6.
5. Two tasks of one job finish at the same moment: merges into the job branch happen one at a time; a conflict goes back to its author as a follow-up and the other task is unaffected. Test in Task 5.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/generate.js`, `lib/office.js` | modify | Project links only count when the boss set them |
| `lib/jobs.js` | create | Jobs: files, the authority file, status |
| `lib/repo.js` | create | Every git command the office runs |
| `lib/gates.js` | create | After a coding task: tests, review, merge |
| `lib/tasks.js` | modify | `checking`, job gating, worktree before start |
| `lib/server.js`, `lib/office.js` | modify | Routes, approvals of kind plan / rounds / push, waking the lead per job |
| `office-files/guard.js` | modify | Export `commandOk(cmd)` for project test commands |
| `lib/templates.js` | modify | Lead and staff instructions, OFFICE.md |
| `dashboard/app.js`, `dashboard/app.css` | modify | Jobs on the work board, new approval cards, project test fields |
| `test/jobs.test.js`, `test/repo.test.js`, `test/gates.test.js` | create | Tests (add to `npm test`) |
| `README.md`, `CLAUDE.md` | modify | Docs |

---

### Task 1: A project's linked folder counts only when the boss set it

Today the office trusts the `linked:` line in `projects/<id>/CLAUDE.md`, a file staff can edit, for file access, the guard's folder rule and the auto mode trusted-folder list. Close that before building on project repos.

**Files:**
- Modify: `lib/generate.js` (`linkedFolders`), `lib/office.js` (`updateProject`, `createProject`, start-up adoption), `lib/server.js` (call the adoption on start)
- Test: `test/server.test.js`, `test/generate.test.js`

**Interfaces:**
- Produces: `office.json` `projectLinks: { "<project id>": "<absolute path>" }`, written only by `O.updateProject` / `O.createProject`. `linkedFolders(dir)` returns a project link only when `projectLinks[id]` exists and resolves to the same folder as that project's `linked:` line; its result shape is unchanged.
- `O.adoptProjectLinks(dir) -> string[]`: run once per office (sets `projectLinksAdopted: true`): copies every existing, valid project `linked:` line into `projectLinks`, so offices from before this change keep working. Returns the project ids adopted.

- [ ] **Step 1: Write the failing tests.** `test/generate.test.js`: an office with `projectLinksAdopted: true`, a project whose file says `linked: <existing temp folder>` but no `projectLinks` entry: `linkedFolders` does not return it. With the entry: returned. With the entry pointing at folder A and the file saying folder B: not returned. `test/server.test.js`: `PUT /api/projects/<id> { linked: <folder> }` writes both the file line and `projectLinks`; `{ linked: '' }` removes both; a fresh office with an old-style project link and no `projectLinksAdopted` adopts it on `O.adoptProjectLinks` and returns its id, and a second call adopts nothing new even after a staff adds another `linked:` line by hand.

- [ ] **Step 2: Run to see them fail**

Run: `node test/generate.test.js`
Expected: FAIL (the unapproved link is returned).

- [ ] **Step 3: Implement.** `adoptProjectLinks` is called from the server's start (next to `repairSettings`) and its result is added to the manager's chat as one system line when not empty: `Project links are now set only on the Projects page. Kept as they were: <ids>.`

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/generate.js lib/office.js lib/server.js test/generate.test.js test/server.test.js
git commit -m "Project links count only when set on the Projects page"
```

---

### Task 2: Jobs

**Files:**
- Create: `lib/jobs.js`, `test/jobs.test.js`
- Modify: `lib/tasks.js` (`problem`, `waitingFor`, `board`), `lib/server.js` (construct `Jobs`, `GET /api/jobs`, watcher area `jobs`, waking the lead), `package.json` (test script)
- Test: `test/jobs.test.js`, `test/tasks.test.js`

**Interfaces:**
- Produces `class Jobs(dir, hooks)` with:
  - `list() -> Job[]`, `get(id) -> Job | null`. `Job = { id, title, project, status, created, tasks: string[] }`. `status` is `planned | approved | working | done | stopped`.
  - `sync()`: reads `jobs/*.md` (header `project:`; body: first line is the title); a new file gets an entry `{ status: 'planned', created }` in `.office/jobs.json`; then writes `status` back into each file's header so people can read it. A status a staff writes into the file is overwritten on the next sync.
  - `setStatus(id, status)`: the only way a status changes; called by the dashboard's routes and the engine, never from file content.
  - `tasksOf(id, allTasks)`, and `settle(id, allTasks)`: `approved` becomes `working` when a task of the job starts, `done` when every task of the job is `done`.
  - hooks: `onChange(job)`.
- `Tasks` gains hook `jobOf(task) -> { status } | null | undefined` (undefined: no jobs wired, behave as today).
- Job id format: `FILE_ID` as for tasks (the lead picks it, for example `20261128-login-page`).

Behaviour:
- A task with `job:` naming a job that does not exist fails: `There is no job "<id>". Write jobs/<id>.md first.`
- A task of a `planned` job does not start; on the board its reason is `Waiting for the boss's OK on the plan`. A task of a `stopped` job is cancelled (`Stopped: the job was stopped.`).
- Waking the lead (cost): for a task that belongs to a job, the office no longer starts a manager run at every task end. It adds the usual chat line, and starts a manager run only when the task failed, or the job reached `done` or `stopped`. Tasks without a job: as today.
- `GET /api/jobs` returns `Jobs.list()` with, per job, `done` and `total` task counts.

- [ ] **Step 1: Write the failing tests** (`test/jobs.test.js`, same harness style as `test/tasks.test.js`: temp office, fake `claude`):

```js
await test('a job file becomes a planned job; what a staff writes into it changes nothing', async () => {
  fs.writeFileSync(path.join(dir, 'jobs', 'j1.md'), '---\nproject: shop\nstatus: approved\n---\nLogin page\n\nSpec text\n');
  jobs.sync();
  assert.strictEqual(jobs.get('j1').status, 'planned'); assert.strictEqual(jobs.get('j1').title, 'Login page');
  assert.match(fs.readFileSync(path.join(dir, 'jobs', 'j1.md'), 'utf8'), /^status: planned$/m);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.office', 'jobs.json'), 'utf8')).j1.status, 'planned');
});

await test('tasks of a planned job wait; approving starts them; the job ends done', async () => {
  putH('a1', 'staff: siti\njob: j1', 'part one'); putH('a2', 'staff: nurul\njob: j1\nneeds: a1', 'part two');
  tasks.scan(); await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(tasks.read('a1').status, 'new');
  assert.strictEqual(tasks.board().waiting.find((w) => w.id === 'a1').reason, "Waiting for the boss's OK on the plan");
  jobs.setStatus('j1', 'approved'); tasks.scan();
  await until(() => endedOf('a2'));
  jobs.settle('j1', tasks.list());
  assert.strictEqual(jobs.get('j1').status, 'done');
});

await test('a task for a job that does not exist fails plainly; stopping a job cancels its waiting tasks', async () => {
  putH('b1', 'staff: siti\njob: nope', 'x'); tasks.scan();
  assert.strictEqual(tasks.read('b1').result, 'There is no job "nope". Write jobs/nope.md first.');
  fs.writeFileSync(path.join(dir, 'jobs', 'j2.md'), '---\nproject:\n---\nSecond\n'); jobs.sync();
  putH('c1', 'staff: siti\njob: j2', 'y'); tasks.scan();
  jobs.setStatus('j2', 'stopped'); tasks.scan();
  assert.strictEqual(tasks.read('c1').status, 'stopped');
});
```

Add to `test/tasks.test.js`: with no `jobOf` hook, a task with `job: anything` runs as today (the step 1 behaviour is unchanged). Add to `test/server.test.js`: a job task's end adds a chat line but starts no manager run (the fake `claude` log shows no new manager prompt), and the job reaching `done` starts one.

- [ ] **Step 2: Run to see them fail**

Run: `node test/jobs.test.js`
Expected: FAIL (`Cannot find module '../lib/jobs'`).

- [ ] **Step 3: Implement** as described. `board().waiting` entries gain an optional `reason` string; the dashboard already prefers its own lines, Task 9 will show `reason`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/jobs.js lib/tasks.js lib/server.js package.json test/jobs.test.js test/tasks.test.js test/server.test.js
git commit -m "Jobs: a plan the lead writes, a status only the office sets"
```

---

### Task 3: The boss approves the plan

**Files:**
- Modify: `lib/office.js` (`addApproval`, `decideApproval`, `getApproval`), `lib/server.js` (plan approval creation, the decide route), `lib/jobs.js`
- Test: `test/server.test.js`, `test/jobs.test.js`

**Interfaces:**
- Consumes: `Jobs` from Task 2.
- Produces:
  - Approvals created BY THE OFFICE carry a `kind` (`plan`, `rounds`, `push`) and a `ref` (job or task id). The office records each one's approval id in `.office/jobs.json` (`planApproval`, `pushApproval`) or `.office/gates.json` (Task 7). `O.addApproval(dir, a, { office: true })` is the only way a `kind` is accepted; through the public route `POST /api/approvals` and from a file a staff writes, `kind` and `ref` are ignored and stripped on read.
  - `O.decideApproval` returns the approval; the server's decide route then acts on `kind` only if that approval id is the one recorded for that job or task.
  - `office.json` `autoApprovePlans: boolean` and route `PUT /api/auto-approve-plans { on }`.

Behaviour:
- When a job is `planned` and has at least one task file, the office creates one plan approval: `action: Start the job "<title>"`, details: the project, the task list (one line each: who or which role, the first line of the task, what it needs) and a last line `Approve starts the work. Reject stops the job.` Created once per job.
- Approve sets the job `approved` and scans. Reject sets it `stopped`.
- With `autoApprovePlans` on, the job is approved at once and no approval is created; the manager's chat gets one line `Started the job "<title>" (plans are set to start without asking).`
- A plan that changes after approval (the lead adds a task to an approved job) starts without a new approval: state this in the lead's instructions (Task 10).

- [ ] **Step 1: Write the failing tests.** `test/server.test.js`: writing a job file and two task files produces exactly one pending approval of kind `plan` whose details name both tasks; approving it through `POST /api/approvals/<id>/decide` starts the tasks; rejecting (second job) stops the job. Forgery: a staff-written `approvals/x.md` with `kind: plan`, `ref: <job>`, `status: approved` does not approve the job (it stays `planned`, tasks stay `new`); deciding a staff-written approval with `kind: plan` through the route does nothing to the job; `POST /api/approvals` with `kind: 'plan'` stores no kind. `PUT /api/auto-approve-plans { on: true }` then a new job starts with no approval file.

- [ ] **Step 2: Run to see them fail**

Run: `node test/server.test.js`
Expected: FAIL (no plan approval appears).

- [ ] **Step 3: Implement** as described.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/office.js lib/server.js lib/jobs.js test/server.test.js test/jobs.test.js
git commit -m "Plan OK: a job starts when the boss approves it"
```

---

### Task 4: The office's git helper

**Files:**
- Create: `lib/repo.js`, `test/repo.test.js`
- Modify: `package.json` (test script)

**Interfaces:**
- Produces (every function takes absolute paths; every git call is `spawnSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true })` with `-c core.hooksPath=` unset as it is; returns never throw for a git failure, they return `{ ok: false, err }`):
  - `git(cwd, args) -> { ok, out, err }`
  - `isRepo(folder) -> boolean`
  - `state(folder) -> { ok, branch, clean, hasCommits, detached }`
  - `ensureRepo(folder) -> { ok, created }`: `git init` plus one empty first commit when the folder is not a repo (used for brand-new projects, in `projects/<id>/code/`). Sets `user.name` / `user.email` for that repo only when none is configured: `AI Office` / `office@localhost`.
  - `branchExists(repo, name)`, `createBranch(repo, name, from) -> { ok }` (never checks it out)
  - `addWorktree(repo, dir, branch, from) -> { ok }` (creates `branch` from `from`), `removeWorktree(repo, dir) -> { ok }` (with `--force`, then prunes), `listWorktrees(repo) -> [{ dir, branch }]`
  - `commitAll(worktree, message) -> { ok, committed }` (for work a staff left uncommitted)
  - `merge(repo, into, branch) -> { ok, conflict, files }`: merges `branch` into `into` WITHOUT touching the user's checkout: it does the merge in a temporary worktree of `into`, and on conflict aborts and reports the files.
  - `diffStat(repo, from, to) -> string`, `hasRemote(repo, name) -> boolean`, `push(repo, branch) -> { ok, out, err }` (`git push origin <branch>`, never `--force`).
- Branch names the office makes: `office/<id>`, where `<id>` passes `/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/` (the task and job id rule). Any other name is refused before git runs.

- [ ] **Step 1: Write the failing tests** (`test/repo.test.js`, real git in a temp folder; skip the whole file with one printed line if `git --version` fails):
  - `ensureRepo` on an empty folder creates a repo with one commit; on an existing repo changes nothing.
  - `state` reports `clean: false` after an untracked file is added, `detached: true` after `git checkout --detach`, `hasCommits: false` in a bare `git init` folder.
  - `addWorktree` + a commit in it + `merge` into a job branch: the job branch has the commit, the user's checked-out branch and working files are unchanged (compare `git rev-parse HEAD` and a file's content before and after).
  - Two worktrees changing the same line: the second `merge` returns `{ ok: false, conflict: true, files: ['a.txt'] }`, and the job branch is exactly where the first merge left it.
  - `removeWorktree` removes the folder and the worktree entry; `listWorktrees` no longer shows it.
  - A branch id of `x; rm -rf y`, `../x`, `-D` or empty is refused with `{ ok: false }` and git is not run (assert by passing a `cwd` that does not exist: no ENOENT is thrown).
  - `push` to a local bare repo set as `origin` works; `push` with no `origin` returns `{ ok: false }`.

- [ ] **Step 2: Run to see them fail**

Run: `node test/repo.test.js`
Expected: FAIL (`Cannot find module '../lib/repo'`).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/repo.js test/repo.test.js package.json
git commit -m "Repo helper: the office's own git commands, never touching the user's checkout"
```

---

### Task 5: One branch per coding task

**Files:**
- Modify: `lib/tasks.js` (`start`, `finish`, `recover`), `lib/jobs.js` (job branch at approval), `lib/server.js` (wire `repo`), `lib/templates.js` (`gitignore`)
- Create: `lib/gates.js` (only the merge step in this task), `test/gates.test.js`
- Test: `test/gates.test.js`

**Interfaces:**
- Consumes: `lib/repo.js`; `Jobs`; `linkedFolders` (boss-set links only, Task 1).
- Produces:
  - `projectRepo(dir, projectId) -> { repo, how: 'linked' | 'own' | 'none', why }`: the project's linked folder when it is a git repo; else `projects/<id>/code` (created with `ensureRepo` at the first coding task) when the project has no linked folder; `none` with a reason when the linked folder is not a repo.
  - Task header fields written by the office: `branch`, `worktree`, `base`.
  - New task status `checking`: the staff's run ended fine and the office is finishing the task (this task: merging; Tasks 6 and 7 add the gates). Dependants wait until `done`.
  - `Gates.afterRun(task) -> Promise<{ status: 'done' | 'failed', note }>` (this task: commit leftovers, merge, remove the worktree). One job's merges run one at a time (a per-repo queue).

Behaviour (only in a software office, for tasks with `kind: code` or `kind: test` and a `project:`):
- Job branch: when a job is approved, the office checks the repo with `state`. If it has no commits, is detached, or is not clean, the job stays `approved` but its coding tasks do not start; the board reason and one chat line say: `The project folder has changes that are not committed (or no branch checked out). Commit or stash them, then press Start again on the job.` Otherwise it creates `office/<job id>` from the current branch. A small job (a coding task with no `job:`) uses the current branch as its base and gets no job branch.
- Before a coding task starts: worktree `<office>/worktrees/<task id>` on branch `office/<task id>`, cut from the job branch (or the current branch). The prompt gains: `Work only in <worktree>. It is its own copy of the project on branch office/<task id>. Commit your work there (git -C "<worktree>" add ... then commit). Do not switch branches.` The `worktrees/` folder goes into the generated office `.gitignore`.
- A follow-up (`continues:`) of a coding task reuses that task's worktree and branch (re-created from the branch if it was removed).
- After the run ends fine: status `checking`; leftovers are committed (`commitAll`, message `Work in progress (uncommitted when the task ended)`); then merge into the job branch. No job: nothing to merge, the branch `office/<task id>` is left for the boss and the report says so. Then the worktree is removed and the task is `done`, with one line appended to its result: `Branch: office/<job or task id>.`
- Conflict: the task stays `checking`; the office writes a follow-up for the author: `Your branch does not merge into the job's branch. Files: <list>. In <worktree>, run git merge office/<job id>, fix the conflicts, commit, and report.` When that follow-up ends, the merge is tried again; a second conflict fails the task with the file list.
- A coding task whose project has `how: 'none'` runs in place as today; its board line says `No branch: the project folder is not a git repository.`
- Restart: on start, tasks left `checking` are put through `afterRun` again; `office/` worktrees whose task is `done`, `failed`, `stopped` or missing are removed.

- [ ] **Step 1: Write the failing tests** (`test/gates.test.js`; temp software office, a temp git repo as the project's linked folder set through `O.updateProject`, a fake `claude` whose behaviour is driven by words in the task text: `WRITE <file> <text>` makes it write and commit that file inside the worktree path found in its prompt; `LEAVE <file>` writes without committing):
  - A job with two coding tasks touching different files: each gets `worktrees/<id>` on `office/<id>`; after both end, `office/<job>` has both files, both worktrees are gone, the user's branch and files are unchanged, each task's result ends with `Branch: office/<job>.`
  - `LEAVE`: the uncommitted file is committed by the office and reaches the job branch.
  - Conflict: two tasks writing different text to the same line of the same file: one is `done`; the other gets a follow-up naming the file and is `done` after the follow-up (the fake resolves when it sees `git merge` in its prompt), or `failed` with the file list when it conflicts twice.
  - Dirty repo, detached HEAD, no commits: no worktree is created, the task stays `new` with the reason above, nothing in the repo changes.
  - A small job (no `job:`): branch `office/<task id>` exists afterwards, the current branch is untouched.
  - A linked folder that is not a repo: the task runs in place, status `done`, no worktree.
  - A project with no linked folder: `projects/<id>/code` becomes a repo and the task works there.
  - Restart: with a task file left `checking` and its worktree present, a new engine finishes it; a worktree whose task file is deleted is removed on start.

- [ ] **Step 2: Run to see them fail**

Run: `node test/gates.test.js`
Expected: FAIL (`Cannot find module '../lib/gates'`).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js lib/jobs.js lib/gates.js lib/server.js lib/templates.js test/gates.test.js package.json
git commit -m "One branch per coding task, merged into the job's branch by the office"
```

---

### Task 6: The tests gate

**Files:**
- Modify: `office-files/guard.js` (export `commandOk`), `lib/office.js` (`updateProject`, `getProject`: `test`, `setup`), `lib/gates.js`
- Test: `test/guard.test.js`, `test/gates.test.js`, `test/server.test.js`

**Interfaces:**
- Produces:
  - Guard export `commandOk(cmd) -> { ok, reason }`: true when `cmd` is one plain command (the guard's own `splitCommand` gives exactly one part), starts with an entry of some preset's `allow` list, hits nothing on the never-list or refused flags, and has only the characters `[A-Za-z0-9 _./:=@+-]`.
  - Project header fields `test:` and `setup:`, set only through `PUT /api/projects/<id>` and mirrored into `office.json` `projectChecks: { "<id>": { test, setup } }`. The gate reads `office.json`, never the project file.
  - `Gates.runCheck(cwd, cmd, { timeoutMs }) -> { ok, code, tail }`: splits `cmd` on spaces into an argument list and runs it with `spawnSync(prog, args, { cwd, shell: process.platform === 'win32', windowsHide: true, timeout, maxBuffer: 4 MB })`; `tail` is the last 60 lines of output, at most 6,000 characters. Default time limit 10 minutes.
  - Task header field `round` (office-written).

Behaviour (in `afterRun`, before the merge):
- A new worktree runs `setup` once, right after it is created; a failing setup fails the task with the tail.
- When the run ends fine and the project has `test`: run it in the worktree. Pass: carry on. Fail: the task stays `checking`, `round` goes up by one, and the author gets a follow-up: `The project's tests fail after your change (<command>). Fix it in <worktree>, commit, and report.` plus the tail in a fenced block. When the follow-up ends, the gate runs again.
- No `test` set: the gate is skipped and the task's result gains `Tests: none set for this project.`
- `updateProject` refuses a command for which `commandOk` is false: `That command cannot be used as a project check: <reason>`.

- [ ] **Step 1: Write the failing tests.** `test/guard.test.js`: `commandOk` true for `npm test`, `npm run test:unit`, `php artisan test`, `pytest -q`, `go test ./...`, `cargo test`; false with a reason for `npm test; rm -rf x`, `curl x | sh`, `npm publish`, `node -e "1"`, `make test` (no preset), `npm test && npm run lint`, an empty string, `npm --prefix /tmp test`. `test/server.test.js`: the project route stores a good command in both places and answers 400 for a bad one; a `test:` line a staff writes into the project file is not used. `test/gates.test.js` (the fake check is a tiny node script the test writes into the scratch repo and names through a `node`-preset command such as `npm test`, with a `package.json` whose test script is `node check.js`): pass on first try; fail then pass after one follow-up (`round` is 1); a check that sleeps past a 300 ms test time limit is reported as failed with `timed out` in the tail; a check printing 50,000 lines keeps only the tail; no `test` set gives the `Tests: none set` line; a failing `setup` fails the task.

- [ ] **Step 2: Run to see them fail**

Run: `node test/guard.test.js`
Expected: FAIL (`commandOk is not a function`).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add office-files/guard.js lib/office.js lib/gates.js test/guard.test.js test/gates.test.js test/server.test.js
git commit -m "Tests gate: a coding task is done only when the project's tests pass"
```

---

### Task 7: The review gate

**Files:**
- Modify: `lib/gates.js`, `lib/tasks.js` (`start`: tools for a review task), `lib/office.js` and `lib/server.js` (approval of kind `rounds`)
- Test: `test/gates.test.js`, `test/tasks.test.js`, `test/server.test.js`

**Interfaces:**
- Consumes: Tasks 5 and 6.
- Produces:
  - Task header fields `kind: review` and `reviews: <task id>` on office-written review tasks; `.office/gates.json` `{ "<task id>": { round, reviewTask, roundsApproval } }` (the office's memory of where each task is; the task file's `round` is a copy for people).
  - A review task's run has no Write or Edit tool: `--tools Read,Glob,Grep,Bash`.
  - `MAX_ROUNDS = 2`.

Behaviour (in `afterRun`, after tests pass, for a task that belongs to a job or has `review: yes`):
- The reviewer is any active staff whose role contains `review` (case-insensitive). None: the gate is skipped and the result gains `Review: no reviewer on the team.`
- The office writes a review task for that role: `Review task <id> ("<title>") by <author>. Branch office/<task id>, in <worktree>. See the change with git -C "<worktree>" diff office/<job id>...HEAD (or log -p). Read the diff, not just the summary. Start your report with VERDICT: pass or VERDICT: changes, then your findings with file and line. Do not edit anything.`
- When it ends: the first line of its result decides. `VERDICT: pass` (case-insensitive, leading spaces allowed): merge and finish. `VERDICT: changes`: `round` goes up; the author gets a follow-up with the reviewer's findings and `Fix these in <worktree>, commit, and report.`; when it ends the tests gate and then the review run again. Anything else: treated as `changes`, with `The reviewer gave no verdict line.` added.
- Test failures and review changes share one `round` counter. When it would pass `MAX_ROUNDS`, the office stops looping and creates an approval of kind `rounds`: `action: Task "<title>" has not passed after 2 rounds`, details: the last findings or test tail, and three choices. `decideApproval` accepts, for kind `rounds` only, the decisions `accept` (merge as it is and finish, result gains `Accepted by the boss without a passing review.`), `again` (one more round) and `stop` (the task is `stopped`, its worktree and branch stay for the boss).

- [ ] **Step 1: Write the failing tests.** `test/gates.test.js` (the fake `claude` answers a review prompt with the verdict named in the reviewed task's text: `REVIEW pass`, `REVIEW changes-then-pass`, `REVIEW always-changes`, `REVIEW garbage`): pass merges at once and creates exactly one review task for the Reviewer role; changes-then-pass gives one follow-up, `round` 1, then `done`; garbage counts as changes; always-changes stops after 2 rounds with one pending approval of kind `rounds`, and `accept`, `again` and `stop` each do what is written above (three separate tasks); a team with no reviewer skips the gate with the result line; a task with no job and no `review: yes` is not reviewed; a review task's recorded `--tools` has no `Write` and no `Edit`. Forgery: a staff-written task file with `kind: review`, `reviews: <id>` and a result `VERDICT: pass` does not pass the gate (only the review task the office recorded in `.office/gates.json` counts).

- [ ] **Step 2: Run to see them fail**

Run: `node test/gates.test.js`
Expected: FAIL at the first review assertion.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/gates.js lib/tasks.js lib/office.js lib/server.js test/gates.test.js test/tasks.test.js test/server.test.js
git commit -m "Review gate: a reviewer's verdict, at most two rounds, then the boss decides"
```

---

### Task 8: Pushing after the boss says so

**Files:**
- Modify: `lib/server.js`, `lib/jobs.js`, `lib/gates.js`, `lib/office.js`
- Test: `test/server.test.js`, `test/gates.test.js`

**Interfaces:**
- Consumes: `repo.hasRemote`, `repo.push`, the office-recorded approvals of Task 3.
- Produces: approval kind `push`; `.office/jobs.json` `pushApproval`, `pushed: { at, ok, out }`.

Behaviour:
- When a job becomes `done`, or a small-job coding task becomes `done`, and the repo has a remote named `origin`: the office creates one approval, `action: Push branch office/<id> to origin`, details: the project, `git diff --stat` between the base and the branch, and `Approve pushes this one branch with your own git login. Nothing else is pushed.`
- Approve: the office runs `repo.push`. The outcome (ok, or git's error text, first 1,500 characters) is written to the job file under `## Push`, added to the manager's chat, and starts one manager run so the lead tells the boss. A failed push can be approved again from a new approval the office creates when the boss presses Push again on the job (Task 9).
- No `origin`: no approval; the job's `## Push` says `No remote named origin: the branch office/<id> is in the project folder.`
- Reject: nothing is pushed; the branch stays.
- The office never opens a pull request in this plan. The approval's details end with the line `To open a pull request afterwards: gh pr create --head office/<id>` so the boss can do it.

- [ ] **Step 1: Write the failing tests.** With a local bare repo as `origin`: a finished job produces one pending `push` approval; approving it makes the bare repo have `office/<job>` and nothing else new; rejecting leaves the bare repo unchanged; a repo with no `origin` produces no approval and the `## Push` note. Forgery: a staff-written approval file with `kind: push`, `ref: <job>`, `status: approved`, and a staff-edited job file, push nothing; deciding a staff-written `push` approval through the route pushes nothing. A push that fails (remove the bare repo before approving) records the error and does not mark the job pushed.

- [ ] **Step 2: Run to see them fail**

Run: `node test/server.test.js`
Expected: FAIL (no push approval appears).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js lib/jobs.js lib/gates.js lib/office.js test/server.test.js test/gates.test.js
git commit -m "Push: the office pushes a job's branch only after the boss approves"
```

---

### Task 9: Dashboard

**Files:**
- Modify: `dashboard/app.js`, `dashboard/app.css`, `lib/server.js` (`GET /api/tasks` gains `checking`; `POST /api/jobs/<id>/stop`, `/start`, `/push`)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `GET /api/jobs`, `GET /api/tasks` (`active`, `waiting` with `reason`, new `checking: [{ id, staff, title, job, stage: 'tests' | 'review' | 'merge', round }]`), approvals with `kind`.
- Produces: routes `POST /api/jobs/<id>/stop` (job `stopped`, its running tasks stopped), `/start` (re-checks the repo and starts a job held for a dirty repo), `/push` (creates a new push approval after a failed push).

What the page shows:
- Work board: tasks grouped under their job, with a job row `<title>  <done>/<total>` and a Stop button; tasks with no job listed as today. A `checking` task shows `Testing`, `In review (round N)` or `Merging`. Waiting rows show `reason` when the API gives one.
- Needs your OK: a plan card lists the tasks (from the approval's details) with Approve and Reject; a rounds card has three buttons `Accept as it is`, `One more round`, `Stop the task`; a push card shows the diff summary with Approve and Reject.
- Projects page: `Test command` and `Setup command` fields with the hint `Run by the office in the task's own copy of the project. One plain command from the allowed lists, like npm test.` A refused command shows the server's message.
- Settings > General: `Start plans without asking me` (off by default).

- [ ] **Step 1: Write the failing server tests** for the three routes and the `checking` list.

- [ ] **Step 2: Run to see them fail**

Run: `node test/server.test.js`
Expected: FAIL (`No such API call`).

- [ ] **Step 3: Implement the routes, then the page.**

- [ ] **Step 4: Check in a real browser** (Playwright and Chromium are pre-installed; scratch office outside the repo, fake `claude`, a temp git repo as the linked project). Confirm: a planned job shows its plan card; approving it shows the job on the board with progress; a task passes through `Testing` and `In review`; a rounds card's three buttons work; the push card appears and Approve pushes to a local bare repo; the project fields save and a bad command shows the message. One screenshot of the board with a job, one of the plan card.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 6: Commit**

```bash
git add dashboard/app.js dashboard/app.css lib/server.js test/server.test.js
git commit -m "Dashboard: jobs on the work board, plan, rounds and push cards, project checks"
```

---

### Task 10: Instructions and docs

**Files:**
- Modify: `lib/templates.js` (software `paClaude`, `staffClaude`, `agentMd`, `officeMd`), `README.md`, `CLAUDE.md`
- Test: `test/generate.test.js`

What must be said (software office texts only; the business fixtures stay byte-identical):
- Lead: a small change is one coding task (`kind: code`, the project, the files or area, how to test it). A feature is a job: write `jobs/<id>.md` (first line the title, then what to build and how we will know it works), then the task files with `job:`, `kind:`, `needs:`, `role:`; split so each task owns different files; do not add QA or Reviewer tasks for coding tasks, the office runs the tests and the review itself; the boss approves the plan before anything starts; tasks added to an approved job start at once. The office merges and asks the boss about pushing; nobody pushes.
- Engineers: for a coding task you get your own copy of the project in `worktrees/<task id>`; work and commit only there; do not switch branches; the office runs the project's tests and a review after you report, and sends back what fails.
- Reviewer: you get a review task with the branch and the diff command; you cannot edit; first line `VERDICT: pass` or `VERDICT: changes`.
- `OFFICE.md`: `jobs/<id>.md`, `.office/jobs.json` (the office's, do not edit), `worktrees/`, the task fields `job`, `kind`, `branch`, `worktree`, `base`, `round`, `reviews`, the status `checking`, approval kinds (office-made only), `projectLinks` and `projectChecks` in `office.json`, `autoApprovePlans`, and the new API routes. The line that said `job:` and `kind:` have no effect yet is replaced.
- `README.md`: the Software house section's "Coming next" becomes what exists now (plan approval, a branch per task, tests and review before done, push on approval); budgets stay "coming next". `CLAUDE.md`: a dated status line, and `Next: build step 4 (cost and budgets)`.

- [ ] **Step 1: Write the failing test** in `test/generate.test.js`: the software lead text contains `jobs/` and `kind: code` and no longer tells the lead to add a Reviewer task; an engineer's text contains `worktrees/`; the Reviewer's text contains `VERDICT: pass`; `OFFICE.md` contains `checking`, `projectChecks` and `jobs.json`; the three business fixtures still match; no em or en dashes.

- [ ] **Step 2: Run to see it fail**

Run: `node test/generate.test.js`
Expected: FAIL on `jobs/`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/templates.js README.md CLAUDE.md test/generate.test.js
git commit -m "Docs: jobs, branches, gates and push in the office's instructions"
```

---

### Task 11: One real run

The fake `claude` cannot show whether a real engineer and reviewer follow these instructions.

**Files:**
- Create: `spike/jobs-e2e.js`
- Create: `docs/jobs-e2e-findings.md`

- [ ] **Step 1: Write `spike/jobs-e2e.js`** in the style of `spike/auto-mode-e2e.js`: a scratch software office in the temp folder, a tiny scratch project repo (a `package.json` with `"test": "node test.js"`, a `sum.js` and a failing-until-fixed `test.js`) linked through `O.updateProject` with `test: npm test`, a local bare repo as `origin`, everyone on Haiku. It writes one job with two coding tasks (add `sub` to `sum.js` with a test; add a `README.md` section), approves the plan through the same function the route calls, and waits up to 10 minutes. It prints, per task: the statuses it passed through, `round`, the reviewer's verdict line, tokens and cost; then the job branch's `git log --oneline`, whether the user's branch moved (it must not), and the pending push approval. It does not approve the push.

- [ ] **Step 2: Run it once**

Run: `node spike/jobs-e2e.js`
Expected: both tasks end `done`, the job branch has both changes, the user's branch is unchanged, one push approval is pending. If not, stop and report BLOCKED with the output.

- [ ] **Step 3: Write `docs/jobs-e2e-findings.md`**: date, versions, the table, total cost, what went wrong or was awkward (instructions the staff misread, extra rounds), and what was not measured. No private details.

- [ ] **Step 4: Commit**

```bash
git add spike/jobs-e2e.js docs/jobs-e2e-findings.md
git commit -m "Jobs: one real run of a two-task job through tests, review and merge"
```

---

## Not in this plan

Step 4: per-task and per-job cost, job budgets, the budget stop. Also left for later: opening a pull request from the dashboard; converting an existing office's type.
