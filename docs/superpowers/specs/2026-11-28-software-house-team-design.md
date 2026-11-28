# Software house office with an agent-team workflow

Date: 2026-11-28. Status: design, waiting for the owner's approval. Nothing is built yet.

## Intent

AI Office today is a small-business back office: one manager, business staff, office documents.
The owner wants a second kind of office, a **software engineering house**, whose staff coordinate
the way Claude Code's agent teams do (shared task list, dependencies, claiming, direct messages,
quality gates), because that gives better output. It must stay at a **reasonable running cost**.

## Goals

1. A "Software house" office type, chosen in the wizard, with an engineering team by default.
2. The agent-team mechanics inside the office's own task engine, so they work from the dashboard.
3. Code work that is safe in parallel (one branch per task) and checked before it counts as done
   (tests, then a reviewer).
4. Cost stays visible and bounded: small jobs stay small, big jobs have a budget.

## Non-goals

- Replacing the business office. It keeps working exactly as today.
- Driving Claude Code's native agent teams from the dashboard (not possible, see Constraints).
- Pulling stories from a GitHub Projects board into the office. The boss names the story number in chat.
- CI integration, deploys, auto-merge to the main branch.
- Nested teams (a staff leading their own team).
- Mac testing (still untested, as before).
- Converting an existing business office into a software house. The type is chosen at setup.

## Anti-goals (a failure even if it "works")

- A job that quietly burns the user's plan limit.
- Code leaving the computer (push, pull request) without the boss's OK.
- Existing offices or existing file contracts breaking after an update.

## Constraints

- Native agent teams do not spawn teammates in non-interactive mode (`claude -p`), which is how
  every dashboard chat and task runs. They are experimental, cannot resume sessions, and keep
  state in `~/.claude`, outside the office. (Claude Code docs, agent-teams page, checked 2026-11-28.)
- Repo rules (CLAUDE.md): plain Node, Windows and Mac, near-zero dependencies, localhost only,
  no stored credentials, tiny readable hooks, stable documented file contracts.
- A staff run is one `claude -p` process per task. Staff are not long-lived, so "claiming" and
  "messaging" are done by the office engine between runs.

## Approaches

| | What | Trade-off |
|---|---|---|
| A | Native agent teams: the manager leads a real Claude Code team | Cannot run from the dashboard; terminal only; experimental |
| **B** | **The team pattern in the office's task engine** (`lib/tasks.js`, `tasks/` files) | More to build; works in the dashboard, survives restarts, cost under our control |
| C | Roles only: engineer presets and a looser guard | Cheapest; no coordination, no review loop, so no better output |

**Picked: B**, by the owner, plus native teams switched on for people who run `claude` in the
office folder in a terminal (a setting, see "Terminal use").

## Design

### 1. Office type

- `office.json` gets `type: "business" | "software"`. Missing means `business`.
- The wizard asks it as its first question after the company name. `--answers` accepts `type`.
- Default software team (in `lib/defaults.js`, next to `STAFF`; names are the builder's choice,
  in the same style as today):

| Role | Job | Model | Commands ticked |
|---|---|---|---|
| Tech Lead (the manager) | Talks to the boss, writes the spec and plan, hands out tasks, merges, reports | Opus, medium | none (does not run commands, as today) |
| Product Analyst | Turns a request into a short spec with acceptance checks | Sonnet, medium | none |
| Backend Engineer | Server, data, APIs | Sonnet, medium | git, npm |
| Frontend Engineer | UI | Sonnet, medium | git, npm |
| QA Engineer | Writes and runs tests, reproduces bugs | Sonnet, medium | git, npm |
| Reviewer | Reads diffs for bugs, security, missing tests. Does not edit code | Sonnet, medium | git (read-only use) |

  Optional extras the wizard offers: DevOps, Designer. Default team size 5 staff plus the lead.
- The manager's and staff's generated instructions (`paClaude`, `staffClaude`, `agentMd` in
  `lib/templates.js`) get a software variant. The business text is unchanged.

### 2. Shared task board (extends `tasks/<id>.md`)

All new header fields are optional, so today's task files stay valid.

| Field | Meaning |
|---|---|
| `job:` | Id of the job (feature) this task belongs to. Groups tasks on the board and for the budget |
| `needs:` | Comma-separated task ids that must be `done` first |
| `role:` | Used when `staff:` is empty: any active staff with this role may take it |
| `kind:` | `plan`, `code`, `test`, `review`, or empty (as today) |
| `continues:` | Task id whose Claude session this task resumes (a follow-up to the same person) |
| `review:` | `yes` asks for a review on a task that would not get one. A review can be added, never switched off |
| `session:`, `branch:`, `worktree:`, `round:`, `cost:` | Written by the office, never by staff |

