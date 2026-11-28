// Command guard: who may run what, where. This is a safety boundary, so test it hard.
const assert = require('assert');
const { decide, decideAction, ASK_FIRST, PRESETS, autoOn } = require('../office-files/guard');

const office = {
  dir: '/home/ali/office',
  linked: ['/home/ali/projects/8fix'],
  staff: [
    { id: 'shah', name: 'Shah', commands: ['git', 'laravel'], customCommands: ['php vendor/bin/pint'] },
    { id: 'irfan', name: 'Irfan', commands: ['pnpm', 'yarn', 'python', 'go', 'rust', 'github', 'node'] },
    { id: 'wide', name: 'Wide', customCommands: ['cargo', 'pnpm', 'yarn', 'go', 'gh'] },
    { id: 'siti', name: 'Siti' },
    { id: 'aina', name: 'Aina', docs: false },
    { id: 'wei', name: 'Wei Jie', commandMode: 'auto' },
    { id: 'priya', name: 'Priya', commands: ['git'], commandMode: 'auto' },
  ],
};
const run = (command, o = {}) => decide({ tool_name: 'Bash', tool_input: { command }, agent_type: o.agent ?? 'shah', cwd: o.cwd || office.dir }, office, { chat: o.chat ?? true, win: false });
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
  assert.deepStrictEqual(Object.keys(PRESETS), ['git', 'laravel', 'node', 'composer', 'pnpm', 'yarn', 'python', 'go', 'rust', 'github', 'docs']);
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
  assert.deepStrictEqual([...new Set(Object.keys(ASK_FIRST).map((t) => t.split('__').pop()))].sort(),
    require('../lib/defaults').INVOIS.roles.flatMap((r) => r.askFirst).sort(), 'guard and defaults agree');
});

test('engineer presets: build and test tools allowed, publishing and arbitrary code refused', () => {
  const o = { agent: 'irfan' };
  for (const c of ['pnpm install', 'pnpm run build', 'pnpm test', 'yarn install', 'yarn test', 'pytest -q', 'python -m pytest tests/', 'pip install -r requirements.txt',
    'go build ./...', 'go test ./...', 'cargo build', 'cargo test', 'cd /home/ali/projects/8fix && cargo check']) allow(c, o);
  for (const c of ['pnpm publish', 'pnpm dlx cowsay', 'pnpm exec x', 'yarn dlx x', 'yarn npm publish', 'yarn publish', 'cargo publish', 'cargo run', 'cargo install x',
    'pip install requests', 'python -c "print(1)"', 'python script.py', 'go run .', 'go install x@latest']) deny(c, o);
  deny('pnpm install', { agent: 'shah' });                    // not ticked for Shah
});

test('GitHub read only: look things up, never change them', () => {
  const o = { agent: 'irfan' };
  for (const c of ['gh issue view 12', 'gh issue view 12 --repo acme/shop --comments', 'gh issue list --label bug', 'gh pr view 5', 'gh pr list', 'gh pr diff 5', 'gh project item-list 3 --owner acme']) allow(c, o);
  for (const c of ['gh pr merge 5', 'gh issue comment 12 -b hi', 'gh issue close 12', 'gh issue create -t x', 'gh pr create', 'gh api repos/acme/shop', 'gh auth token', 'gh secret list', 'gh repo delete x', 'gh issue view 12 && rm -rf x', 'gh issue view 12 | cat']) deny(c, o);
});

test('engineer always-refused commands stay refused even when a custom command is broad', () => {
  const o = { agent: 'wide' };
  allow('cargo build', o); allow('go version', o);
  for (const c of ['pnpm publish', 'pnpm dlx x', 'pnpm exec x', 'yarn publish', 'yarn npm publish', 'yarn dlx x', 'yarn exec x', 'cargo publish', 'cargo install x', 'cargo run',
    'go run .', 'go install x@latest', 'gh auth token', 'gh api repos/a/b', 'gh secret list']) deny(c, o);
});

