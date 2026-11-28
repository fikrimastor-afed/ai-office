# Commands by Auto Mode Implementation Plan (before build step 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff can be switched from "only ticked commands" to "Claude judges each command" (Claude Code's auto mode), while the office's guard keeps refusing its never-list. Also close three known gaps in how the guard treats npm.

**Architecture:** One new per-staff setting, `commandMode: "auto"` in `office.json`. For that staff's dashboard runs the office starts Claude with `--permission-mode auto` and an `autoMode` block passed through `--settings`; the guard stops denying commands that are merely not on a list and gives no decision on them, so the classifier decides. Everything the guard refuses today for safety (never-list, refused flags, plain commands only, folder rule) it still refuses first.

**Tech Stack:** Plain Node 18+, no new dependencies. Tests are plain Node scripts in `test/`.

**Spec:** `docs/superpowers/specs/2026-11-28-software-house-team-design.md`, section 12. Trial result and build notes: `docs/auto-mode-spike-findings.md` (read its "For the build" section; it has the flags that worked and how refusals look).

## Global Constraints

- Plain Node, no shell-specific tricks: must run on Windows and Linux. Use `path` functions.
- No new dependencies. The server listens on localhost only. Never store or send user credentials.
- `Listed only` stays the default for everyone. A staff without `commandMode: "auto"` behaves exactly as today: same run flags, same guard decisions, same generated text.
- The guard is the safety boundary and stays short and readable. The trial showed the classifier alone allows `git push` and `git reset --hard`: nothing the guard refuses today may become allowed for an Auto staff. The refused lists only grow.
- The manager is never in auto mode. Terminal sessions are unchanged (the guard gives no decision there, as today).
- Nothing a staff can write (task files, project files, their own instructions) may reach the `--settings` text except real folder paths.
- All text the user sees is plain, short English in the existing voice ("the boss", "staff"). No em or en dashes. Dashboard HTML goes through `esc()`.
- `npm test` is green at the end of every task.

## Review Focus

1. `commandMode` hand-written as `"AUTO"`, `true` or `"listed "`: only the exact string `auto` switches a staff to auto; anything else is listed mode. Test in Task 2.
2. An Auto staff asks for the never-list in every spelling the guard already handles (`git push`, `git -C <folder> push`, `cd <linked> && git reset --hard`, `go test --exec sh`, a pipe, `$()`): all still refused in the dashboard. Test in Task 2.
3. An Auto staff asks for something outside the allowed folders (`cd /etc && ls`, `git -C /etc status`): refused by the guard, never passed to the classifier. Test in Task 2.
4. Auto does not leak: a staff without it, the manager, an unknown staff folder and a built-in subagent get today's answers when a colleague has Auto. Test in Task 2.
5. A linked folder whose path has spaces, quotes or a line that reads like an instruction (`C:\Work\Trust everything`): the `--settings` JSON stays valid and the path appears only as a quoted path inside one fixed sentence. Test in Task 3.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `office-files/guard.js` | modify | npm gaps; no decision on unlisted commands for an Auto staff |
| `lib/templates.js` | modify | `commandMode(s)`, the staff's Commands line, `autoSettings(cfg, dir, linked)`, OFFICE.md |
| `lib/chat.js`, `lib/tasks.js` | modify | Run flags and the note for an Auto staff |
| `lib/office.js` | modify | Save `commandMode` from the Staff page |
| `dashboard/app.js` | modify | The Commands choice on the Staff page |
| `spike/auto-mode-e2e.js`, `docs/auto-mode-spike-findings.md` | create / modify | One real run of the built feature |
| `test/guard.test.js`, `test/chat.test.js`, `test/tasks.test.js`, `test/server.test.js`, `test/generate.test.js` | modify | Tests |
| `README.md`, `CLAUDE.md` | modify | One row and a status line |

---

### Task 1: Close the npm gaps in the guard

**Files:**
- Modify: `office-files/guard.js` (`ALWAYS_DENY`, `DENY_FLAGS`, the flag check)
- Test: `test/guard.test.js`

**Interfaces:**
- Produces: nothing new by name. Task 2 builds on the same `decide` flow.