Engine rules (`lib/tasks.js`):

- **Waiting.** A `new` task with unfinished `needs` does not start. It shows as "Waiting for ..."
  on the board. Status in the file stays `new`; waiting is computed.
- **Unblocking.** When a task finishes `done`, the engine rescans; dependants start on their own.
  If a needed task ends `failed` or `stopped`, dependants keep waiting and the lead gets a message
  naming them, so the lead (or boss) decides.
- **Claiming.** A task with `role:` and no `staff:` goes to the first idle active staff with that
  role, oldest task first; the engine writes `staff:` into the file. Assignment by name works as today.
- **One task per staff at a time, different staff in parallel**, as today, plus an office-wide
  limit `maxParallel` (default 3) in `office.json`.
- **Follow-ups.** A task with `continues:` runs as `claude -p --resume <session>` of that earlier
  task, same staff, same worktree. This is how review findings and test failures go back to the
  author cheaply (the context is already cached).
- **Staff to staff.** Staff may already write a task for a colleague (`from: <staff id>`); the
  answer goes back to the asker. That stays the message channel. No separate mailbox folder.

### 3. Jobs and planning

- New folder `jobs/`, one file per job: `jobs/<id>.md` with header `project`, `status`
  (`planned | approved | working | done | stopped`), `budget`, `spent`, and a body holding the
  spec (what, acceptance checks) and the task list.
- **Who decides.** Staff can edit files in `jobs/` and `tasks/`, so the file is not the authority.
  The boss's decisions (plan approved, budget, spent, push approved) live in `.office/jobs.json`,
  written only by the dashboard, the same way `.office/grants.json` works today. The office copies
  them into the job file for reading; a status or budget a staff writes there is ignored.
- **Small job:** the lead judges the change touches one area and is small. It writes one `code`
  task for one engineer, no job file. Gate: tests only.
- **Feature:** the lead writes `jobs/<id>.md` and the task files with `job:` and `needs:`
  (typically: spec by the Analyst if the request is vague, then code tasks split so each owns
  different files, then a test task). Tasks of a `planned` job do not start.
- **Plan OK.** The plan appears in Needs your OK with the task list and the budget. Approve sets
  the job to `approved` and the engine starts it. The boss can set "plans" to Always allow, using
  the existing Ask first / Always allow mechanism.

### 4. One branch per task

Applies to `kind: code` and `kind: test` tasks in a software office. If the project has a `linked:`
folder that is a git repository, that is the repo. If it has none (a brand-new app), the office
runs `git init` in `projects/<project>/code/` at the first code task and uses that. A linked
folder that is not a git repository: the task runs in place, with the tests gate only, and the
board says why.

- The **office** (Node, not the staff) runs git for this. Before a task starts it creates a
  worktree at `<office>/worktrees/<task id>/` on branch `office/<task id>`, cut from the job
  branch `office/<job id>` (or from the repo's current branch for a small job). The path is
  inside the office folder, so the existing file and guard rules already cover it. `worktrees/`
  goes in the office `.gitignore`.
- The staff is told to work only in that worktree and to commit there.
- When the task passes its gates, the office merges its branch into the job branch and removes
  the worktree. On a merge conflict the author gets a follow-up task to resolve it.
- A dependant task's worktree is cut after its `needs` are merged, so it sees their work.
- A finished job leaves one branch, `office/<job id>`, in the repo. A small job leaves
  `office/<task id>`. The office never merges into, or changes, the branch the user has checked
  out; bringing the work in is the boss's step (or the pull request's). Nothing is pushed.

### 5. Quality gates

A `code` task is `done` only after:

1. **Tests.** The project header gets `test:` (for example `npm test`) and optional `setup:`
   (for example `npm ci`, run once in a new worktree). Each must start with a command from one of
   the guard's presets (any preset, whatever the author has ticked) and contain nothing from the
   always-refused list; otherwise the gate fails with a plain message to the boss. The office runs `test:` in the worktree. A failure becomes a follow-up to the
   author with the end of the output. No `test:` set: this gate is skipped and the board says so.
2. **Review**, for tasks in a job (or `review: yes`). The office writes a `review` task for the
   Reviewer role with the branch and the diff range. The Reviewer's report must start with
   `VERDICT: pass` or `VERDICT: changes`. `changes` becomes a follow-up to the author.

Each follow-up raises `round:`. After 2 rounds without a pass the task stops looping: the lead is
told and an item in Needs your OK asks the boss to accept as is, give one more round, or stop.

