// Add-on registry tests: Invois unchanged, role matching, GitHub / Figma / Context7 access, ask-first guard. Run: node test/addons.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/generate');
const D = require('../lib/defaults');
const T = require('../lib/templates');
const { decideAction, ASK_FIRST } = require('../office-files/guard');
const { build, roles } = require('./addon-fixture');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const ROLES = { sa: 'Solution Architect', sse: 'Senior Software Engineer', se: 'Software Engineer', qa: 'QA Tester', ux: 'UI/UX Designer' };
const people = Object.entries(ROLES).map(([k, role]) => ({ name: k.toUpperCase(), role, job: 'Does the work' }));
const office = (addons, extra) => G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: people, addons, ...extra });
const ids = (cfg, id) => cfg.addons[id].staff;
const names = (list, server) => list.filter((t) => t.startsWith(`mcp__${server}__`)).map((t) => t.split('__').pop());

test('invois output is unchanged (config, allow lists, actions, mcp, staff and agent files)', () => {
  const before = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'invois-baseline.json'), 'utf8'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(build())), before);
  assert.ok(roles.length >= 9);
});

test('old office.json shape still works: addons["invois-online"] only', () => {
  const cfg = { staff: [{ id: 'a', name: 'A', role: 'Sales', job: 'x' }], addons: { 'invois-online': { enabled: true } } };
  assert.ok(T.addonAllowed(cfg, 'a').includes('mcp__invois-online__create_quotation'));
  assert.deepStrictEqual(T.addonAllowed({ ...cfg, addons: {} }, 'a'), []);
  assert.deepStrictEqual(T.addonAllowed({ ...cfg, addons: { 'invois-online': { enabled: false } } }, 'a'), []);
});

test('add-ons are opt-in: nothing is on by default', () => {
  assert.deepStrictEqual(office([]).addons, {});
  assert.deepStrictEqual(Object.keys(office(['github']).addons), ['github']);
  assert.deepStrictEqual(Object.keys(G.buildConfig({ company: 'x', staff: people, invois: true }).addons), ['invois-online'], 'old invois flag');
  assert.strictEqual(office(['github']).addons.github.url, 'https://api.githubcopilot.com/mcp/readonly');
  assert.deepStrictEqual(Object.keys(office(['invois-online', 'github', 'figma', 'context7']).addons), D.ADDONS.map((a) => a.id));
});

test('role match: "Senior Software Engineer" is the senior block, never the engineer block, in any block order', () => {
  for (const a of [D.GITHUB, D.FIGMA]) {
    const sse = a.roles.filter((r) => r.match.test(ROLES.sse));
    assert.strictEqual(sse.length, 1, `${a.id}: exactly one block matches a senior`);
    assert.ok(/senior/.test(sse[0].match.source), `${a.id}: the senior block`);
    assert.strictEqual(a.roles.filter((r) => r.match.test(ROLES.se)).length, 1, `${a.id}: exactly one block matches an engineer`);
    for (const role of Object.values(ROLES)) {
      const hits = a.roles.filter((r) => r.match.test(role));
      assert.ok(hits.length <= 1, `${a.id}: ${role} matches ${hits.length} blocks`);
      const rev = { ...a, roles: [...a.roles].reverse() };
      assert.strictEqual(D.addonRole(rev, role), D.addonRole(a, role), `${a.id}: ${role} does not depend on order`);
    }
  }
  assert.strictEqual(D.addonRole(D.GITHUB, 'Senior Software Engineer'), D.GITHUB.roles[0]);
  assert.strictEqual(D.addonRole(D.GITHUB, 'Software Engineer'), D.GITHUB.roles[1]);
  assert.strictEqual(D.addonRole(D.GITHUB, 'UI/UX Designer'), null);
  assert.strictEqual(D.addonRole(D.FIGMA, 'QA Tester'), null);
});

test('role match: "Senior QA Engineer" is QA, not senior SE; "Senior Developer" is senior SE', () => {
  assert.strictEqual(D.GITHUB.roles[0].match.test('Senior QA Engineer'), false);
  assert.strictEqual(D.addonRole(D.GITHUB, 'Senior QA Engineer'), D.GITHUB.roles[2], 'qa block');
  assert.strictEqual(D.addonRole(D.GITHUB, 'Senior Developer'), D.GITHUB.roles[0], 'senior block');
  assert.strictEqual(D.addonRole(D.GITHUB, 'Senior Software Engineer'), D.GITHUB.roles[0], 'senior block');
  assert.strictEqual(D.addonRole(D.FIGMA, 'Senior Developer'), D.addonRole(D.FIGMA, 'Senior Software Engineer'));
  assert.ok(D.addonRole(D.FIGMA, 'Senior Developer'), 'figma senior block');
});

