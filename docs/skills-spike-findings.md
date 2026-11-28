Decision: do not build it (rule failed: by the brief's measure, input + cache-creation, skills add 10,300 tokens to a run; the limit is 5,000)

# Skills spike: do installed skills work in dashboard runs?

Date: 2026-11-28. Claude Code 2.1.332, Node, Linux. Model for every run: Haiku. Script: `spike/skills-spike.js`
(scratch office in the temp folder, flags shaped like `lib/chat.js`: `-p`, `--output-format stream-json --verbose`,
`--permission-mode default`, `--tools` and `--allowedTools` with the same list, `--append-system-prompt`, `stdio: ['ignore','pipe','pipe']`).
The script was run twice while developing (the second run added A2). The numbers below are from the second run.
Cost of all runs, both times: about $0.058 (first run $0.0325, second $0.0250).

## Results

Tokens are as the `result` event reports them: input / cache-creation / cache-read / output. Each run is one sample.

| Run | Flags | in / cache-create / cache-read / out | in + cache-create | Prompt total (in + create + read) | Cost | Skills in init | `Skill` tool in init | `Skill` calls |
|---|---|---|---|---|---|---|---|---|
| A baseline | tools Read,Write,Edit,Glob,Grep | 2 / 5857 / 17921 / 73 | 5,859 | 23,780 | $0.0014 | 96 | no | 0 |
| A2 baseline, strict | A + `--strict-mcp-config` | 2 / 5151 / 3816 / 111 | 5,153 | 8,969 | $0.0011 | 96 | no | 0 |
| B Skill tool | A + `Skill` in both lists | 2 / 16157 / 18601 / 116 | 16,159 | 34,760 | $0.0035 | 96 | yes | 0 |
| B2 Skill tool, strict | B + `--strict-mcp-config` | 2 / 13836 / 6111 / 4 | 13,838 | 19,949 | $0.0028 | 96 | yes | 0 |
| C use one | B, "list skills and use a harmless one" | 4 / 17913 / 53383 / 1775 | 17,917 | 71,300 | $0.0050 | 96 | yes | 1: a plugin skill, not denied |
| D1 | B, "use a skill that asks questions" | 4 / 21349 / 53386 / 718 | 21,353 | 74,739 | $0.0052 | 96 | yes | 1: a plugin skill, not denied |
| D2 | D1 + `--resume` | 2 / 473 / 39950 / 741 | 475 | 40,425 | $0.0060 | 96 | yes | 0 |

- `init` event keys: type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, terminal_slash_commands, apiKeySource, claude_code_version, output_style, agents, skills, plugins, capabilities, and some feature flags. `skills` is a list of names; `plugins` lists plugin names and paths.
- Skills listed (all runs, even A where the `Skill` tool is off): 96. 73 are plugin skills (named `plugin:skill`, from 15 plugins). 23 have no prefix: built-in ones and the office's own `add-approval-rule`, `add-staff-tool`, and so on. The init event does not say whether an unprefixed skill is personal or built-in, so "personal skills load" is not shown.
- Permissions: no denials in any run (`permission_denials` empty). Skill calls ran with `--permission-mode default` and `Skill` in `--allowedTools`.
- Stderr in every run: `Ignoring 2 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.` Every run was in an untrusted scratch office, where the office's `permissions.allow` entries were ignored. The effect of an untrusted workspace on skill loading and on permissions was not tested, so these results may differ in a trusted office.
- Cost column: it does not rise in step with tokens (D2 costs more than D1 although it has fewer prompt tokens and similar output). Not investigated.
- Each run leaves a session transcript in the user's Claude Code project history for the temp folder (the script removes the folder, not the transcripts).

## Decision, by the brief's rules

1. B's `init` shows the `Skill` tool and installed skills: PASS (tool present, 96 skills).
2. C makes a `Skill` call that is not denied: PASS (a plugin skill was called).
3. D's second turn carries on: PASS. D1 picked a plugin skill (not NONE) and asked a first question. D2, resumed, made no new `Skill` call but kept the skill's style: it said it needed to know why the user wants the app and asked who it is for.
4. Skills add no more than 5,000 tokens per run (B minus A): FAIL. By the brief's measure (input + cache-creation): 16,159 - 5,859 = 10,300. In the strict pair: 13,838 - 5,153 = 8,685. Both are above 5,000. That measure moves with the cache state, so the prompt total including cache-read was also computed: 34,760 - 23,780 = 10,980, and for the strict pair 19,949 - 8,969 = 10,980. The first script run gave the same 10,980. So adding the `Skill` tool to the lists came with about 10,000 to 11,000 more prompt tokens in this environment.

Not a pass, so: do not build it.

What the numbers do not show: where the extra tokens come from. A already lists 96 skills in `init` with no `Skill` tool, so the cost could be the `Skill` tool's definition, the skill listing, or something else. That the listing is the cause is a hypothesis. A hypothesis that follows from it: a machine with few skills would add less. What would change the decision: the same script on a machine with a few skills showing 5,000 or less, or a way to give a run only a few named skills (no flag was tried for that).

## Not measured

- How the cost scales with the number of installed skills.
- A machine with few skills (this one has 96).
- A trusted workspace.
- Variance: each run is one sample.
- What part of a resumed turn is skills.

## For Task 7 (if it is ever built)

- Flag spelling that worked: add `Skill` to both `--tools` and `--allowedTools` (`--tools Read,Write,Edit,Glob,Grep,Skill --allowedTools <same>`). Without `Skill` in `--tools` the init tool list has no `Skill`, but the `skills` list still shows 96 names.
- `--strict-mcp-config` (used by dashboard runs with no add-ons) did not change the result: `Skill` still in `tools`, still 96 skills, and the same 10,980 prompt-total difference (8,685 by the brief's measure). It also came with a much smaller whole run (A 23,780 to A2 8,969). The likely reason is that tool lists from other MCP servers stay out, but the cache-read column differs between those runs, so that cause is not proven.
- Plugin skills load: 73 namespaced ones were listed and two were called. Personal skills: not separable from built-in ones in the init event.
- The model chose its own skill in both C and D1; no argument was needed beyond what it wrote itself.
- `--resume` kept the skill's behaviour for the next turn. Whether the skill cost is paid again on a resumed turn, and how much of it as cache-read, was not measured: D2 shows only its total (40,425, mostly cache-read).
