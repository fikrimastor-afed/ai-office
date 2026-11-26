// Tokless MCP: the PA and staff flagged `tokless` run with only codegraph + context-mode (strict config,
// their tools allowed). Everyone else keeps --strict-mcp-config alone. The add-on path is unchanged.
const assert = require('assert');
const T = require('../lib/templates');
const D = require('../lib/defaults');
const G = require('../lib/generate');

const cfg = G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 3).map(({ name, role, job }) => ({ name, role, job })) });
const [flagged, plain] = cfg.staff.map((s) => s.id);
cfg.staff[0].tokless = true;
const SERVERS = {
  codegraph: { type: 'stdio', command: '/bin/codegraph', args: ['serve', '--mcp'] },
  'context-mode': { type: 'stdio', command: '/bin/tokless', args: ['run-mcp', '--context-mode'] },
};
const cfgJson = (args) => JSON.parse(args[args.indexOf('--mcp-config') + 1]);

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

test('pa gets only codegraph and context-mode, strict, and their tools allowed', () => {
  const r = T.mcpRun(cfg, 'pa', false, SERVERS);
  assert.deepStrictEqual(Object.keys(cfgJson(r.args).mcpServers), ['codegraph', 'context-mode']);
  assert.strictEqual(cfgJson(r.args).mcpServers.codegraph.command, '/bin/codegraph');
  assert.ok(r.args.includes('--strict-mcp-config'));
  assert.deepStrictEqual(T.toklessAllowed(cfg, 'pa'), T.TOKLESS_TOOLS);
});

test('a flagged staff gets the same tokless set', () => {
  const r = T.mcpRun(cfg, flagged, false, SERVERS);
  assert.deepStrictEqual(Object.keys(cfgJson(r.args).mcpServers), ['codegraph', 'context-mode']);
  assert.ok(r.args.includes('--strict-mcp-config'));
  assert.deepStrictEqual(T.toklessAllowed(cfg, flagged), T.TOKLESS_TOOLS);
});

test('an unflagged staff keeps plain --strict-mcp-config and no allowed MCP tools', () => {
  const r = T.mcpRun(cfg, plain, false, SERVERS);
  assert.deepStrictEqual(r.args, ['--strict-mcp-config']);
  assert.deepStrictEqual(T.toklessAllowed(cfg, plain), []);
});

test('no tokless servers found in Claude Code config: falls back to no MCP at all', () => {
  assert.deepStrictEqual(T.mcpRun(cfg, 'pa', false, {}).args, ['--strict-mcp-config']);
});

test('invois add-on run is unchanged (no tokless config, user servers as before)', () => {
  const withAddon = { ...cfg, addons: { 'invois-online': { enabled: true } } };
  assert.deepStrictEqual(T.mcpRun(withAddon, 'pa', true, SERVERS), { args: [], env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } });
});

test('agent file of a flagged staff lists the tokless tools; plain staff does not', () => {
  const tools = (md) => md.match(/^tools: (.*)$/m)[1].split(', ');
  const on = tools(T.agentMd(cfg, cfg.staff[0]));
  T.TOKLESS_AGENT_TOOLS.forEach((t) => assert.ok(on.includes(t), `missing ${t}`));
  const off = tools(T.agentMd(cfg, cfg.staff[1]));
  T.TOKLESS_AGENT_TOOLS.forEach((t) => assert.ok(!off.includes(t), `unexpected ${t}`));
});

console.log(`all ${n} tokless tests passed`);
