Decision: do not build it (rule failed: skills add 10,980 tokens to every run, the limit is 5,000)

# Skills spike: do installed skills work in dashboard runs?

Date: 2026-11-28. Claude Code 2.1.332, Node, Linux. Model for every run: Haiku. Script: `spike/skills-spike.js`
(scratch office in the temp folder, flags shaped like `lib/chat.js`: `-p`, `--output-format stream-json --verbose`,
`--permission-mode default`, `--tools` and `--allowedTools` with the same list, `--append-system-prompt`, `stdio: ['ignore','pipe','pipe']`).
Run twice while developing (7 runs the second time; the first time had no A2). The numbers below are from the second run.
Cost of all runs, both times: about $0.058 (first run $0.0325, second $0.0250).

## Results

Tokens are as the `result` event reports them: input / cache-creation / cache-read / output.

| Run | Flags | in / cache-create / cache-read / out | Prompt total (in + create + read) | Cost | Skills in init | `Skill` tool in init | `Skill` calls |
|---|---|---|---|---|---|---|---|
| A baseline | tools Read,Write,Edit,Glob,Grep | 2 / 5857 / 17921 / 73 | 23,780 | $0.0014 | 96 | no | 0 |
| A2 baseline, strict | A + `--strict-mcp-config` | 2 / 5151 / 3816 / 111 | 8,969 | $0.0011 | 96 | no | 0 |
| B Skill tool | A + `Skill` in both lists | 2 / 16157 / 18601 / 116 | 34,760 | $0.0035 | 96 | yes | 0 |
| B2 Skill tool, strict | B + `--strict-mcp-config` | 2 / 13836 / 6111 / 4 | 19,949 | $0.0028 | 96 | yes | 0 |
| C use one | B, "list skills and use a harmless one" | 4 / 17913 / 53383 / 1775 | 71,300 | $0.0050 | 96 | yes | 1: `superpowers:using-superpowers`, not denied |
| D1 | B, "use a skill that asks questions" | 4 / 21349 / 53386 / 718 | 74,739 | $0.0052 | 96 | yes | 1: `superpowers:brainstorming`, not denied |
| D2 | D1 + `--resume` | 2 / 473 / 39950 / 741 | 40,425 | $0.0060 | 96 | yes | 0 |

- `init` event keys: type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, terminal_slash_commands, apiKeySource, claude_code_version, output_style, agents, skills, plugins, capabilities, and some feature flags. `skills` is a list of names; `plugins` lists plugin names and paths.
- Skills listed (all runs, even A where the `Skill` tool is off): 96. 73 are plugin skills (named `plugin:skill`, from 15 plugins such as superpowers, obsidian, docker-skills). 23 have no prefix: built-in ones (`verify`, `debug`, `loop`, ...) and the office's own `add-approval-rule`, `add-staff-tool`, ... The init event does not say if an unprefixed skill is personal or built-in, so "personal skills load" is not shown here (`~/.claude/skills` holds only `session-start-hook` and `synced/`; `session-start-hook` is listed).
- Permissions: no denials in any run (`permission_denials` empty). Skill calls ran with `--permission-mode default` and the `Skill` entry in `--allowedTools`.
- Stderr in every run: `Ignoring 2 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.` This is the untrusted scratch office; a real office would be trusted by the user's first interactive run. It does not change the skill results.

## Decision, by the brief's rules

1. B's `init` shows the `Skill` tool and installed skills: PASS (tool present, 96 skills).
2. C makes a `Skill` call that is not denied: PASS (`superpowers:using-superpowers`).
3. D's second turn carries on: PASS. D1 picked `superpowers:brainstorming` (not NONE) and asked a first question. D2, resumed, made no new `Skill` call but kept the skill's style: it said "Before I sketch any design, I need to know why you want it" and asked who the app is for. The earlier turn stays in the resumed context.
4. Skills add no more than 5,000 tokens per run (B minus A): FAIL. By the brief's measure (input + cache-creation): 16,159 - 5,859 = 10,300. That measure moves with the cache, so the stable one is the prompt total including cache-read: 34,760 - 23,780 = 10,980. Both strict runs: 19,949 - 8,969 = 10,980. The first script run gave the same total difference (34,760 - 23,780). So adding the `Skill` tool puts about 11,000 tokens into every run (the list of all 96 skill names and descriptions), more than twice the limit.

Not a pass, so: do not build it.

Caveat, for the owner: this machine has an unusually large skill set (96, mostly from 15 plugins). A user with a handful of skills would add far less than 11,000, and the cost is mostly the list size. The rule as written is about this measurement, so it is applied as written. What would change the decision: the same script on a typical user's machine (a few skills) showing 5,000 or less, or a way to give a run only a few named skills (not found: no flag was tried that limits the list; `skills` was 96 in every run whatever the tools).

## For Task 7 (if it is ever built)

- Flag spelling that worked: add `Skill` to both `--tools` and `--allowedTools` (`--tools Read,Write,Edit,Glob,Grep,Skill --allowedTools <same>`). Without `Skill` in `--tools` the init tool list has no `Skill`, but the `skills` list still shows 96 names.
- `--strict-mcp-config` (used by dashboard runs with no add-ons) does NOT change the result: `Skill` is still in `tools`, still 96 skills, and the prompt cost of skills is the same 10,980. It does shrink the whole run (A 23,780 to A2 8,969), because MCP tool lists from other plugins stay out; that is a separate saving.
- Plugin skills load (73 namespaced ones, and two were called: `superpowers:using-superpowers`, `superpowers:brainstorming`). Personal skills: not separable from built-in ones in the init event.
- The model chose its own skill in both C and D1; no argument was needed beyond what it wrote itself.
- `--resume` keeps the skill's behaviour for the next turn, but the `Skill` tool and its list are sent again, so the ~11,000 tokens are paid again each turn (mostly as cache-read after the first).
