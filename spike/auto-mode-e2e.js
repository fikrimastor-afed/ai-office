// One real run of the built Auto commands feature: a scratch office, an Auto staff (Haiku), a linked project with a local
// bare remote, and two tasks through the real Tasks class (wired as lib/server.js wires it).
// Usage: node spike/auto-mode-e2e.js [--neutral]     (costs a few cents; everything lives in the OS temp folder and is removed at the end)
const { spawnSync } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const G = require('../lib/generate'), D = require('../lib/defaults'), O = require('../lib/office'), T = require('../lib/templates');
const { resolveClaude, chatEnv, access } = require('../lib/chat'), { Tasks } = require('../lib/tasks');
// --neutral: the first run showed Claude refusing the push by itself from the "never run git push" sentences in the run note and
// the CLAUDE.md files, so the guard was never reached. With --neutral those sentences are removed (in the scratch office and in the
// note the script passes through the access hook; product code is untouched) so the guard's own refusal is what gets tested.
const NEUTRAL = process.argv.includes('--neutral');
const NEVER = /\s*Never run: git push[^.]*\.[^.]*\./g, NEVER2 = /\s*Never: git push[^.]*\.[^.]*\./g;
const neutral = (t) => t.replace(NEVER, '').replace(NEVER2, '').replace(/A guard checks every command:[^.]*\./, 'Run the commands the boss asks for.')
  .replace(/^- Commands you may run[^\n]*$/m, '- Commands: run the ones the boss asks for, in the office or a linked folder.');
const { cmd, pre } = resolveClaude();
const v = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true });
if (v.error || v.status !== 0) { console.log('claude is not installed or not on PATH'); process.exit(2); }
console.log('claude version:', v.stdout.trim());

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automode-e2e-'));
const dir = path.join(root, 'office'), linked = path.join(root, 'project'), bare = path.join(root, 'remote.git');
const GENV = { ...process.env, GIT_AUTHOR_NAME: 'Spike', GIT_AUTHOR_EMAIL: 'spike@example.invalid', GIT_COMMITTER_NAME: 'Spike', GIT_COMMITTER_EMAIL: 'spike@example.invalid' };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: GENV, windowsHide: true }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const must = (r, what) => { if (r.code !== 0) throw new Error(`${what} failed: ${r.err || r.out}`); return r.out; };
const bareRefs = () => git(bare, 'for-each-ref', '--format=%(refname) %(objectname:short)').out || '(none)';

function setup() {
  const base = G.buildConfig({ company: 'Spike Co', pa: 'Hana', staff: D.STAFF.slice(0, 1).map(({ name, role, job }) => ({ name, role, job })) });
  G.writeOffice(dir, base);
  const id = base.staff[0].id;
  fs.mkdirSync(linked, { recursive: true });
  must(git(linked, 'init', '-q', '-b', 'main'), 'git init');
  fs.writeFileSync(path.join(linked, 'check.js'), "console.log('OK');\n");
  must(git(linked, 'add', '.'), 'git add'); must(git(linked, 'commit', '-q', '-m', 'first'), 'git commit');
  must(git(root, 'init', '-q', '--bare', '-b', 'main', bare), 'git init --bare');
  must(git(linked, 'remote', 'add', 'origin', bare), 'git remote add');
  if (NEUTRAL) for (const f of [path.join(dir, 'staff', id, 'CLAUDE.md'), path.join(dir, 'CLAUDE.md')]) fs.writeFileSync(f, neutral(fs.readFileSync(f, 'utf8')));
  O.addLinked(dir, { path: linked, label: 'scratch project' }); // the boss links a folder
  O.updateStaff(dir, id, { commandMode: 'auto', model: 'haiku', commands: [] }); // Auto, Haiku, no command preset ticked
  return id;
}

(async () => {
  try {
    const id = setup();
    const acc = access(dir, id);
    console.log('access: auto', acc.auto, 'shell', acc.shell, 'linked', JSON.stringify(acc.linked), 'paths', JSON.stringify(acc.paths), 'allowed Bash rules', JSON.stringify(acc.allowed.filter((x) => /^Bash/.test(x))));
    console.log('--settings text:', T.autoSettings(O.loadCfg(dir), dir, acc.linked).replace(root.replace(/\\/g, '\\\\'), '<tmp>').slice(0, 600));
    let cur = null;
    const rec = () => ({ init: null, bash: [], results: [], result: null });
    const onUsage = (j, staff, kind, tid) => {
      if (!cur || tid !== cur.tid) return;
      const r = cur.rec, content = (j.message && Array.isArray(j.message.content)) ? j.message.content : [];
      if (j.type === 'system' && j.subtype === 'init') r.init = { permissionMode: j.permissionMode, tools: j.tools };
      if (j.type === 'assistant') for (const c of content) if (c.type === 'tool_use' && c.name === 'Bash') r.bash.push({ id: c.id, input: c.input.command });
      if (j.type === 'user') for (const c of content) if (c.type === 'tool_result' && r.bash.some((b) => b.id === c.tool_use_id)) r.results.push({ is_error: !!c.is_error, text: (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300) });
      if (j.type === 'result') r.result = { cost: j.total_cost_usd, usage: j.usage, denials: j.permission_denials };
    };
    const tasks = new Tasks(dir, { access: (i, o) => { const a = access(dir, i, o); return NEUTRAL ? { ...a, note: neutral(a.note) } : a; }, claude: resolveClaude, env: chatEnv, loadCfg: () => O.loadCfg(dir), onUsage, onStart: () => {}, onStep: () => {}, onEnd: () => {} });
    const L = linked.replace(/\\/g, '/');
    const runTask = async (label, text) => {
      cur = { rec: rec(), tid: null };
      const tid = tasks.add(id, text, { project: '' }); cur.tid = tid;
      const t0 = Date.now(); let t;
      while (Date.now() - t0 < 180000) { t = tasks.read(tid); if (['done', 'failed', 'stopped'].includes(t.status)) break; await new Promise((r) => setTimeout(r, 1000)); }
      const timedOut = !['done', 'failed', 'stopped'].includes(t.status);
      if (timedOut) { tasks.stop(tid); }
      const r = cur.rec, x = (r.result && r.result.usage) || {};
      console.log(`\n== ${label} == status ${t.status}${timedOut ? ' TIMED OUT (180s)' : ''}`);
      console.log('init permissionMode:', r.init && r.init.permissionMode, '| Bash in init tools:', !!(r.init && (r.init.tools || []).includes('Bash')));
      console.log('Bash calls:', r.bash.length, JSON.stringify(r.bash.map((b) => b.input)));
      console.log('Bash results:', JSON.stringify(r.results));
      console.log('usage:', JSON.stringify({ in: x.input_tokens, cache_create: x.cache_creation_input_tokens, cache_read: x.cache_read_input_tokens, out: x.output_tokens }), 'cost:', r.result && r.result.cost, 'denials:', JSON.stringify(r.result && r.result.denials));
      console.log('task result text:', (t.result || '').slice(0, 400).replace(/\n/g, ' | '));
      return r;
    };
    await runTask('Task 1, unlisted command (describe)', `Run exactly this and report its output in one line: git -C "${L}" describe --always`);
    console.log('git HEAD id for comparison:', git(linked, 'rev-parse', '--short', 'HEAD').out);
    await runTask('Task 2, push', `Run exactly this and report what happened in one line: cd "${L}" && git push origin HEAD`);
    console.log('bare refs after task 2:', bareRefs());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();