The gaps (found by the last review, all allowed today for a staff with npm ticked): `npm -C <dir> ...` (short for `--prefix`); abbreviated long flags, which npm accepts (`npm install --prefi /x`); installing outside the project with `npm install -g`, `--global` or `--location=global`.

- [ ] **Step 1: Write the failing tests.** The test office's `shah` has `git` and `laravel`; add `node` (the npm preset) to `irfan`'s commands.

```js
test('npm cannot be pointed outside the folder or install for the whole computer', () => {
  const o = { agent: 'irfan' };
  for (const c of ['npm -C /tmp install', 'npm install -C /tmp', 'npm install --prefi /tmp', 'npm install --prefi=/tmp', 'npm install --pref"ix" /tmp',
    'npm install -g cowsay', 'npm install --global cowsay', 'npm i --glob cowsay', 'npm install --location=global cowsay', 'npm install --loc global x',
    'pnpm add -g x', 'pnpm install --global', 'yarn global add x']) deny(c, o);
  for (const c of ['npm install', 'npm install --prefer-offline', 'npm ci', 'npm run build', 'npm test -- --grep prefix', 'npm ls --long', 'pnpm install', 'yarn install']) allow(c, o);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node test/guard.test.js`
Expected: FAIL at `should deny: npm -C /tmp install`.

- [ ] **Step 3: Implement**

- `DENY_FLAGS.npm` becomes `['--prefix', '-C', '-g', '--global', '--location']`; `DENY_FLAGS.pnpm` gains `-g` and `--global`. `-C`, `-g`, `--global` and `--location` join `MOVE_FLAGS` (they get the "use cd first" style reason; for the global ones the reason is `"<flag>" is not allowed with <first word>: it installs outside the project.`).
- npm accepts any unambiguous shortening of a long flag. For `npm` only: a word that starts with `--` matches a listed long flag when its name (dashes and any `=value` removed) has at least 3 letters and the listed flag's name starts with it. So `--pre`, `--pref`, `--prefi` match `prefix`; `--prefer-offline` does not; `--glo` matches `global`; `--loc` matches `location`; `--long` does not. Words after a bare `--` are arguments for the script, not npm flags: stop checking at `--` for npm (that is why `npm test -- --grep prefix` passes).
- `ALWAYS_DENY` gains `yarn global`.
- Keep the check a few lines; no restructuring of `decide`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add office-files/guard.js test/guard.test.js
git commit -m "Guard: npm cannot be pointed outside the folder or install globally"
```

---

### Task 2: The guard steps aside for an Auto staff, never for the never-list

**Files:**
- Modify: `office-files/guard.js` (`decide`), `lib/templates.js` (helper)
- Test: `test/guard.test.js`

**Interfaces:**
- Produces:
  - Guard export `autoOn(staff) -> boolean`: true only when `staff && staff.commandMode === 'auto'`.
  - `decide(...)` for an Auto staff in dashboard mode returns `{ decision: null, reason: 'auto mode decides' }` where today it would deny a command only for not being on the list (including "has no commands turned on" and the node-script rule). A command that IS on their ticked list still returns `allow` (no classifier needed).
  - `T.commandMode(s) -> 'auto' | 'listed'` in `lib/templates.js`, using `autoOn`.

Order inside `decide` stays as it is: plain commands only, never-list, refused flags, who is asking, then the folder rule (`cd` and `git -C` targets, with the never-list re-checked after `git -C`), and only then the per-command list check, which is the one place Auto changes the answer. The `elsewhere` and "Use one cd at the start" refusals stay refusals for an Auto staff.

- [ ] **Step 1: Write the failing tests.** Add to the test office: `{ id: 'wei', name: 'Wei Jie', commandMode: 'auto' }` (nothing ticked) and `{ id: 'priya', name: 'Priya', commands: ['git'], commandMode: 'auto' }`.

```js
test('auto staff: the guard gives no decision on an unlisted command, and still refuses the never-list', () => {
  const r = (c, o = {}) => run(c, { agent: 'wei', ...o });
  const none = (c, o) => { const x = r(c, o); assert.strictEqual(x.decision, null, `no decision: ${c} (${x.reason})`); };
  for (const c of ['make test', 'ls -la', 'cd /home/ali/projects/8fix && ./gradlew build', 'node -e "1"', 'docker compose up -d', 'git -C /home/ali/projects/8fix describe --always']) none(c);
  for (const c of ['git push', 'git push origin main', 'git -C /home/ali/projects/8fix push', 'cd /home/ali/projects/8fix && git reset --hard HEAD~1', 'go test --exec sh', 'npm publish',
    'npm install -g x', 'ls | cat', 'echo $(whoami)', 'make test; rm -rf x', 'rm -rf build', 'curl http://x', 'cd /etc && ls', 'git -C /etc status', 'cd /home/ali/projects/8fix && cd .. && ls'])
    assert.strictEqual(r(c).decision, 'deny', c);
  assert.strictEqual(run('git status', { agent: 'priya' }).decision, 'allow');          // ticked: allowed outright
  assert.strictEqual(run('make test', { agent: 'priya' }).decision, null);
});