test('github: engineers, architect and QA get read tools; designer gets none; both server names', () => {
  const cfg = office(['github']);
  assert.deepStrictEqual(ids(cfg, 'github'), ['sa', 'sse', 'se', 'qa']);
  for (const who of ['sa', 'sse', 'se', 'qa']) {
    const allowed = T.addonAllowed(cfg, who);
    for (const server of ['github', 'claude_ai_GitHub']) {
      assert.deepStrictEqual(names(allowed, server).filter((t) => !['authenticate', 'complete_authentication', 'ping'].includes(t)).sort(), [...D.GITHUB.paTools].sort(), `${who} ${server}`);
    }
    assert.ok(!allowed.some((t) => /merge_pull_request|push_files|delete_|create_or_update_file|actions_run_trigger|issue_write/.test(t)), `${who}: no write tools`);
  }
  assert.deepStrictEqual(T.addonAllowed(cfg, 'ux'), []);
  assert.match(T.agentMd(cfg, cfg.staff.find((s) => s.id === 'sse')), /mcp__github__get_file_contents/);
  assert.doesNotMatch(T.agentMd(cfg, cfg.staff.find((s) => s.id === 'ux')), /github/);
  assert.doesNotMatch(T.agentMd(cfg, cfg.staff.find((s) => s.id === 'sse')), /merge_pull_request/);
  assert.doesNotMatch(T.staffClaude(cfg, cfg.staff.find((s) => s.id === 'ux')), /GitHub/);
  assert.match(T.staffClaude(cfg, cfg.staff.find((s) => s.id === 'se')), /- GitHub \(code, issues and pull requests \(read only\)\): `get_file_contents`/);
  assert.ok(T.addonAllowed(cfg, 'pa').includes('mcp__github__list_issues'));
});

test('github: merge, push, delete, workflow run are ask-first for the right staff', () => {
  const cfg = office(['github']);
  for (const who of ['sa', 'sse', 'se', 'qa']) {
    const acts = T.addonActions(cfg, who);
    for (const t of ['merge_pull_request', 'push_files', 'delete_file', 'delete_repository', 'actions_run_trigger']) {
      assert.ok(acts.includes(`mcp__github__${t}`) && acts.includes(`mcp__claude_ai_GitHub__${t}`), `${who} ${t}`);
    }
  }
  assert.deepStrictEqual(T.addonActions(cfg, 'ux'), []);
  assert.deepStrictEqual(T.addonActions(cfg, 'pa'), []);
});

test('figma: designer reads and writes (every write tool ask-first); engineers and architect read only; QA none', () => {
  const cfg = office(['figma']);
  assert.deepStrictEqual(ids(cfg, 'figma'), ['sa', 'sse', 'se', 'ux']);
  const ux = T.addonAllowed(cfg, 'ux');
  assert.ok(ux.includes('mcp__figma__get_design_context') && ux.includes('mcp__claude_ai_Figma__get_screenshot'));
  for (const t of ['use_figma', 'generate_figma_design', 'send_code_to_figma']) assert.ok(!ux.includes(`mcp__figma__${t}`) && !ux.includes(`mcp__claude_ai_Figma__${t}`), `${t} needs the boss`);
  assert.match(T.agentMd(cfg, cfg.staff.find((s) => s.id === 'ux')), /mcp__figma__use_figma.*mcp__figma__generate_figma_design|mcp__figma__generate_figma_design/);
  for (const who of ['sa', 'sse', 'se']) {
    const a = T.addonAllowed(cfg, who);
    assert.ok(a.includes('mcp__figma__get_design_context'), who);
    assert.ok(!a.some((t) => /generate_figma_design|use_figma|send_code_to_figma/.test(t)), `${who}: read only`);
  }
  assert.deepStrictEqual(T.addonAllowed(cfg, 'qa'), []);
  for (const who of ['ux', 'sse']) assert.ok(T.addonActions(cfg, who).includes('mcp__figma__use_figma'), who);
  assert.ok(T.addonActions(cfg, 'ux').includes('mcp__claude_ai_Figma__send_code_to_figma'));
  const uxMd = T.staffClaude(cfg, cfg.staff.find((s) => s.id === 'ux'));
  assert.match(uxMd, /Before `use_figma` or `send_code_to_figma`|Before `use_figma`/);
});

