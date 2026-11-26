// Command guard: who may run what, where. This is a safety boundary, so test it hard.
const assert = require('assert');
const { decide, decideAction, ASK_FIRST, PRESETS } = require('../office-files/guard');

delete process.env.AI_OFFICE_STAFF; // a run the office starts sets it; the tests pass their own env
const office = {
  dir: '/home/ali/office',
  linked: ['/home/ali/projects/8fix'],
  staff: [
    { id: 'shah', name: 'Shah', commands: ['git', 'laravel'], customCommands: ['php vendor/bin/pint'] },
    { id: 'siti', name: 'Siti' },
    { id: 'aina', name: 'Aina', docs: false },
    { id: 'ravi', name: 'Ravi', commands: ['go', 'python', 'docker_read', 'git_read', 'node'] },
    { id: 'kim', name: 'Kim', commands: ['python', 'docker_read'], customCommands: ['az', 'azure-foo', 'python -c', 'psql', 'docker compose down -v'] },
  ],
};
const run = (command, o = {}) => decide({ tool_name: 'Bash', tool_input: { command }, agent_type: o.agent ?? 'shah', cwd: o.cwd || office.dir }, office, { chat: o.chat ?? true, win: false, env: o.env || {} });
const allow = (c, o) => assert.strictEqual(run(c, o).decision, 'allow', `should allow: ${c} (${run(c, o).reason})`);
const deny = (c, o) => assert.strictEqual(run(c, o).decision, 'deny', `should deny: ${c}`);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

test('office documents: on by default, node only on a script saved in the office', () => {
  allow('node make-deck.cjs', { agent: 'siti', cwd: '/home/ali/office/staff/siti' });
  allow('node "/home/ali/office/projects/raya/make-deck.cjs"', { agent: 'siti' });
  allow('cd /home/ali/projects/8fix && node tools/chart.js', { agent: 'siti' });
  allow('node /home/ali/office/projects/raya/make.mjs', { agent: 'siti' });
  deny('node -e "require(\'fs\').rmSync(\'/\')"', { agent: 'siti' });
  deny('node --eval x', { agent: 'siti' });
  deny('node /home/ali/other/evil.cjs', { agent: 'siti' });
  deny('node ../../../tmp/x.cjs', { agent: 'siti', cwd: '/home/ali/office/staff/siti' });
  deny('node /home/ali/office/notes.txt', { agent: 'siti' });
  deny('node', { agent: 'siti' });
  deny('node make.cjs', { agent: 'aina', cwd: '/home/ali/office/staff/aina' }); // turned off
  assert.ok(PRESETS.docs && PRESETS.docs.allow.includes('node'));
});

test('allowed commands in a linked folder', () => {
  allow('git status');
  allow('cd /home/ali/projects/8fix && git add app/User.php && git commit -m "feat(auth): login fix"');
  allow("cd '/home/ali/projects/8fix' && php artisan make:model Order");
  allow('cd /home/ali/projects/8fix/app && php artisan route:list');
  allow('cd /home/ali/projects/8fix && php vendor/bin/pint');
});

test('real-life forms Claude writes: multi-line messages, git -C, 2>&1', () => {
  allow('cd "/home/ali/projects/8fix" && git add a.txt && git commit -m "via office\n\nCo-Authored-By: Claude <noreply@anthropic.com>"');
  allow("git commit -m 'fix: a; b | c > d'");
  allow('git commit -m "a && rm -rf / is only text here"'); // inside quotes: just a message
  allow('git -C "/home/ali/projects/8fix" add a.txt');
  allow('git -C /home/ali/projects/8fix status 2>&1');
  deny('git -C /home/ali/other status');
  deny('git -C /home/ali/projects/8fix push');
  deny('git commit -m "$(rm -rf /)"');
  deny('git commit -m "`rm x`"');
  deny('git commit -m "unclosed');
  deny('git status 2>&1 > out.txt');
});

test('folders outside the office and links are refused', () => {
  deny('cd /home/ali/other && git status');
  deny('cd /home/ali/projects/8fix-old && git status');
  deny('cd /home/ali/projects/8fix/../secret && git status');
  deny('cd ~ && git status');
});

test('always-blocked commands, even when the preset is ticked', () => {
  for (const c of ['git push origin main', 'cd /home/ali/projects/8fix && git push', 'git reset --hard HEAD~1', 'git clean -fd',
    'php artisan migrate:fresh --seed', 'php artisan db:wipe', 'php artisan tinker', 'rm -rf app', 'curl https://evil.example']) deny(c);
  assert.match(run('git push').reason, /never run from the dashboard/);
});