The Reviewer's runs get read tools only (Read, Glob, Grep, and git status/diff/log/show).

### 6. Leaving the office

- `git push` stays in the guard's always-refused list for staff.
- When a job (or a small job's task) is done, the lead writes an approval "Push branch `office/<job>`" (and "open a pull
  request" when the `gh` command is installed and logged in on the user's machine). On Approve the
  **office** runs the push with the user's own git setup. AI Office stores no tokens.

### 7. Cost controls

| Control | Default |
|---|---|
| Small jobs skip plan and review | on |
| `maxParallel` staff runs at once | 3 |
| Review rounds per task | 2 |
| Job `budget`, in dollars at API prices (what `lib/usage.js` already counts) | 5.00, set per job by the lead, editable by the boss |
| Models | lead Opus, staff Sonnet, medium effort (as today) |

- Each finished run adds its cost to the task (`cost:`) and the job (`spent:`). The lead's runs
  that a job's tasks trigger count toward the job too; the boss's own chat with the lead does not.
- Inside a job the lead is not woken at every task end (today each one is an Opus run). The
  engine handles gates and follow-ups itself; the lead is woken when the job ends, when a task
  fails, and when something needs the boss.
- At 100% of the budget no new task of that job starts; running ones finish. Needs your OK asks:
  raise the budget or stop the job.
- The work board shows each job's spent / budget.

### 8. Guard

- New command presets for the Staff page: pnpm, yarn, Python (pytest, pip install -r), Go
  (build, test), Rust (cargo build, test). Same shape as the existing presets.
- The always-refused list is unchanged.

### 9. Dashboard

- Work board: tasks grouped by job; each shows who, kind, waiting-for, round, and cost. A job
  row shows progress and spent / budget, with Stop for the whole job.
- Needs your OK: three new kinds (plan, review rounds used up, budget reached, push).
- Staff and Projects pages: the new fields (`role` is already there; project `test:` / `setup:`).
- 3D office: no change required. The outside booth is used only when a customer-service role exists.

### 10. Terminal use (native agent teams)

For software offices the generated `.claude/settings.json` sets
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, with a switch in Settings to turn it off. It has no
effect on dashboard runs. In a terminal, the staff definitions in `.claude/agents/` double as
teammate definitions, so "spawn a team with the backend and reviewer staff" works. The hook
logs the `TeammateIdle`, `TaskCreated` and `TaskCompleted` events like the others.

### 11. The owner's own flow, with installed skills, in the dashboard

The owner's usual flow is: a user story number from their tech lead, brainstorm with Claude
(superpowers), write the spec, close the gaps (grill-me), write the implementation plan, then
build task by task with subagents. Today that works only in a terminal, because dashboard runs
get a fixed tool list without the Skill tool. This section makes it work in the dashboard too.

- **Skills switch.** A per-person switch on the Staff page, "Use my installed Claude skills"
  (`skills: true` in `office.json`). When on, that person's dashboard chats and tasks get the
  Skill tool added to `--tools` and `--allowedTools`, so the skills installed in the user's own
  Claude Code are available. Off by default for everyone; in a software office the wizard turns
  it on for the lead only. Skills cost tokens on every run, so the switch says so.
- **Stages stay the user's.** The office does not hard-code brainstorm, spec, grill or plan
  stages. Whatever skills the user has installed drive that part of the conversation with the
  lead. Section 3's plan OK still applies before a build starts.
- **Hand-off to the board.** The lead's instructions say: when a skill reaches the point of
  building (dispatching subagents or executing a plan), do not spawn subagents; write the plan's
  tasks as `tasks/` files with `job:`, `needs:` and `role:`, so the build runs on the office board
  with its branches, gates and budget. The spec and plan documents the skills write are saved in
  the project (the repo's `docs/` when there is one) and linked from the job file.
- **Skills never widen access.** A skill only adds instructions. The tool list, file limits and
  command guard stay the same, so a skill that asks for a command the person may not run is
  refused as today.
- **Looking up a story by number.** New guard preset "GitHub (read only)": `gh issue view`,
  `gh issue list`, `gh pr view`, `gh pr list`, `gh pr diff`, `gh project item-list`, run with the
  `gh` login on the user's machine. It can be ticked for the lead as well; this is the one case
  where the lead runs commands, so the guard's "the manager does not run commands" rule becomes
  "only what is ticked for the manager", and only this preset is offered there. Writing to
  GitHub (comment, edit, close, merge) is not in the preset.
- **Trial first.** How skills behave in non-interactive `claude -p` runs is not tested. Before
  this is built, a spike (like `spike/` in Milestone 1) checks: do installed plugin skills load
  with `-p` and the Skill tool in `--tools`; does a one-question-at-a-time skill work across
  `--resume` turns; what a skill adds in tokens per run. If skills do not load or cost too much,
  this section is dropped and the terminal stays the place for the skills flow; the rest of the
  design does not depend on it.

### 12. Commands by auto mode (optional, per staff)

Added 2026-11-28 at the owner's request, after build step 2 showed that a list of allowed
commands needs constant patching. Claude Code's auto mode has a separate classifier model that
reviews each action and blocks the risky ones (docs: permission-modes and auto-mode-config,
checked 2026-11-28). It works in `claude -p --permission-mode auto`; a blocked action is refused
and the run goes on. The docs warn that it "does not guarantee safety", so it is offered beside
the guard, not instead of it.

- **A choice per staff** on the Staff page, "Commands": `Listed only` (today's behaviour, the
  default for everyone) or `Auto (Claude judges each command)`. Saved as `commandMode: "auto"`
  on the staff in `office.json`. Not offered for the manager, who keeps the read-only GitHub list.
- **What Auto changes for that staff's dashboard runs:** the run starts with
  `--permission-mode auto` and has the shell tool; the guard no longer needs the command to be
  on a ticked list. Their ticked presets are ignored while Auto is on (kept for switching back).
- **What does not change:** the guard still refuses the always-refused list (push, publish,
  deploy-like and destructive commands), the refused flags, and anything but plain commands, and
  still keeps commands inside the office and linked folders. Auto mode would allow `git push` by
  default; the office does not. File limits and the office's own settings files stay protected.
- **Telling the classifier what is trusted:** the dashboard passes an `autoMode` block on each
  run with `--settings` (auto mode does not read it from a project's settings file): the office
  folder and the linked folders as the trusted environment, and the office's never-list as hard
  denies.
- **Terminal use** is unchanged: the user's own Claude Code mode applies there.
- **Cost:** the Staff page says that Auto adds a check to every command.
- **Trial first** (`spike/auto-mode-spike.js`, findings in `docs/auto-mode-spike-findings.md`).
  Build it only if, in runs shaped like the dashboard's: a harmless command runs in auto mode
  without being pre-allowed; a refusal from the guard hook still stops the command in auto mode;
  a command inside a linked folder runs; and a run in auto mode costs no more than twice the
  same run with the command pre-allowed. Also recorded, for information: whether the classifier
  by itself blocks a destructive command and a push, and whether `--settings` with `autoMode` is
  accepted.

### 13. Documentation and tests

- The generated `OFFICE.md` documents every new field, `jobs/`, `worktrees/`, and the new local
  API routes, as it does for the current contracts.
- README: a short "Software house" section.
- Tests in `test/` in the existing style (plain Node, no real Claude runs).

## Build order

1. Board: `needs`, `role` claiming, `continues`, `maxParallel`, board UI. Useful for business offices too.
2. Software office type: wizard, default team, instruction templates, guard presets, native-teams setting.
   Skills spike, then the skills switch and the GitHub read-only preset (section 11).
3. Jobs, plan OK, worktrees, test and review gates, push approval.
4. Cost: per-task and per-job cost, budget stop, board display.

Each step ends with `npm test` green and the owner trying it.

## Calls made by the designer (not decided by the owner)

- Office type as a wizard choice, keeping the business office.
- Engine-side claiming and follow-ups instead of a mailbox folder.
- The office, not staff, runs worktree, merge and push commands.
- Plan approval on by default; budget default 5.00; 2 review rounds; 3 parallel runs.
- Native agent teams on by default for software offices in the terminal.
- Decisions kept in `.office/jobs.json`, out of staff reach; reviews cannot be switched off.
- New projects get their own git repo in `projects/<project>/code/`; the office never touches the user's checked-out branch.
- The lead is woken per job, not per task; its job-triggered runs count toward the budget.
- No switching an existing office's type.
- Skills in the dashboard as a per-person switch (lead only by default), with a spike before building it.
- Auto mode for commands is off by default and never replaces the guard's always-refused list; trial thresholds as written in section 12.
- A read-only GitHub command preset, also available to the lead, for looking up a story by number.

## Left to the builder

- Staff names and looks for the default software team; exact wording of the instruction templates.
- Id format for jobs; local API route names; how the board groups and draws jobs.
- How the office runs `test:` / `setup:` across Windows and Linux within the "plain Node" rule.
- How a staff's follow-up is queued when that staff is busy with another task.