test('context7: read only for all five roles, both names, nothing to ask', () => {
  const cfg = office(['context7']);
  assert.deepStrictEqual(ids(cfg, 'context7'), ['sa', 'sse', 'se', 'qa', 'ux']);
  for (const who of Object.keys(ROLES)) {
    const a = T.addonAllowed(cfg, who);
    for (const server of ['context7', 'claude_ai_Context7']) assert.ok(a.includes(`mcp__${server}__query-docs`) && a.includes(`mcp__${server}__resolve-library-id`), `${who} ${server}`);
    assert.deepStrictEqual(T.addonActions(cfg, who), []);
    assert.doesNotMatch(T.staffClaude(cfg, cfg.staff.find((s) => s.id === who)), /Before `/);
  }
});

test('several add-ons add up; one that is off adds nothing', () => {
  const cfg = office(['github', 'figma', 'context7']);
  const ux = T.addonAllowed(cfg, 'ux');
  assert.ok(ux.includes('mcp__figma__get_metadata') && ux.includes('mcp__context7__query-docs') && !ux.some((t) => t.startsWith('mcp__github__')));
  cfg.addons.figma.enabled = false;
  assert.ok(!T.addonAllowed(cfg, 'ux').some((t) => t.startsWith('mcp__figma__')));
  assert.deepStrictEqual(T.enabledAddons(cfg).map((a) => a.id), ['github', 'context7']);
});

test('mcpRun: claude.ai connectors stay off only when every add-on the person uses is local', () => {
  const cfg = office(['github', 'context7']);
  const only = (...ok) => (id) => ok.includes(id);
  assert.deepStrictEqual(T.mcpRun(cfg, 'se', only('github', 'context7')).env, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  assert.deepStrictEqual(T.mcpRun(cfg, 'se', only('github')).env, {});
  assert.deepStrictEqual(T.mcpRun(cfg, 'ux', only('context7')).env, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, 'designer has no GitHub');
  assert.deepStrictEqual(T.mcpRun(cfg, 'se', true).env, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
});

test('guard: new write tools need the boss, under either server name; reads do not', () => {
  const cfg = { ...office(['github', 'figma', 'context7']), dir: '/home/ali/office' };
  const ask = (tool, grants = [], input = { x: 1 }) => decideAction({ tool_name: tool, tool_input: input, cwd: '/home/ali/office/staff/se' }, cfg, grants, { chat: true, win: false });
  for (const tool of ['mcp__github__merge_pull_request', 'mcp__claude_ai_GitHub__push_files', 'mcp__github__delete_repository', 'mcp__github__actions_run_trigger',
    'mcp__figma__use_figma', 'mcp__claude_ai_Figma__use_figma', 'mcp__figma__send_code_to_figma', 'mcp__figma__generate_figma_design']) {
    assert.strictEqual(ask(tool).decision, 'deny', tool);
    const short = tool.split('__').pop();
    assert.strictEqual(ask(tool, [{ id: 'g1', from: 'se', tool: short, input: { x: 1 } }]).decision, 'allow', `${tool} with the boss's OK`);
  }
  for (const tool of ['mcp__github__get_file_contents', 'mcp__figma__get_design_context', 'mcp__context7__query-docs', 'mcp__claude_ai_Context7__resolve-library-id']) assert.strictEqual(ask(tool), null, tool);
  cfg.addons.github.always = ['merge_pull_request'];
  assert.strictEqual(ask('mcp__github__merge_pull_request').decision, 'allow', 'Always allow per add-on');
  assert.strictEqual(ask('mcp__github__push_files').decision, 'deny');
});

test('guard ask-first list lands in the dashboard action list for enabled add-ons only', () => {
  const O = require('../lib/office');
  const fs2 = require('fs'), os = require('os');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'ai-office-addons-'));
  G.writeOffice(dir, office(['github']));
  const acts = O.listActions(dir);
  assert.ok(acts.length && acts.every((a) => a.addon === 'github'));
  assert.ok(acts.some((a) => a.tool === 'merge_pull_request'));
  assert.ok(ASK_FIRST['mcp__github__merge_pull_request']);
});

test('no em or en dashes in new add-on text', () => {
  for (const a of D.ADDONS) assert.doesNotMatch(JSON.stringify([a.name, a.ask, ...a.roles.map((r) => r.what)]), /[–—]/, a.id);
});

console.log(`\n${n} add-on tests passed`);