test('tricks to sneak a command in are refused', () => {
  for (const c of ['git status; rm -rf /', 'git status | sh', 'git log `rm x`', 'git log $(rm x)', 'git status > /etc/passwd',
    'git status & rm x', 'git status || rm x', 'git status\nrm x', 'cd /home/ali/projects/8fix && cd /etc && git status']) deny(c);
});

test('only ticked presets; other staff and the PA run nothing', () => {
  deny('npm install');
  deny('composer install');
  deny('git status', { agent: 'siti' });
  assert.match(run('git status', { agent: 'siti' }).reason, /not on Siti's allowed commands/);
  deny('git status', { agent: 'aina' });
  assert.match(run('git status', { agent: 'aina' }).reason, /no commands turned on/); // documents turned off: nothing
  deny('git status', { agent: '' });
  assert.match(run('git status', { agent: '' }).reason, /does not run commands/);
});

test('a direct chat in a staff folder counts as that staff', () => {
  allow('git status', { agent: '', cwd: '/home/ali/office/staff/shah' });
  deny('git status', { agent: '', cwd: '/home/ali/office/staff/siti' });
});

test('hook agent_type that is not a staff id (e.g. the boss default "orchestrator"): staff found by folder', () => {
  allow('git status', { agent: 'orchestrator', cwd: '/home/ali/office/staff/shah' });
  deny('git status', { agent: 'orchestrator', cwd: '/home/ali/office/staff/siti' });
  deny('git push', { agent: 'orchestrator', cwd: '/home/ali/office/staff/shah' }); // ALWAYS_DENY still wins
  deny('git status', { agent: 'orchestrator', cwd: office.dir });
  assert.match(run('git status', { agent: 'orchestrator', cwd: office.dir }).reason, /does not run commands/);
  deny('git status', { agent: 'unknown', cwd: '/home/ali/office/staff/siti' });
  allow('git status', { agent: 'unknown', cwd: '/home/ali/office/staff/shah' });
});

test('hook agent_type that is a staff id: that staff rules apply, whatever the cwd', () => {
  allow('git status', { agent: 'shah', cwd: office.dir });
  deny('git status', { agent: 'siti', cwd: office.dir });
});

test('AI_OFFICE_STAFF from the office: staff identity survives a cd into a linked folder', () => {
  const linked = '/home/ali/projects/8fix';
  const pinned = { agent: 'orchestrator', cwd: linked, env: { AI_OFFICE_STAFF: 'shah' } };
  deny('cd /home/ali/projects/8fix && git status', { agent: 'orchestrator', cwd: linked }); // no env: PA, no commands
  allow('cd /home/ali/projects/8fix && git status', pinned);
  deny('cd /home/ali/projects/8fix && git push', pinned); // ALWAYS_DENY still wins
  assert.match(run('cd /home/ali/projects/8fix && git push', pinned).reason, /never run from the dashboard/);
  deny('git status', { agent: 'orchestrator', cwd: office.dir, env: { AI_OFFICE_STAFF: 'siti' } }); // siti has no commands
  allow('git status', { agent: 'siti', cwd: office.dir, env: { AI_OFFICE_STAFF: 'shah' } }); // env beats agent_type
  allow('git status', { agent: 'shah', cwd: office.dir, env: { AI_OFFICE_STAFF: 'nobody' } }); // unknown env: ignored, agent_type wins
  deny('git status', { agent: 'orchestrator', cwd: office.dir, env: { AI_OFFICE_STAFF: 'pa' } });
  assert.match(run('git status', { agent: 'shah', cwd: '/home/ali/office/staff/shah', env: { AI_OFFICE_STAFF: 'pa' } }).reason, /does not run commands/);
});

test('AI_OFFICE_STAFF in decideAction: the staff OK matches the staff the office started', () => {
  const inp = { company_id: 1, quotation_id: 'QA000123' };
  const cfg = { ...office, addons: { 'invois-online': { enabled: true, always: [] } } };
  const r = decideAction({ tool_name: 'mcp__invois-online__send_quotation_email', tool_input: inp, agent_type: 'orchestrator', cwd: '/home/ali/projects/8fix' },
    cfg, [{ id: 'a2', from: 'siti', tool: 'send_quotation_email', input: inp }], { chat: true, win: false, env: { AI_OFFICE_STAFF: 'siti' } });
  assert.strictEqual(r.decision, 'allow'); assert.strictEqual(r.grant, 'a2');
  const other = decideAction({ tool_name: 'mcp__invois-online__send_quotation_email', tool_input: inp, agent_type: 'orchestrator', cwd: '/home/ali/projects/8fix' },
    cfg, [{ id: 'a2', from: 'siti', tool: 'send_quotation_email', input: inp }], { chat: true, win: false, env: { AI_OFFICE_STAFF: 'shah' } });
  assert.strictEqual(other.decision, 'deny', 'shah cannot use siti OK');
});

test('terminal: no opinion on what is not allowed, so Claude Code asks the boss', () => {
  assert.strictEqual(run('npm install', { chat: false }).decision, null);
  assert.strictEqual(run('git push', { chat: false }).decision, null);
  assert.strictEqual(run('git status', { chat: false }).decision, 'allow');
});

test('Windows paths (Git Bash /c/..., backslashes, quotes, WSL share)', () => {
  const w = { dir: 'C:\\Users\\Ali\\office', linked: ['C:\\Users\\Ali\\shop site', '\\\\wsl.localhost\\Ubuntu\\home\\ali\\8fix'], staff: office.staff };
  const r = (command) => decide({ tool_name: 'Bash', tool_input: { command }, agent_type: 'shah', cwd: w.dir }, w, { chat: true, win: true }).decision;
  assert.strictEqual(r('cd "/c/Users/Ali/shop site" && git status'), 'allow');
  assert.strictEqual(r('cd "C:\\Users\\Ali\\shop site" && git status'), 'allow');
  assert.strictEqual(r('cd //wsl.localhost/Ubuntu/home/ali/8fix && git status'), 'allow');
  assert.strictEqual(r('cd /c/Users/Ali/Documents && git status'), 'deny');
});

test('presets are what the Staff page offers', () => {
  assert.deepStrictEqual(Object.keys(PRESETS), ['git', 'laravel', 'node', 'composer', 'docs', 'go', 'python', 'docker_read', 'git_read']);
});

test('new presets: go, python, docker read-only, git read-only allow their commands only', () => {
  const r = { agent: 'ravi' };
  for (const c of ['go build ./...', 'go test ./... -race', 'go vet ./...', 'go mod download', 'go tool cover -html=c.out', 'gofmt -l .', 'golangci-lint run ./...']) allow(c, r);
  for (const c of ['go run main.go', 'go mod tidy', 'go generate ./...']) deny(c, r);
  for (const c of ['python -m pytest tests -q && ruff check src', 'python3 -m compileall app', '.venv/bin/pytest -x', '.venv/bin/python -m pytest',
    '.venv/bin/ruff check src', '.venv/bin/mypy src', 'make test', 'make lint', 'mypy src', 'pytest']) allow(c, r);
  for (const c of ['python script.py', 'python -c "import os"', 'python3 -c "x"', '.venv/bin/python -c "x"', 'pip install x', 'python -m http.server']) deny(c, r);
  for (const c of ['docker compose ps', 'docker compose logs -f api']) allow(c, r);
  for (const c of ['docker compose up -d', 'docker run alpine', 'docker compose down -v', 'docker push img', 'docker login', 'docker buildx build .',
    'docker volume rm x', 'docker system prune', 'docker compose config']) deny(c, r);
  for (const c of ['git status', 'git diff --stat', 'git log -5', 'git show HEAD', 'git remote -v', 'git rev-parse HEAD']) allow(c, r);
  for (const c of ['git add .', 'git checkout -b x', 'git commit -m "x"']) deny(c, r);
});

test('git_read: "git branch --show-current" only, no other branch commands', () => {
  const r = { agent: 'ravi' };
  allow('git branch --show-current', r);
  deny('git branch -D x', r); // ALWAYS_DENY
  deny('git branch newname', r);
});

test('always-blocked: new deny entries refuse even when a preset or custom command would allow', () => {
  // kim has these as custom commands (az, python -c, psql, docker compose down -v): the deny must still win
  for (const c of ['az login', 'python -c "x"', 'psql -c "select 1"', 'docker compose down -v']) deny(c, { agent: 'kim' });
  assert.match(run('az login', { agent: 'kim' }).reason, /never run from the dashboard/);
  for (const c of ['az account show', 'kubectl get pods', 'docker push img', 'docker login', 'docker buildx build .', 'docker volume rm x',
    'docker system prune -a', 'go install ./cmd/x', 'alembic downgrade -1']) deny(c, { agent: 'ravi' });
  allow('azure-foo --help', { agent: 'kim' }); // "az" is a word boundary, not a substring
  allow('python -m pytest tests -q', { agent: 'kim' });
});

test('NODE_OPTIONS: only the exact heap-size build line passes', () => {
  const r = { agent: 'ravi' };
  allow('NODE_OPTIONS=--max-old-space-size=8192 npm run build', r);
  deny('FOO=1 npm run build', r);
  deny('NODE_OPTIONS=--inspect npm run build', r);
  deny('NODE_OPTIONS=--max-old-space-size=8192 node make.cjs', r);
  deny('NODE_OPTIONS=--max-old-space-size=8192 rm -rf x', r);
});

test('ask-first: agent_type "orchestrator" in a staff folder matches that staff OK', () => {
  const inp = { company_id: 1, quotation_id: 'QA000123' };
  const cfg = { ...office, addons: { 'invois-online': { enabled: true, always: [] } } };
  const r = decideAction({ tool_name: 'mcp__invois-online__send_quotation_email', tool_input: inp, agent_type: 'orchestrator', cwd: '/home/ali/office/staff/siti' }, cfg, [{ id: 'a1', from: 'siti', tool: 'send_quotation_email', input: inp }], { chat: true, win: false });
  assert.strictEqual(r.decision, 'allow'); assert.strictEqual(r.grant, 'a1');
});

test('ask-first actions: only with an unused OK from the boss for that staff and that exact call', () => {
  const T = 'mcp__invois-online__send_quotation_email';
  const inp = { company_id: 1, quotation_id: 'QA000123' };
  const grant = (f) => ({ id: 'a1', from: 'siti', tool: 'send_quotation_email', input: inp, ...f });
  const ask = (grants, o = {}) => decideAction({ tool_name: T, tool_input: o.input || inp, cwd: o.cwd || '/home/ali/office/staff/siti' }, { ...office, addons: { 'invois-online': { enabled: true, always: o.always || [] } } }, grants, { chat: o.chat ?? true, win: false });
  assert.strictEqual(ask([]).decision, 'deny');
  assert.strictEqual(ask([grant({ used: '2026-11-25T01:00:00Z' })]).decision, 'deny', 'one OK covers one send');
  assert.strictEqual(ask([grant({ from: 'shah' })]).decision, 'deny', 'another staff cannot use it');
  assert.strictEqual(ask([grant({ tool: 'send_invoice_email' })]).decision, 'deny', 'other action');
  assert.strictEqual(ask([grant()], { input: { company_id: 1, quotation_id: 'QA000999' } }).decision, 'deny', 'other quotation');
  assert.strictEqual(ask([grant()], { input: { ...inp, emails: ['x@y.com'] } }).decision, 'deny', 'extra recipient the boss did not see');
  assert.strictEqual(ask([grant()], { cwd: '/home/ali/office' }).decision, 'deny', 'the PA cannot use a staff OK');
  const ok = ask([grant()]);
  assert.strictEqual(ok.decision, 'allow'); assert.strictEqual(ok.grant, 'a1');
  assert.strictEqual(ask([grant({ input: { quotation_id: 'QA000123', company_id: '1' } })]).decision, 'allow', 'key order and number as text');
  assert.strictEqual(ask([], { always: ['send_quotation_email'] }).decision, 'allow');
  assert.strictEqual(ask([], { chat: false }).decision, null, 'terminal: Claude Code asks the boss');
  assert.strictEqual(decideAction({ tool_name: 'mcp__invois-online__get_quotations', tool_input: {} }, office, []), null);
  const viaConnector = decideAction({ tool_name: 'mcp__claude_ai_Invois_Online__send_quotation_email', tool_input: inp, cwd: '/home/ali/office/staff/siti' }, { ...office, addons: { 'invois-online': { enabled: true } } }, [grant()], { chat: true, win: false });
  assert.strictEqual(viaConnector.decision, 'allow', 'same OK works through the claude.ai connector');
  // guard.js is a standalone copy of the ask-first list: it must agree with every add-on in defaults.js
  for (const a of require('../lib/defaults').ADDONS) {
    const names = Object.entries(ASK_FIRST).filter(([, r]) => r.addon === a.id).map(([t]) => t.split('__').pop());
    assert.deepStrictEqual([...new Set(names)].sort(), [...new Set(a.roles.flatMap((r) => r.askFirst))].sort(), `guard and defaults agree: ${a.id}`);
    for (const t of new Set(names)) for (const server of [a.id, ...a.aliases]) assert.ok(ASK_FIRST[`mcp__${server}__${t}`], `${server} ${t}`);
  }
});

console.log(`\n${n} guard tests passed`);