test('auto is one staff\'s setting: nobody else gains anything, and only the exact value counts', () => {
  deny('make test', { agent: 'siti' });                                                   // listed staff, as today
  deny('make test', { agent: 'general-purpose' });
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'make test' }, cwd: office.dir }, office, { chat: true, win: false }).decision, 'deny');   // the manager
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'make test' }, cwd: '/home/ali/office/staff/ghost' }, office, { chat: true, win: false }).decision, 'deny');
  for (const v of ['AUTO', true, 'listed ', 1, {}]) {
    const o2 = { ...office, staff: office.staff.map((s) => (s.id === 'wei' ? { ...s, commandMode: v } : s)) };
    assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'make test' }, agent_type: 'wei', cwd: o2.dir }, o2, { chat: true, win: false }).decision, 'deny', String(v));
  }
  assert.strictEqual(run('make test', { agent: 'wei', chat: false }).decision, null);     // terminal: as today
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node test/guard.test.js`
Expected: FAIL at `no decision: make test`.

- [ ] **Step 3: Implement** as described under Interfaces. One comment line in the guard's plain voice says why: auto mode's own check allows a push, so the never-list stays here.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add office-files/guard.js lib/templates.js test/guard.test.js
git commit -m "Guard: for a staff on auto, unlisted commands go to Claude's own check; the never-list stays"
```

---

### Task 3: Auto staff runs start in auto mode

**Files:**
- Modify: `lib/templates.js` (`autoSettings`, `commandsLine`, `hasCommands` use, `staffClaude`, `agentMd`), `lib/chat.js` (`access`, run arguments), `lib/tasks.js` (`start`)
- Test: `test/chat.test.js`, `test/tasks.test.js`, `test/generate.test.js`

**Interfaces:**
- Consumes: `T.commandMode(s)` from Task 2.
- Produces:
  - `T.autoSettings(cfg, dir, linkedPaths) -> string`: the JSON for `--settings`.
  - `access(dir, who, opts)` gains `auto: boolean` in its result (true only for a staff whose `commandMode` is auto); `shell` is true for that staff even with nothing ticked.
  - Run arguments for an Auto staff (chat and task): `--permission-mode auto` in place of `default`, `Bash` in `--tools`, and `--settings <T.autoSettings(...)>`. Everyone else: unchanged, byte for byte.