test('flags that run a program or delete a folder are refused, whatever allowed the command', () => {
  const o = { agent: 'irfan' };
  for (const c of ['go test -exec "sh -c id" ./...', 'go build -toolexec ./x', 'go vet -vettool=./x', 'cargo build --config build.rustc-wrapper="sh"', 'cargo test --config x=1',
    'pytest --basetemp=/somewhere', 'python -m pytest --basetemp /somewhere', 'cd /home/ali/projects/8fix && go test -exec x ./...']) deny(c, o);
  deny('go test -exec x ./...', { agent: 'wide' });
  assert.strictEqual(run('go test -exec x', { chat: false }).decision, null, 'terminal: no decision');
  assert.ok(/"-exec" is not allowed with go: it can run or delete anything\./.test(run('go test -exec x', { agent: 'irfan' }).reason));
  for (const c of ['go test ./... -run TestExec', 'cargo test config_loads', 'pytest tests/test_basetemp.py']) allow(c, o);
});

test('the flag check sees through quotes, backslashes and double dashes', () => {
  const o = { agent: 'irfan' };
  for (const c of ['go test --exec sh', 'go test --exec=sh ./...', 'go build --toolexec ./x', 'go vet --vettool=./x', 'go test -ex""ec sh', "go test -e'x'ec sh", 'go test "--exec" sh',
    "cargo build '--config' x", 'pytest --base"temp"=/x', 'go test -ex\\ec sh']) deny(c, o);
  for (const c of ['go test ./... -run TestExec', 'go test ./exec/...', 'cargo test config_loads', 'pytest tests/test_basetemp.py', 'pytest -k "exec or config"']) allow(c, o);
});

test('the manager: no commands unless GitHub is ticked, then only GitHub look-ups', () => {
  const asPa = (command, off) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: off.dir }, off, { chat: true, win: false, who: 'pa' });
  assert.strictEqual(asPa('gh issue view 12', office).decision, 'deny');
  assert.ok(/does not run commands/.test(asPa('gh issue view 12', office).reason), 'nothing ticked: today\'s text');
  const withGh = { ...office, pa: { name: 'Hana', commands: ['github', 'git'] } };   // 'git' must be ignored
  assert.strictEqual(asPa('gh issue view 12 --repo acme/shop', withGh).decision, 'allow');
  assert.strictEqual(asPa('gh project item-list 3 --owner acme', withGh).decision, 'allow');
  for (const c of ['gh pr merge 5', 'gh issue comment 12 -b x', 'gh api repos/acme/shop', 'gh issue view 12 && rm -rf x', 'git status', 'npm test', 'node x.cjs'])
    assert.strictEqual(asPa(c, withGh).decision, 'deny', c);
  assert.match(asPa('git status', withGh).reason, /can only look things up on GitHub/);
  const onlyGit = { ...office, pa: { name: 'Hana', commands: ['git'] } };
  assert.ok(/does not run commands/.test(asPa('git status', onlyGit).reason), 'a value other than github is ignored');
});

test('the manager list needs the manager\'s own dashboard chat; a bad pa.commands breaks nobody', () => {
  const gh = { ...office, pa: { name: 'Hana', commands: ['github'] } };
  const d = (cwd, o, extra = {}, opts = {}) => decide({ tool_name: 'Bash', tool_input: { command: 'gh issue view 1' }, cwd, ...extra }, o, { chat: true, win: false, ...opts });
  assert.strictEqual(d(gh.dir, gh, {}, { who: 'pa' }).decision, 'allow');
  const old = (r) => /does not run commands/.test(r.reason);
  for (const r of [d('/home/ali/projects/8fix', gh), d(gh.dir, gh), d(gh.dir + '/staff/ghost', gh, {}, { who: 'pa' }), d(gh.dir, gh, { agent_type: 'general-purpose' }, { who: 'pa' }), d(gh.dir, gh, {}, { who: 'aina' })]) {
    assert.strictEqual(r.decision, 'deny'); assert.ok(old(r), r.reason);
  }
  assert.strictEqual(d(gh.dir, gh, {}, { who: 'pa', chat: false }).decision, null, 'terminal: no decision');
  for (const bad of ['github', { github: true }, 7, null]) {
    const o = { ...office, pa: { name: 'Hana', commands: bad } };
    assert.strictEqual(run('git status', { agent: 'shah' }).decision, 'allow');
    assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'git status' }, agent_type: 'shah', cwd: o.dir }, o, { chat: true, win: false }).decision, 'allow');
    assert.ok(old(decide({ tool_name: 'Bash', tool_input: { command: 'gh issue view 1' }, cwd: o.dir }, o, { chat: true, win: false, who: 'pa' })));
  }
});

