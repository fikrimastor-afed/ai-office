// Spike: do installed skills work in non-interactive (dashboard-style) Claude Code runs?
// Usage: node spike/skills-spike.js   (needs a logged-in Claude Code with at least one skill; costs a few Haiku runs)
const { spawn, spawnSync } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const G = require('../lib/generate'), D = require('../lib/defaults'), { resolveClaude, chatEnv } = require('../lib/chat');
const { cmd, pre } = resolveClaude();
const v = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true });
if (v.error || v.status !== 0) { console.log('claude is not installed or not on PATH'); process.exit(2); }
console.log('claude version:', v.stdout.trim());
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-spike-')), 'office');
G.writeOffice(dir, G.buildConfig({ company: 'Spike Co', pa: 'Hana', staff: D.STAFF.slice(0, 1).map(({ name, role, job }) => ({ name, role, job })) }));
const BASE = 'Read,Write,Edit,Glob,Grep', WITH = BASE + ',Skill';
const NOTE = 'You work inside the office folder only.';
function run(label, tools, prompt, { resume, strict } = {}) {
  return new Promise((res) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--model', 'haiku',
      '--tools', tools, '--allowedTools', tools, '--append-system-prompt', NOTE, ...(strict ? ['--strict-mcp-config'] : []), ...(resume ? ['--resume', resume] : [])];
    const r = { label, init: null, skillCalls: [], text: '', result: null, timedOut: false, code: null, stderr: '' };
    const ch = spawn(cmd, [...pre, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: chatEnv(dir, 'pa') });
    const timer = setTimeout(() => { r.timedOut = true; ch.kill(); }, 180000);
    let buf = '';
    ch.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === 'system' && j.subtype === 'init') r.init = j;
      if (j.type === 'assistant') for (const c of (j.message && j.message.content) || []) { if (c.type === 'tool_use' && c.name === 'Skill') r.skillCalls.push(c.input); if (c.type === 'text') r.text += c.text; }
      if (j.type === 'result') r.result = j; } });
    ch.stderr.on('data', (d) => r.stderr += d);
    ch.on('error', (e) => { r.stderr += e.message; clearTimeout(timer); res(r); });
    ch.on('close', (code) => { clearTimeout(timer); r.code = code; res(r); });
  });
}
const u = (r) => (r.result && r.result.usage) || {};
const inTok = (r) => (u(r).input_tokens || 0) + (u(r).cache_creation_input_tokens || 0);
function show(r) {
  const i = r.init || {};
  console.log(`\n== ${r.label} == code ${r.code}${r.timedOut ? ' TIMED OUT (180s)' : ''}${r.stderr ? ' stderr: ' + r.stderr.slice(0, 160) : ''}`);
  console.log('init keys:', Object.keys(i).join(', '));
  console.log('tools:', (i.tools || []).length, 'total; non-MCP:', JSON.stringify((i.tools || []).filter((t) => !t.startsWith('mcp__'))));
  const sk = i.skills || [];
  console.log('skills:', sk.length, '(namespaced plugin:', sk.filter((x) => x.includes(':')).length, ', plain:', sk.filter((x) => !x.includes(':')).length, ') plain ones:', JSON.stringify(sk.filter((x) => !x.includes(':'))), '\nplugins:', JSON.stringify((i.plugins || []).map((p) => p.name)));
  const x = u(r);
  console.log('usage:', JSON.stringify({ in: x.input_tokens, cache_create: x.cache_creation_input_tokens, cache_read: x.cache_read_input_tokens, out: x.output_tokens }), 'cost:', r.result && r.result.total_cost_usd, 'denials:', JSON.stringify(r.result && r.result.permission_denials));
  console.log('skill calls:', JSON.stringify(r.skillCalls), '\nreply:', (r.result && r.result.result || r.text || '').slice(0, 400).replace(/\n/g, ' | '));
}
(async () => {
try {
  const ready = 'Reply with the single word: ready';
  const A = await run('A baseline', BASE, ready);
  if (!A.init) { console.log('claude did not start a session (not logged in?):', A.stderr.slice(0, 200) || 'timeout'); process.exitCode = 2; return; }
  const As = await run('A2 baseline + --strict-mcp-config', BASE, ready, { strict: true });
  const B = await run('B Skill tool', WITH, ready);
  const Bs = await run('B2 Skill tool + --strict-mcp-config', WITH, ready, { strict: true });
  const C = await run('C use one', WITH, 'List the names of the skills you can use, one per line. Then use one of them that looks harmless and tell me its name.');
  const D1 = await run('D1 skill that asks questions', WITH, 'Use a skill that asks me questions before acting, if you have one, and ask your first question. If you have none, say NONE.');
  const D2 = D1.result && D1.result.session_id ? await run('D2 resumed', WITH, 'My answer: a small to-do list app. Go on.', { resume: D1.result.session_id }) : { label: 'D2 resumed', skipped: true, result: null, skillCalls: [] };
  const all = [A, As, B, Bs, C, D1, D2];
  all.forEach((r) => r.skipped ? console.log('\n== D2 == skipped, no session id') : show(r));
  console.log('\n| Run | in | cache-create | cache-read | out | cost | skills listed | Skill tool in init | Skill calls |\n|---|---|---|---|---|---|---|---|---|');
  for (const r of all) { const x = u(r), i = r.init || {}; console.log(`| ${r.label} | ${x.input_tokens} | ${x.cache_creation_input_tokens} | ${x.cache_read_input_tokens} | ${x.output_tokens} | ${r.result && r.result.total_cost_usd} | ${(i.skills || []).length} | ${(i.tools || []).includes('Skill')} | ${r.skillCalls.length} |`); }
  console.log(`\nB minus A, input + cache-creation: ${inTok(B) - inTok(A)}; B2 minus A2 (both strict): ${inTok(Bs) - inTok(As)}`);
  console.log('total cost:', all.reduce((s, r) => s + ((r.result && r.result.total_cost_usd) || 0), 0));
} finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
})();