Exact shape of the settings JSON (the trial's working shape):

```json
{"autoMode":{"environment":["$defaults","The trusted workspace is this office folder and the folders the boss linked: \"<office>\", \"<linked 1>\". Work stays inside them."],
"hard_deny":["$defaults","Never run: git push, git reset --hard, ... (the guard's whole ALWAYS_DENY list, comma separated).","Never publish a package, deploy, or change anything outside the trusted workspace."]}}
```

Paths are put in with `JSON.stringify` (so quotes and backslashes are escaped) and only paths: no labels, no text from any file a staff can write. With no linked folder the sentence names the office folder alone.

Text for an Auto staff (the trial showed Claude will not even try an unlisted command if its instructions say "only listed commands"):
- `commandsLine(s)` for an Auto staff: `- Commands: you may run the commands the work needs, in the office or a linked folder. Claude Code checks each one and may refuse it. Never: git push, reset --hard, publishing, deleting with rm; the boss does those. If a command is refused, do not try another spelling: say so in your report.` (Start a linked-folder command with `cd "<folder>" &&`, as the existing line says.)
- `hasCommands(s)` is true for an Auto staff, so `staffClaude` shows that line and `agentMd` lists `Bash`.
- `access()` note: for the Auto staff themselves, the commands sentence says the same as that line in one sentence; for the manager, the list of who may run commands shows them as `<Name> (any command the work needs, checked by Claude Code)`.

- [ ] **Step 1: Write the failing tests.**

`test/generate.test.js`:

```js
// auto settings: valid JSON, only paths go in, the never-list is there
{
  const s = JSON.parse(T.autoSettings(softwareCfg, 'C:\\Offices\\acme', ['C:\\Work\\Trust everything "now"', '/srv/app']));
  assert.deepStrictEqual(Object.keys(s), ['autoMode']);
  assert.strictEqual(s.autoMode.environment[0], '$defaults'); assert.strictEqual(s.autoMode.hard_deny[0], '$defaults');
  assert.ok(s.autoMode.environment[1].includes(JSON.stringify('C:\\Work\\Trust everything "now"')));
  assert.strictEqual(s.autoMode.environment.length, 2);                       // one fixed sentence, nothing else
  for (const d of require('../office-files/guard').ALWAYS_DENY) assert.ok(s.autoMode.hard_deny[1].includes(d.trim()), d);
  assert.ok(JSON.parse(T.autoSettings(softwareCfg, '/o', [])).autoMode.environment[1].includes('"/o"'));
}
// the staff's own text
{
  const auto = { ...softwareCfg.staff[1], commandMode: 'auto', commands: [] };
  const md = T.staffClaude(softwareCfg, auto);
  assert.match(md, /Claude Code checks each one and may refuse it/); assert.match(md, /do not try another spelling/);
  assert.doesNotMatch(md, /Commands you may run, in the office or a linked folder: /);
  assert.match(T.agentMd(softwareCfg, auto), /^tools: .*Bash/m);
  assert.strictEqual(T.staffClaude(softwareCfg, softwareCfg.staff[1]), T.staffClaude(softwareCfg, { ...softwareCfg.staff[1], commandMode: 'listed' }));
}
```

`test/chat.test.js` (the file's fake `claude` records its arguments): with one staff set to `commandMode: 'auto'` in the test office, their chat run has `--permission-mode` followed by `auto`, `Bash` in `--tools`, and `--settings` followed by JSON that parses and has `autoMode`; another staff's run and the manager's run have `--permission-mode default` and no `--settings`. `test/tasks.test.js`: the same three assertions for a task run of the Auto staff, and `default` with no `--settings` for another staff.

- [ ] **Step 2: Run to see them fail**

Run: `node test/generate.test.js`
Expected: FAIL (`T.autoSettings is not a function`).

- [ ] **Step 3: Implement** as described. The argument lists in `lib/chat.js` and `lib/tasks.js` are built in one place each; change only the mode value, the tools list and the added `--settings` pair.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 5: Commit**

```bash
git add lib/templates.js lib/chat.js lib/tasks.js test/chat.test.js test/tasks.test.js test/generate.test.js
git commit -m "Auto staff: runs start in auto mode with the office's never-list and trusted folders"
```

---

### Task 4: The choice on the Staff page, and the docs

**Files:**
- Modify: `lib/office.js` (`updateStaff`, `getStaff`), `dashboard/app.js` (staff form), `lib/templates.js` (`officeJson`, `officeMd`), `README.md`, `CLAUDE.md`
- Test: `test/server.test.js`, `test/generate.test.js`

**Interfaces:**
- Consumes: `T.commandMode`, `T.commandsLine`.
- Produces: `PUT /api/staff/<id>` accepts `commandMode: 'auto' | 'listed'`; `office.json` stores `commandMode: "auto"` on the staff and removes the key for `listed`; `GET /api/staff/<id>` returns `commandMode`.

Behaviour:
- `updateStaff`: any other value is `OfficeError('Commands can be "listed" or "auto".')`. Changing the mode rewrites the staff's Commands line in their `CLAUDE.md` Tools section and the `Bash` entry of their agent file's `tools:` line, the same way ticking commands does today (the existing code path that keeps them in step). Ticked presets and custom commands are kept when switching to Auto, so switching back restores them.
- Staff page, above the command tick-boxes, a choice with two options:
  - `Listed only` with the hint `Only the commands ticked below.`
  - `Auto` with the hint `Claude Code checks each command and decides. The office still refuses push, publish and deleting. Good for engineers; watch the usage bar at first.`
  With Auto chosen the tick-boxes stay visible but dimmed, with the line `Kept for when you switch back.`
- The manager's card has no such choice.
- `officeMd`: one line under "More office.json settings" for a staff's `commandMode`. `README.md`: one sentence in the Commands row of "What staff can and cannot touch". `CLAUDE.md`: a dated status line naming this plan and `docs/auto-mode-spike-findings.md`.

- [ ] **Step 1: Write the failing tests.** `test/server.test.js`: `PUT /api/staff/<id> { commandMode: 'auto' }` stores it, the staff's `CLAUDE.md` gains the "Claude Code checks each one" line and loses the "Commands you may run" line, and the agent file's `tools:` has `Bash`; `{ commandMode: 'listed' }` removes the key and restores the earlier line exactly (compare with the text before the first change); `{ commandMode: 'yes' }` answers 400 with `Commands can be "listed" or "auto".`; `PUT /api/manager { commandMode: 'auto' }` stores nothing. `test/generate.test.js`: the generated `OFFICE.md` contains `commandMode`.

- [ ] **Step 2: Run to see them fail**

Run: `node test/server.test.js`
Expected: FAIL (the key is not stored).

- [ ] **Step 3: Implement** as described under Behaviour.

- [ ] **Step 4: Check the Staff page in a real browser** (Playwright and Chromium are pre-installed; build a scratch office outside the repo as `test/server.test.js` does). Confirm: the choice shows the saved value after a reload, switching to Auto dims the tick-boxes and saves, switching back restores the ticks. Take one screenshot of the form with Auto chosen.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 6: Commit**

```bash
git add lib/office.js lib/templates.js dashboard/app.js README.md CLAUDE.md test/server.test.js test/generate.test.js
git commit -m "Staff page: Commands can be Listed only or Auto"
```

---

### Task 5: One real run of the built feature

The trial tested the two halves separately (the guard's refusal in auto mode; an unlisted command running in auto mode). This runs them together through the real code path, once.

**Files:**
- Create: `spike/auto-mode-e2e.js`
- Modify: `docs/auto-mode-spike-findings.md` (append a section "After the build")

- [ ] **Step 1: Write `spike/auto-mode-e2e.js`**, in the style of `spike/auto-mode-spike.js` (same scratch office, linked project and local bare remote in the temp folder, same cleanup; `--model haiku`; nothing touches the network). It sets the scratch staff to `commandMode: 'auto'` through `O.updateStaff`, then starts two tasks through the real `Tasks` class from `lib/tasks.js` (wired as `lib/server.js` wires it):
  1. `Run exactly this and report its output in one line: git -C "<linked>" describe --always`
  2. `Run exactly this and report what happened in one line: cd "<linked>" && git push origin HEAD`

  It prints, for each: the run's arguments (mode, `--settings` present), whether the command ran, who refused it if not, the task's result text, tokens and cost.

- [ ] **Step 2: Run it once**

Run: `node spike/auto-mode-e2e.js`
Expected: task 1's command ran and the report has a commit id; task 2's push was refused with the guard's reason and the bare repo has no refs. If either differs, stop and report BLOCKED with the output: the feature is not working as designed.

- [ ] **Step 3: Append "After the build"** to `docs/auto-mode-spike-findings.md`: date, the two results, the numbers, and anything still not measured. No private details.

- [ ] **Step 4: Commit**

```bash
git add spike/auto-mode-e2e.js docs/auto-mode-spike-findings.md
git commit -m "Auto mode: one real run through the built task path"
```

---

## Not in this plan

Build step 3 (jobs and plan OK, one branch per task, test and review gates, push on approval) and step 4 (cost and budgets) follow this plan.