test('flags that move a command outside the allowed folders are refused; lowercase -c and plain commands stay allowed', () => {
  const eng = { ...office, staff: [{ id: 'eng', name: 'Eng', commands: ['node', 'pnpm', 'yarn', 'go', 'rust'] }] };
  const r = (command) => decide({ tool_name: 'Bash', tool_input: { command }, agent_type: 'eng', cwd: eng.dir }, eng, { chat: true, win: false });
  for (const [c, flag, w] of [['go build -C /tmp ./...', '-C', 'go'], ['go test -C=/tmp ./...', '-C', 'go'], ['cargo build --manifest-path /tmp/x/Cargo.toml', '--manifest-path', 'cargo'],
    ['cargo test -C /tmp', '-C', 'cargo'], ['yarn install --cwd /tmp', '--cwd', 'yarn'], ['pnpm install -C /tmp', '-C', 'pnpm'], ['pnpm run build --dir=/tmp', '--dir', 'pnpm'],
    ['npm install --prefix /tmp', '--prefix', 'npm'], ['cd /home/ali/projects/8fix && npm run build --prefix=/tmp', '--prefix', 'npm']]) {
    const d = r(c);
    assert.strictEqual(d.decision, 'deny', c);
    assert.strictEqual(d.reason, `"${flag}" is not allowed with ${w}: use cd "<folder>" && first.`, c);
  }
  for (const c of ['go test -c ./...', 'npm test', 'npm run build --if-present', 'pnpm install', 'cargo build', 'yarn install']) assert.strictEqual(r(c).decision, 'allow', `${c}: ${r(c).reason}`);
  assert.ok(/"-exec" is not allowed with go: it can run or delete anything\./.test(r('go test -exec x').reason), 'the run-or-delete text stays');
});

test('npm cannot be pointed outside the folder or install for the whole computer', () => {
  const o = { agent: 'irfan' };
  for (const c of ['npm -C /tmp install', 'npm install -C /tmp', 'npm install --prefi /tmp', 'npm install --prefi=/tmp', 'npm install --pref"ix" /tmp',
    'npm install -g cowsay', 'npm install --global cowsay', 'npm i --glob cowsay', 'npm install --location=global cowsay', 'npm install --loc global x',
    'pnpm add -g x', 'pnpm install --global', 'yarn global add x']) deny(c, o);
  for (const c of ['npm install', 'npm install --prefer-offline', 'npm ci', 'npm run build', 'npm test -- --grep prefix', 'npm ls --long', 'pnpm install', 'yarn install']) allow(c, o);
});

test('npm and pnpm: combined and shortened flags cannot go global or move the folder', () => {
  const o = { agent: 'irfan' };
  for (const c of ['npm install -gf x', 'npm install -fg x', 'npm install -sg x', 'npm i -gs x', 'npm install -ddg x', 'npm install --gl x', 'npm install --gf x', 'npm install -sC /tmp',
    'npm install -L global x', 'npm install -sL global x', 'npm install -prefi /x', 'npm install -prefi=/x', 'npm install -locatio global x', 'pnpm install --glob', 'pnpm i -sg x']) deny(c, o);
  for (const c of ['npm install --legacy-peer-deps', 'npm install --save-dev x', 'npm install --save-exact x', 'npm install --prefer-offline', 'npm ls --long', 'npm install -D x', 'npm install -E x',
    'npm install --no-global', 'npm run build --if-present', 'npm ci --silent', 'npm install -s', 'npm install -d', 'npm install -f', 'npm install --force', 'npm ci --ci',
    'npm test -- -g pattern', 'npm test -- -gf', 'pnpm install --frozen-lockfile']) allow(c, o);
});

