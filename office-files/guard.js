// AI Office command guard. Claude Code runs this before every shell command (PreToolUse, Bash).
// It allows only the commands the boss ticked for that staff on the Staff page, run in the
// office folder or a linked folder. "Office documents" is on for every staff unless the boss turns it off:
// it lets them run node on a script saved in the office (to make PowerPoint, Excel, Word, PDF, images). Some commands are always refused: the boss runs those.
// It also checks the "ask first" add-on actions (send a quotation or invoice, record a payment):
// allowed only when the boss set them to "Always allow" in Settings, or approved this exact one.
// It decides; it does not run anything and sends nothing anywhere.
const fs = require('fs');
const path = require('path');

// Command presets. A command is allowed when it starts with one of "allow" and contains none of "deny".
const PRESETS = {
  git: {
    label: 'Git',
    about: 'status, diff, log, add, commit, branch, switch, stash, fetch, pull, git rm',
    allow: ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git branch', 'git switch',
      'git checkout -b', 'git stash', 'git fetch', 'git pull', 'git rm', 'git restore --staged', 'git rev-parse', 'git remote -v'],
  },
  laravel: { label: 'Laravel', about: 'php artisan (make, migrate, test, route:list, cache, ...)', allow: ['php artisan', 'php -v', 'php -l'] },
  node: { label: 'npm', about: 'npm install, npm ci, npm run, npm test', allow: ['npm install', 'npm i ', 'npm ci', 'npm run', 'npm test', 'npm ls', 'npm outdated', 'NODE_OPTIONS=--max-old-space-size=8192 npm run build'] },
  composer: { label: 'Composer', about: 'composer install, require, update, dump-autoload', allow: ['composer install', 'composer require', 'composer update', 'composer dump-autoload', 'composer show', 'composer outdated', 'composer validate'] },
  docs: { label: 'Office documents', about: 'PowerPoint, Excel, Word, PDF and images (node runs a script saved in the office)', allow: ['node'] },
  go: { label: 'Go', about: 'go build, test, vet, mod download, cover, gofmt -l, golangci-lint', allow: ['go build', 'go test', 'go vet', 'go mod download', 'go tool cover', 'gofmt -l', 'golangci-lint run'] },
  python: { label: 'Python', about: 'pytest, compileall, ruff check, mypy, make lint/test', allow: ['pytest', 'python -m pytest', 'python3 -m pytest', 'python -m compileall', 'python3 -m compileall', 'ruff check', 'mypy', 'make lint', 'make test', '.venv/bin/pytest', '.venv/bin/python -m pytest', '.venv/bin/ruff check', '.venv/bin/mypy'] },
  docker_read: { label: 'Docker (read-only)', about: 'docker compose ps, logs', allow: ['docker compose ps', 'docker compose logs'] },
  git_read: { label: 'Git (read-only)', about: 'status, diff, log, show', allow: ['git status', 'git diff', 'git log', 'git show', 'git rev-parse', 'git remote -v', 'git branch --show-current'] },
};
// A staff's presets: "docs" is on unless the boss turned it off (docs: false in office.json).
const cmdsOf = (s) => [...(s && s.docs === false ? [] : ['docs']), ...((s && s.commands) || []).filter((k) => k !== 'docs')];
// Which staff runs this call ('' = the PA). The office sets AI_OFFICE_STAFF on each run it starts ("pa" for the manager),
// so it holds after a cd into a linked folder. Then a known agent_type, then the staff folder of cwd.
function staffIdOf(input, office, env, P) {
  const ids = (office.staff || []).map((s) => s.id);
  const pinned = (env || {}).AI_OFFICE_STAFF;
  if (pinned === 'pa') return '';
  if (ids.includes(pinned)) return pinned;
  if (ids.includes(input.agent_type)) return input.agent_type;
  const rel = P.relative(office.dir, input.cwd || office.dir).split(/[\\/]/);
  return rel[0] === 'staff' ? rel[1] : '';
}
// Never, whatever is ticked: these lose work, publish, or open a door. The boss runs them.
const ALWAYS_DENY = ['git push', 'git reset --hard', 'git clean', 'git rebase', 'git filter-branch', 'git branch -D', 'git checkout --', 'git restore .',
  'php artisan migrate:fresh', 'php artisan migrate:reset', 'php artisan migrate:refresh', 'php artisan db:wipe', 'php artisan tinker', 'php artisan down',
  'npm publish', 'composer remove', 'rm ', 'sudo', 'curl', 'wget', 'ssh', 'scp',
  'az', 'kubectl', 'docker push', 'docker login', 'docker buildx', 'docker compose down -v', 'docker volume', 'docker system prune', 'docker compose config',
  'go install', 'python -c', 'python3 -c', '.venv/bin/python -c', 'psql', 'alembic downgrade'];