test('auto staff: the guard gives no decision on an unlisted command, and still refuses the never-list', () => {
  const r = (c, o = {}) => run(c, { agent: 'wei', ...o });
  const none = (c, o) => { const x = r(c, o); assert.strictEqual(x.decision, null, `no decision: ${c} (${x.reason})`); };
  for (const c of ['make test', 'ls -la', 'cd /home/ali/projects/8fix && make test', 'docker compose up -d', 'git -C /home/ali/projects/8fix describe --always']) none(c);
  for (const c of ['git push', 'git push origin main', 'git -C /home/ali/projects/8fix push', 'cd /home/ali/projects/8fix && git reset --hard HEAD~1', 'go test --exec sh', 'npm publish',
    'npm install -g x', 'ls | cat', 'echo $(whoami)', 'make test; rm -rf x', 'rm -rf build', 'curl http://x', 'cd /etc && ls', 'git -C /etc status', 'cd /home/ali/projects/8fix && cd .. && ls'])
    assert.strictEqual(r(c).decision, 'deny', c);
  assert.strictEqual(run('git status', { agent: 'priya' }).decision, 'allow');          // ticked: allowed outright
  assert.strictEqual(run('make test', { agent: 'priya' }).decision, null);
  assert.strictEqual(run('git status && make test', { agent: 'priya' }).decision, null); // one part unlisted: the whole line has no decision
  assert.strictEqual(run('git status && git push', { agent: 'priya' }).decision, 'deny'); // a refused part still wins
  assert.strictEqual(run('make test && git -C /etc status', { agent: 'priya' }).decision, 'deny');
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
  assert.strictEqual(autoOn({ commandMode: 'auto' }), true);
  for (const v of [undefined, null, {}, { commandMode: 'listed' }, { commandMode: 'AUTO' }, { commandMode: true }]) assert.strictEqual(autoOn(v), false);
});

test('pnpm one-letter flags run together: -r, -i and -F count with -g', () => {   // the letter set is the one-letter shorthands pnpm and npm read
  for (const c of ['pnpm i -rg x', 'pnpm i -ig x', 'pnpm install -Fg']) deny(c, { agent: 'irfan' });
  for (const c of ['pnpm install -r', 'pnpm install -F app']) allow(c, { agent: 'irfan' });
});

test('fix round 1: the never-list and folder rule read commands as the shell does; Auto staff run commands by name', () => {
  const bad = ['"git" push', 'git "push"', "g''it push", 'git  push', 'git\tpush', '\\git push', 'git -c a=b push', 'git --no-pager push', '/usr/bin/git push', 'env git push', 'command git push',
    'git -C /home/ali/projects/8fix "push"', '"rm" -rf x', '\\rm -rf x', 'command rm -rf x', '/bin/rm -rf x', 'sh -c "git push"', "bash -c 'rm -rf /'",
    'git -C/etc status', 'git --git-dir=/etc/.git status', 'git --work-tree=/etc status', 'git -c x=y -C /etc status', 'cd && ls', 'cd - && ls', 'pushd /etc && ls', 'builtin cd /etc && ls', 'ls && "cd" /etc && ls',
    "cd ''/etc && ls", 'cd \\/etc && ls', "git -C ''/etc status"];
  for (const who of ['shah', 'wei', 'priya']) for (const c of bad) assert.strictEqual(run(c, { agent: who }).decision, 'deny', `${who}: ${c}`);
  for (const c of ['./build.sh', '/usr/bin/make', 'env FOO=1 make', 'xargs rm', 'python -c "import os"', 'node -e "1"', 'timeout 5 make', 'git --no-pager log', 'git -C /home/ali/projects/8fix -C /etc status', 'ls ; x'])
    assert.strictEqual(run(c, { agent: 'wei' }).decision, 'deny', c);
  for (const c of ['make test', 'ls -la', 'python manage.py test', 'cd /home/ali/projects/8fix && make test', 'git -C /home/ali/projects/8fix describe --always', 'docker compose up -d', 'pytest -q'])
    assert.strictEqual(run(c, { agent: 'wei' }).decision, null, c);
  assert.strictEqual(run('node scripts/build.js', { agent: 'wei' }).decision, 'allow');   // node on a script in the office is on the always-on Office documents list
  for (const c of ['git status', 'git -C /home/ali/projects/8fix status', 'cd /home/ali/projects/8fix && git add . && git commit -m "fix: it\'s done"']) allow(c, { agent: 'shah' });
  const asPa = decide({ tool_name: 'Bash', tool_input: { command: 'make test' }, cwd: '/home/ali/office/staff/wei' }, office, { chat: true, who: 'pa', win: false });
  assert.strictEqual(asPa.decision, 'deny');
});

test('fix round 2: Windows program names, git and find flags that run programs, folders after cd', () => {
  const win = (command, agent) => decide({ tool_name: 'Bash', tool_input: { command }, agent_type: agent, cwd: office.dir }, office, { chat: true, win: true }).decision;
  for (const who of ['wei', 'priya']) for (const c of ['"C:\\Git\\cmd\\git.exe" push', '"C:\\Program Files\\Git\\cmd\\git.exe" push']) assert.strictEqual(win(c, who), 'deny', `${who}: ${c}`);
  const bad = ['git.exe push', 'GIT.EXE push', 'rm.exe -rf x', 'git.cmd push', 'git config alias.p push', 'git config core.sshCommand x', 'git send-pack origin', 'unlink x', 'shred x', 'npx cowsay', 'npm exec cowsay', 'bunx x',
    "git fetch --upload-pack='touch x' /tmp/r", 'git pull --upload-pack=x', 'git -C /home/ali/projects/8fix fetch --upload-pack x', 'find . -delete', 'find . -exec rm {} +',
    'python -Sc "1"', 'python -Ic "1"', 'perl -ne 1', 'perl -E 1', 'node --eval=1', 'node --print=1', 'python2 -c 1', 'lua -e 1'];
  for (const who of ['shah', 'wei', 'priya']) for (const c of bad) if (who !== 'shah' || /^git /.test(c)) assert.strictEqual(run(c, { agent: who }).decision, 'deny', `${who}: ${c}`);
  for (const c of ["git fetch --upload-pack='touch x' /tmp/r", 'git pull --receive-pack=x', 'git config alias.p push']) deny(c, { agent: 'shah' });
  for (const c of ['find . -name "*.js"', 'python -m pytest -q', 'python -mpytest', 'python manage.py test', 'python -u script.py', 'git --version', 'node --version', 'python -V', 'php artisan test', 'ruby script.rb'])
    assert.strictEqual(run(c, { agent: 'wei' }).decision, null, c);
  for (const c of ['git fetch', 'git pull', 'git fetch origin main']) allow(c, { agent: 'shah' });
  const sc = '/home/ali/office/staff/shah';
  for (const who of ['shah', 'wei']) deny('cd /home/ali/office && git -C ../.. add .', { agent: who, cwd: sc });
  allow('cd /home/ali/projects/8fix && git -C . status', { agent: 'shah', cwd: sc });
  allow('cd /home/ali/projects/8fix && git -C src status', { agent: 'shah', cwd: sc });
  deny('cd /home/ali/office && node ../../x.cjs', { agent: 'shah', cwd: sc });
  allow('cd /home/ali/office && node projects/raya/make.cjs', { agent: 'shah', cwd: sc });
});

console.log(`\n${n} guard tests passed`);