const starts = (cmd, prefix) => cmd === prefix.trim() || cmd.startsWith(prefix.endsWith(' ') ? prefix : `${prefix} `) || cmd.startsWith(`${prefix}\t`);

// Turn a path as Claude writes it (quotes, Git Bash /c/..., ~) into a real absolute path.
function realPath(p, cwd, win) {
  let x = p.replace(/^["']|["']$/g, '');
  if (win && /^\/[a-zA-Z]\//.test(x)) x = `${x[1]}:${x.slice(2)}`;
  if (x.startsWith('~')) return null; // home folder shortcuts are never needed here
  return (win ? path.win32 : path.posix).resolve(cwd || '.', x);
}

// Split "cd X && git add a && git commit -m '...'" into its commands, reading quotes like the shell does.
// Outside quotes only plain words and && are allowed (plus a trailing 2>&1); inside double quotes no
// $ or backtick (they run code); inside single quotes anything. Returns a list of commands, or null.
function splitCommand(cmd) {
  const parts = []; let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { cur += c; if (c === "'") q = null; continue; }
    if (q === '"') { if (c === '$' || c === '`') return null; cur += c; if (c === '\\' && i + 1 < cmd.length) cur += cmd[++i]; else if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '&' && cmd[i + 1] === '&') { parts.push(cur.trim()); cur = ''; i++; continue; }
    if (cmd.startsWith('2>&1', i) && /^\s*($|&&)/.test(cmd.slice(i + 4))) { i += 3; continue; } // show errors too: harmless
    if (/[\n\r;|`$<>&]/.test(c) || (c === '\\' && /[\n\r]/.test(cmd[i + 1] || ''))) return null;
    cur += c;
  }
  if (q) return null;
  parts.push(cur.trim());
  return parts.some((x) => !x) ? null : parts;
}
const firstWord = (s) => { const m = /^("[^"]*"|'[^']*'|\S+)\s*([\s\S]*)$/.exec(s); return m ? [m[1], m[2]] : [s, '']; };

// input: Claude Code's hook input. office: office.json plus { dir, linked: [paths] }.
// Returns { decision: 'allow' | 'deny' | null, reason }.
function decide(input, office, opts = {}) {
  const win = opts.win ?? process.platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const cmd = String((input.tool_input || {}).command || '').trim();
  const staffId = staffIdOf(input, office, opts.env ?? process.env, P);
  const staff = (office.staff || []).find((s) => s.id === staffId);
  const name = staff ? staff.name : 'The PA';
  const no = (reason) => ({ decision: opts.chat ? 'deny' : null, reason });

  // one plain command, or "cd <folder> && command && command" - nothing else
  const parts = cmd ? splitCommand(cmd) : null;
  if (!parts) return no('Only plain commands can run here (no ; | $ ` > < & or similar outside quotes).');
  for (const p of parts) for (const d of ALWAYS_DENY) if (starts(p, d.trim())) {
    // in the terminal the boss is there to say yes or no himself
    return opts.chat ? { decision: 'deny', reason: `"${d.trim()}" is never run from the dashboard. The boss runs it in a terminal (or asks for it in Needs your OK).` } : { decision: null };
  }
  if (!staff) return no(`${name} does not run commands. Hand it to a staff who has commands turned on (Staff page).`);
  const allowed = [...cmdsOf(staff).flatMap((k) => (PRESETS[k] ? PRESETS[k].allow : [])), ...(staff.customCommands || [])];
  if (!allowed.length) return no(`${name} has no commands turned on. The boss can tick them on the Staff page.`);

  const norm = (d) => (win ? P.resolve(d).toLowerCase() : P.resolve(d)); // Windows paths ignore case
  const places = [office.dir, ...(office.linked || [])].map(norm);
  const inside = (d) => { if (!d) return false; const x = norm(d); return places.some((pl) => x === pl || x.startsWith(pl + P.sep)); };
  const elsewhere = no(`${name} may only work in the office folder or a linked folder.`);
  let i = 0;
  if (/^cd\s/.test(parts[0])) {
    const [dirArg, rest] = firstWord(parts[0].slice(3).trim());
    if (rest || !inside(realPath(dirArg, input.cwd || office.dir, win))) return elsewhere;
    i = 1;
  }
  if (i >= parts.length) return { decision: 'allow', reason: 'change folder' };
  for (let p of parts.slice(i)) {
    if (/^cd\s/.test(p)) return no('Use one cd at the start, then the commands.');
    const gc = /^git\s+-C\s+([\s\S]*)$/.exec(p); // git -C "<folder>" <command>
    if (gc) {
      const [dirArg, rest] = firstWord(gc[1]);
      if (!inside(realPath(dirArg, input.cwd || office.dir, win))) return elsewhere;
      p = `git ${rest}`;
      for (const d of ALWAYS_DENY) if (starts(p, d.trim())) return opts.chat ? { decision: 'deny', reason: `"${d.trim()}" is never run from the dashboard. The boss runs it in a terminal.` } : { decision: null };
    }
    if (!allowed.some((a) => starts(p, a))) return no(`"${p.split(/\s+/).slice(0, 3).join(' ')}" is not on ${name}'s allowed commands. The boss can add it on the Staff page.`);
    // Office documents: node only on a script file saved in the office or a linked folder (no -e, no outside scripts)
    if (starts(p, 'node') && !(staff.customCommands || []).some((c) => starts(p, c))) {
      const [file] = firstWord(p.slice(4).trim());
      if (!file || file.startsWith('-') || !/\.(c?js|mjs)["']?$/i.test(file) || !inside(realPath(file, input.cwd || office.dir, win))) {
        return no(`${name} may run node only on a script saved in the office or a linked folder, like: node "projects/<project>/make-deck.cjs".`);
      }
    }
  }
  return { decision: 'allow', reason: `on ${name}'s allowed commands` };
}

// Add-on actions that leave the office. Each needs the boss's OK, unless he set it to "Always allow".
// The same tools may come from the claude.ai connector (mcp__claude_ai_Invois_Online__...): same rule.
// This file is copied into every office and runs alone, so the list is written out here, not read from lib/defaults.js
// (test/guard.test.js checks both lists agree). Each add-on: its server names, and tool -> label.
const ADDON_ASK = {
  'invois-online': { servers: ['invois-online', 'claude_ai_Invois_Online'], tools: {
    send_quotation_email: 'Email a quotation to the customer', send_invoice_email: 'Email an invoice to the customer', create_payment: 'Record a payment on an invoice' } },
  // GitHub is read-only in v1 (/mcp/readonly), so these do not exist yet; they are gated for a later write mode.
  github: { servers: ['github', 'claude_ai_GitHub'], tools: {
    merge_pull_request: 'Merge a pull request', push_files: 'Push files to a repository', create_or_update_file: 'Create or change a file in a repository',
    delete_file: 'Delete a file from a repository', delete_repository: 'Delete a repository', create_repository: 'Create a repository',
    actions_run_trigger: 'Run or cancel a GitHub Actions workflow', pull_request_review_write: 'Review a pull request',
    update_pull_request_branch: 'Update a pull request branch', create_pull_request: 'Open a pull request', update_pull_request: 'Change a pull request',
    issue_write: 'Create or change an issue', add_issue_comment: 'Comment on an issue' } },
  figma: { servers: ['figma', 'claude_ai_Figma'], tools: {
    use_figma: 'Change a Figma file (can delete content)', send_code_to_figma: 'Send code to Figma', generate_figma_design: 'Create a design in Figma' } },
  context7: { servers: ['context7', 'claude_ai_Context7'], tools: {} }, // read only: nothing to ask
};
const ASK_FIRST = {};
for (const [addon, { servers, tools }] of Object.entries(ADDON_ASK)) {
  for (const [t, label] of Object.entries(tools)) for (const server of servers) ASK_FIRST[`mcp__${server}__${t}`] = { addon, label };
}

// Same call? Same keys, same values (a number and its text count as the same).
function sameInput(a, b) {
  const norm = (v) => (v && typeof v === 'object' ? JSON.stringify(Array.isArray(v) ? v.map(norm) : Object.keys(v).sort().map((k) => [k, norm(v[k])])) : String(v));
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && norm(a[k]) === norm(b[k]));
}

// An ask-first add-on action. Returns { decision, reason, grant } (grant: the boss's OK it uses up), or null if not ours.
// grants: .office/grants.json, written by the dashboard when the boss clicks Approve (staff cannot write there
// from the dashboard): [{ id, from, tool, input, used }].
function decideAction(input, office, grants, opts = {}) {
  const tool = input.tool_name, rule = ASK_FIRST[tool];
  if (!rule) return null;
  const short = tool.split('__').pop();
  const addon = (office.addons || {})[rule.addon] || {};
  if ((addon.always || []).includes(short)) return { decision: 'allow', reason: `The boss set "${rule.label}" to Always allow.` };
  const P = (opts.win ?? process.platform === 'win32') ? path.win32 : path.posix;
  const staffId = staffIdOf(input, office, opts.env ?? process.env, P);
  const g =staffId && (grants || []).find((x) => !x.used && x.from === staffId && x.tool === short && sameInput(x.input, input.tool_input || {}));
  if (g) return { decision: 'allow', reason: `The boss approved this (${g.action || short}).`, grant: g.id };
  const how = `Write an approval file in approvals/ with "tool: ${short}" and "input: <the exact JSON you will call it with, on one line>", then stop. When the boss approves, the office runs it for you.`;
  return opts.chat ? { decision: 'deny', reason: `"${rule.label}" needs the boss's OK first. ${how}` } : { decision: null, reason: how };
}

// Use up a grant (one OK covers one action), and note it in the approval file for the dashboard.
function useGrant(dir, id, when = new Date().toISOString()) {
  const f = path.join(dir, '.office', 'grants.json');
  const grants = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const g of grants) if (g.id === id) g.used = when;
  fs.writeFileSync(f, JSON.stringify(grants, null, 2) + '\n');
  try {
    const af = path.join(dir, 'approvals', `${path.basename(id)}.md`);
    const lines = fs.readFileSync(af, 'utf8').split(/\r?\n/);
    const end = lines.indexOf('---', 1);
    if (lines[0] === '---' && end > 0) { lines.splice(end, 0, `used: ${when}`); fs.writeFileSync(af, lines.join('\n')); }
  } catch { /* approval file gone: the grant is what counts */ }
}

module.exports = { PRESETS, ALWAYS_DENY, ASK_FIRST, cmdsOf, decide, decideAction, sameInput };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input, office;
    try { input = JSON.parse(raw); } catch { return; }
    const dir = path.dirname(__dirname);
    try { office = JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')); } catch { return; }
    const say = (r) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason } }));
    if (ASK_FIRST[input.tool_name]) {
      let grants = [];
      try { grants = JSON.parse(fs.readFileSync(path.join(dir, '.office', 'grants.json'), 'utf8')); } catch { /* none yet */ }
      const r = decideAction(input, { ...office, dir }, grants, { chat: process.env.AI_OFFICE_CHAT === '1' });
      if (!r || !r.decision) return; // terminal: Claude Code asks the boss as usual
      if (r.grant) useGrant(dir, r.grant);
      return say(r);
    }
    if (input.tool_name !== 'Bash') return;
    // linked folders: office-wide, plus each project's "linked:" line
    const linked = (office.linked || []).map((l) => l.path);
    try {
      for (const p of fs.readdirSync(path.join(dir, 'projects'))) {
        const m = /^linked:\s*(.+?)\s*(?:\s#\s.*)?$/m.exec(fs.readFileSync(path.join(dir, 'projects', p, 'CLAUDE.md'), 'utf8'));
        if (m) linked.push(m[1]);
      }
    } catch { /* no projects */ }
    const r = decide(input, { ...office, dir, linked }, { chat: process.env.AI_OFFICE_CHAT === '1' });
    if (!r.decision) return; // terminal: Claude Code asks the boss as usual
    say(r);
  });
}
