// Office server + API tests against a temporary office. Run: npm test
process.env.AI_OFFICE_NO_DOCTOOLS = '1'; // never download the document tools in tests
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const G = require('../lib/generate');
const D = require('../lib/defaults');
const { createServer } = require('../lib/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-srv-'));
// a fake "claude", so briefing the PA (after an approval) never runs the real one in tests
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const callLog = path.join(tmp, 'calls.jsonl');
const fake = `const L = ${JSON.stringify(callLog)}; ` + "const a = process.argv.slice(2); const m = a[a.indexOf('-p') + 1] || ''; require('fs').appendFileSync(L, JSON.stringify(m) + '\\n'); setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n'), m.includes('LONG') ? 5000 : 0);";
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
  fs.mkdirSync(path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), fake);
} else fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const dir = path.join(tmp, 'office');
const cfg = G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 3).map(({ name, role, job }) => ({ name, role, job })) });
G.writeOffice(dir, cfg);
const read = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf8');

let port;
function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `localhost:${port}`, 'x-office-key': cfg.key, ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; });
      res.on('end', () => { let j = s; try { j = JSON.parse(s); } catch { /* html */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

(async () => {
  const srv = createServer(dir);
  port = await srv.listen(0);
  try {
    await test('page has the key; API needs it; wrong host and origin are refused', async () => {
      const page = await req('GET', '/', null, { 'x-office-key': '' });
      assert.strictEqual(page.status, 200); assert.ok(page.body.includes(cfg.key));
      assert.strictEqual((await req('GET', '/api/office', null, { 'x-office-key': 'nope' })).status, 401);
      assert.strictEqual((await req('GET', '/api/office', null, { host: 'evil.example:80' })).status, 421);
      assert.strictEqual((await req('POST', '/api/inbox', { from: 'x', text: 'y' }, { origin: 'https://evil.example' })).status, 403);
      const o = await req('GET', '/api/office');
      assert.strictEqual(o.status, 200); assert.strictEqual(o.body.company, 'Kedai Ali'); assert.ok(!('key' in o.body));
      assert.strictEqual((await req('GET', '/../office.json')).status, 404);
      assert.strictEqual((await req('GET', '/api/staff/..%2F..%2Fx')).status, 400);
    });

    await test('edit staff: CLAUDE.md sections, agent description and team table follow', async () => {
      const r = await req('PUT', '/api/staff/siti', { name: 'Siti Aisyah', role: 'Sales Lead', job: 'Quotes and follow ups.', rules: ['Reply fast', '', 'No discounts'], colour: '#3A86FF' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const t = read('staff/siti/CLAUDE.md');
      assert.match(t, /^# Siti Aisyah, Sales Lead$/m); assert.match(t, /You are \*\*Siti Aisyah\*\*, the Sales Lead staff/);
      assert.match(t, /## Rules\n\n- Reply fast\n- No discounts\n/); assert.match(t, /## Tools/);
      assert.match(read('.claude/agents/siti.md'), /^description: Siti Aisyah, Sales Lead\. Quotes and follow ups\./m);
      assert.match(read('CLAUDE.md'), /\| siti \| Siti Aisyah \| Sales Lead \| Quotes and follow ups\. \|/);
      assert.strictEqual(JSON.parse(read('office.json')).staff.find((s) => s.id === 'siti').colour, '#3A86FF');
    });

    await test('add, archive, reactivate, delete staff', async () => {
      const a = await req('POST', '/api/staff', { name: 'Farah', role: 'Marketing', job: 'Posts and promos' });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body));
      assert.ok(fs.existsSync(path.join(dir, '.claude/agents/farah.md')));
      assert.ok(fs.existsSync(path.join(dir, 'staff/farah/.claude/settings.json')));
      assert.match(read('CLAUDE.md'), /\| farah \| Farah \| Marketing \|/);
      assert.strictEqual((await req('POST', '/api/staff/farah/archive')).status, 200);
      assert.ok(fs.existsSync(path.join(dir, '.archive/staff/farah/CLAUDE.md')));
      assert.doesNotMatch(read('CLAUDE.md'), /\| farah \|/);
      assert.strictEqual((await req('POST', '/api/staff/farah/delete', { confirm: 'yes' })).status, 400);
      assert.strictEqual((await req('POST', '/api/staff/farah/reactivate')).status, 200);
      assert.ok(fs.existsSync(path.join(dir, 'staff/farah/CLAUDE.md')));
      await req('POST', '/api/staff/farah/archive');
      assert.strictEqual((await req('POST', '/api/staff/farah/delete', { confirm: 'DELETE' })).status, 200);
      assert.ok(!fs.existsSync(path.join(dir, '.archive/staff/farah')));
    });

    await test('projects: create, update header, add note', async () => {
      const p = await req('POST', '/api/projects', { title: 'Kedai Ali website', customer: 'Kedai Ali', deadline: '2026-12-01', what: 'Shop site' });
      assert.strictEqual(p.body.id, 'kedai-ali-website');
      const u = await req('PUT', '/api/projects/kedai-ali-website', { status: 'waiting' });
      assert.strictEqual(u.body.status, 'waiting'); assert.strictEqual(u.body.deadline, '2026-12-01');
      const nn = await req('POST', '/api/projects/kedai-ali-website/notes', { note: 'Budget RM3,000' });
      assert.strictEqual(nn.body.notes.length, 1); assert.match(nn.body.notes[0], /^Budget RM3,000 \(boss, \d{4}-\d{2}-\d{2}\)$/);
      // a project Claude wrote by hand, without a header, still lists
      fs.mkdirSync(path.join(dir, 'projects/syarikat-jaya')); fs.writeFileSync(path.join(dir, 'projects/syarikat-jaya/CLAUDE.md'), '# Syarikat Jaya shirts\n\nNotes go here.\n');
      const all = await req('GET', '/api/projects');
      assert.deepStrictEqual(all.body.map((x) => x.title).sort(), ['Kedai Ali website', 'Syarikat Jaya shirts']);
    });

    await test('inbox: add, tickets for hand-written items, assign', async () => {
      const a = await req('POST', '/api/inbox', { from: 'Puan Rosnah', source: 'whatsapp', type: 'order', text: '30 kotak nasi lemak' });
      assert.strictEqual(a.body.ticket, '101'); assert.strictEqual(a.body.status, 'new');
      fs.writeFileSync(path.join(dir, 'inbox/20261124-090000-ali.md'), '---\nfrom: Ali\nsource: email\ntype: enquiry  # comment\nstatus: new\nreceived: 2026-11-24T09:00:00+08:00\nassigned:\n---\nPrice?\n');
      const list = await req('GET', '/api/inbox');
      const ali = list.body.find((x) => x.from === 'Ali');
      assert.strictEqual(ali.ticket, '102'); assert.strictEqual(ali.type, 'enquiry');
      assert.match(read('inbox/20261124-090000-ali.md'), /^ticket: 102$/m);
      const u = await req('PUT', `/api/inbox/${ali.id}`, { assigned: 'aina', status: 'working' });
      assert.strictEqual(u.body.assigned, 'aina');
      assert.strictEqual((await req('PUT', `/api/inbox/${ali.id}`, { assigned: 'nobody' })).status, 400);
    });

    await test('approvals: ask, decide once, event logged', async () => {
      const a = await req('POST', '/api/approvals', { from: 'siti', action: 'Give 10% discount to Kedai Ali', details: 'RM125 off', project: 'kedai-ali-website' });
      assert.strictEqual(a.body.status, 'pending');
      const d = await req('POST', `/api/approvals/${a.body.id}/decide`, { decision: 'approved', note: 'OK this once' });
      assert.strictEqual(d.body.status, 'approved'); assert.ok(d.body.decided);
      assert.match(read(`approvals/${a.body.id}.md`), /Boss: OK this once/);
      assert.strictEqual((await req('POST', `/api/approvals/${a.body.id}/decide`, { decision: 'rejected' })).status, 409);
      const ev = read('.office/events.jsonl').trim().split('\n').map(JSON.parse).pop();
      assert.strictEqual(ev.ev, 'Approval'); assert.match(ev.msg, /approved/);
    });

    await test('ask-first action: approve saves the OK for the guard and starts the staff; setting can be Always allow', async () => {
      const o = JSON.parse(read('office.json'));
      o.addons = { 'invois-online': { enabled: true, mcp: 'invois-online', staff: ['siti'] } };
      fs.writeFileSync(path.join(dir, 'office.json'), JSON.stringify(o, null, 2));
      assert.strictEqual((await req('POST', '/api/approvals', { from: 'siti', action: 'x', tool: 'rm_everything', input: {} })).status, 400);
      const a = await req('POST', '/api/approvals', { from: 'siti', action: 'Email QA000123 to Kedai Ali', tool: 'mcp__invois-online__send_quotation_email', input: { company_id: 1, quotation_id: 'QA000123' } });
      assert.strictEqual(a.body.tool, 'send_quotation_email');
      await req('POST', `/api/approvals/${a.body.id}/decide`, { decision: 'approved' });
      const g = JSON.parse(read('.office/grants.json')).pop();
      assert.deepStrictEqual([g.from, g.tool, g.input.quotation_id, g.used], ['siti', 'send_quotation_email', 'QA000123', null]);
      const t = fs.readdirSync(path.join(dir, 'tasks')).filter((f) => f.endsWith('-siti.md')).map((f) => read(`tasks/${f}`)).find((x) => x.includes(a.body.id));
      assert.ok(t && /send_quotation_email/.test(t) && /QA000123/.test(t), 'siti got a task to do it');
      const r = await req('POST', '/api/approvals', { from: 'siti', action: 'Email QA000124', tool: 'send_quotation_email', input: { company_id: 1, quotation_id: 'QA000124' } });
      await req('POST', `/api/approvals/${r.body.id}/decide`, { decision: 'rejected' });
      assert.strictEqual(JSON.parse(read('.office/grants.json')).length, 1, 'a rejection grants nothing');
      const acts = await req('GET', '/api/actions');
      assert.deepStrictEqual(acts.body.map((x) => x.tool), ['send_quotation_email', 'send_invoice_email', 'create_payment']);
      await req('POST', '/api/actions', { tool: 'send_quotation_email', always: true });
      assert.deepStrictEqual(JSON.parse(read('office.json')).addons['invois-online'].always, ['send_quotation_email']);
      await req('POST', '/api/actions', { tool: 'send_quotation_email', always: false });
      assert.deepStrictEqual(JSON.parse(read('office.json')).addons['invois-online'].always, []);
    });

    await test('clean up: needs CLEAR, clears only what was picked, never the staff setup', async () => {
      await new Promise((res) => setTimeout(res, 800)); // the PA's short briefing after the approval ends first
      fs.writeFileSync(path.join(dir, 'staff/siti/quote.md'), 'x');
      fs.appendFileSync(path.join(dir, '.office/events.jsonl'), '{"ev":"Stop"}\n');
      assert.strictEqual((await req('POST', '/api/cleanup', { items: ['inbox'], confirm: 'yes' })).status, 400);
      const r = await req('POST', '/api/cleanup', { items: ['activity', 'inbox', 'staffFiles', 'nonsense'], confirm: 'CLEAR' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(fs.readdirSync(path.join(dir, 'inbox')).length, 0);
      assert.strictEqual(read('.office/events.jsonl'), '');
      assert.ok(!fs.existsSync(path.join(dir, 'staff/siti/quote.md')));
      assert.ok(fs.existsSync(path.join(dir, 'staff/siti/CLAUDE.md')) && fs.existsSync(path.join(dir, 'staff/siti/.claude/settings.json')));
      assert.ok(fs.readdirSync(path.join(dir, 'approvals')).length > 0, 'approvals not picked, so kept');
      assert.ok(fs.existsSync(path.join(dir, 'office.json')) && fs.existsSync(path.join(dir, '.claude/agents/siti.md')));
    });

    await test('linked folders: checked, saved, put in the terminal settings, removed again', async () => {
      const ext = path.join(tmp, 'shop website'); fs.mkdirSync(ext);
      assert.match((await req('POST', '/api/linked', { path: 'relative/dir' })).body.error, /full folder path/);
      assert.match((await req('POST', '/api/linked', { path: path.join(tmp, 'nope') })).body.error, /does not exist/);
      assert.match((await req('POST', '/api/linked', { path: os.homedir() })).body.error, /too wide/);
      assert.match((await req('POST', '/api/linked', { path: tmp })).body.error, /contains the office/);
      const r = await req('POST', '/api/linked', { path: ext, label: 'Website' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.map((l) => [l.label, l.ok]), [['Website', true]]);
      const T = require('../lib/templates');
      const allow = () => JSON.parse(read('staff/siti/.claude/settings.json')).permissions.allow;
      assert.ok(T.officeRules(ext).every((x) => allow().includes(x)), 'staff terminal settings allow the linked folder');
      // a project's own linked folder
      const pr = await req('PUT', '/api/projects/kedai-ali-website', { linked: ext });
      assert.strictEqual(pr.body.linked, ext);
      await req('PUT', '/api/projects/kedai-ali-website', { linked: '' });
      const after = await req('POST', '/api/linked/remove', { path: ext });
      assert.deepStrictEqual(after.body, []);
      assert.ok(!T.officeRules(ext).some((x) => allow().includes(x)), 'unlinked folder rules are gone');
      assert.ok(T.officeRules(dir).every((x) => allow().includes(x)), 'office rules stay');
    });

    await test('staff commands: saved, shell tool only while on, Tools line kept in step', async () => {
      const r = await req('PUT', '/api/staff/aina', { commands: ['git', 'nope'], customCommands: ['php vendor/bin/pint'] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.commands, ['git']);
      assert.match(read('.claude/agents/aina.md'), /^tools: Read, Write, Edit, Glob, Grep, Bash$/m);
      assert.match(read('staff/aina/CLAUDE.md'), /^- Commands you may run, in the office or a linked folder: Office documents \(.*\); Git \(.*\); `php vendor\/bin\/pint`\./m);
      assert.strictEqual((await req('PUT', '/api/staff/aina', { customCommands: ['ls; rm -rf /'] })).status, 400);
      await req('PUT', '/api/staff/aina', { commands: [], customCommands: [] }); // Office documents stays on by default
      assert.match(read('.claude/agents/aina.md'), /Bash/);
      assert.match(read('staff/aina/CLAUDE.md'), /Commands you may run.*Office documents/);
      await req('PUT', '/api/staff/aina', { docs: false });
      assert.strictEqual(JSON.parse(read('office.json')).staff.find((x) => x.id === 'aina').docs, false);
      assert.doesNotMatch(read('.claude/agents/aina.md'), /Bash/);
      assert.doesNotMatch(read('staff/aina/CLAUDE.md'), /Commands you may run/);
      await req('PUT', '/api/staff/aina', { docs: true });
      assert.strictEqual(JSON.parse(read('office.json')).staff.find((x) => x.id === 'aina').docs, undefined);
      const T = require('../lib/templates');
      // model and effort: defaults, changed per staff and for the manager, used by the terminal subagent too
      let run = (await req('GET', '/api/run')).body;
      assert.deepStrictEqual(run.people.pa, { model: 'opus', effort: 'medium' });
      assert.deepStrictEqual(run.people.aina, { model: 'sonnet', effort: 'medium' });
      assert.match(read('.claude/agents/aina.md'), /^model: sonnet$/m);
      assert.strictEqual((await req('PUT', '/api/staff/aina', { model: 'haiku', effort: 'low' })).status, 200);
      assert.match(read('.claude/agents/aina.md'), /^model: haiku$/m);
      assert.strictEqual((await req('PUT', '/api/staff/aina', { model: 'gpt-9' })).status, 400);
      assert.strictEqual((await req('PUT', '/api/manager', { model: 'fable', effort: 'high' })).status, 200);
      run = (await req('GET', '/api/run')).body;
      assert.deepStrictEqual(run.people.pa, { model: 'fable', effort: 'high' });
      assert.strictEqual(JSON.parse(read('office.json')).pa.commands, undefined, 'nothing ticked: no commands key');
      assert.strictEqual((await req('PUT', '/api/manager', { commands: ['github', 'git'] })).status, 200);
      assert.deepStrictEqual(JSON.parse(read('office.json')).pa.commands, ['github']);
      assert.strictEqual((await req('PUT', '/api/manager', { model: 'fable' })).status, 200);
      assert.deepStrictEqual(JSON.parse(read('office.json')).pa.commands, ['github'], 'a model change keeps it');
      assert.strictEqual((await req('PUT', '/api/manager', { commands: [] })).status, 200);
      assert.strictEqual(JSON.parse(read('office.json')).pa.commands, undefined);
      assert.deepStrictEqual(run.people.aina, { model: 'haiku', effort: 'low' });
      assert.deepStrictEqual(T.runFlags(JSON.parse(read('office.json')), 'aina'), ['--model', 'haiku', '--effort', 'low']);
      await req('PUT', '/api/staff/aina', { model: 'default', effort: 'default' });
      assert.deepStrictEqual(T.runFlags(JSON.parse(read('office.json')), 'aina'), []);
      assert.match(read('.claude/agents/aina.md'), /^model: inherit$/m);
      // outside MCP servers: none without an add-on job; with one, the user's own servers but no claude.ai connectors
      const oc = JSON.parse(read('office.json'));
      assert.deepStrictEqual(T.mcpRun(oc, 'aina', true), { args: ['--strict-mcp-config'], env: {} });
      const withInv = { ...oc, addons: { 'invois-online': { enabled: true } } };
      assert.deepStrictEqual(T.mcpRun(withInv, 'pa', true), { args: [], env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } });
      assert.deepStrictEqual(T.mcpRun(withInv, 'pa', false), { args: [], env: {} }, 'only the connector: keep it');
      const settings = JSON.parse(read('staff/aina/.claude/settings.json'));
      assert.ok(settings.hooks.PreToolUse.some((e) => e.matcher === 'Bash' && /guard\.js"$/.test(e.hooks[0].command)), 'guard hook registered');
      assert.ok(fs.existsSync(path.join(dir, '.office/guard.js')));
    });

    await test('live stream says what changed', async () => {
      await new Promise((r) => setTimeout(r, 400)); // let earlier changes settle
      const got = await new Promise((resolve, reject) => {
        let t1, t2;
        const done = (fn, v) => { clearTimeout(t1); clearTimeout(t2); r.destroy(); fn(v); };
        const r = http.get({ host: '127.0.0.1', port, path: `/api/stream?key=${cfg.key}`, headers: { host: `localhost:${port}` } }, (res) => {
          let s = '';
          res.on('data', (d) => { s += d; const m = /event: changed\ndata: (.*)\n/.exec(s); if (m && JSON.parse(m[1]).includes('approvals')) done(resolve, JSON.parse(m[1])); });
          t1 = setTimeout(() => fs.writeFileSync(path.join(dir, 'approvals/x.md'), '---\nfrom: nurul\naction: Send invoice\nstatus: pending\n---\n'), 200);
        });
        r.on('error', () => {});
        t2 = setTimeout(() => done(reject, new Error('no change event')), 5000);
      });
      assert.ok(got.includes('approvals'));
    });

    await test('parallel limit: PUT /api/parallel saves it, bad values answer 400, GET /api/tasks shows it', async () => {
      const r = await req('PUT', '/api/parallel', { n: 2 });
      assert.deepStrictEqual(r.body, { maxParallel: 2 });
      assert.strictEqual(JSON.parse(read('office.json')).maxParallel, 2);
      for (const bad of [0, 'x']) { const b = await req('PUT', '/api/parallel', { n: bad }); assert.strictEqual(b.status, 400); assert.match(JSON.stringify(b.body), /Pick a number from 1 to 8/); }
      const t = await req('GET', '/api/tasks');
      assert.strictEqual(t.body.limit, 2); assert.ok(Array.isArray(t.body.waiting));
    });

    await test('agent teams: PUT /api/agent-teams adds and removes the root settings key, bad values answer 400', async () => {
      const rootSettings = () => JSON.parse(read('.claude/settings.json'));
      const r = await req('PUT', '/api/agent-teams', { on: true });
      assert.deepStrictEqual(r.body, { agentTeams: true });
      assert.strictEqual(rootSettings().env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
      assert.strictEqual((await req('GET', '/api/office')).body.agentTeams, true);
      const r2 = await req('PUT', '/api/agent-teams', { on: false });
      assert.deepStrictEqual(r2.body, { agentTeams: false });
      assert.ok(!rootSettings().env || !('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' in rootSettings().env));
      assert.strictEqual((await req('PUT', '/api/agent-teams', { on: 'yes' })).status, 400);
    });

    await test('a waiting task whose need was stopped is told to the manager once, in plain words', async () => {
      const put = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
      const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
      const lines = async () => (await req('GET', '/api/chat/pa')).body.messages.filter((m) => m.from === 'system' && m.kind === 'error' && m.task === 'b2');
      put('b1', 'staff: siti', 'LONG first part');
      await until(async () => (await req('GET', '/api/tasks')).body.active.some((a) => a.id === 'b1'));
      put('b2', 'staff: nurul\nneeds: b1', 'second part');
      await until(async () => (await req('GET', '/api/tasks')).body.waiting.some((w) => w.id === 'b2'));
      assert.strictEqual((await req('POST', '/api/tasks/b1/stop')).status, 200);
      await until(async () => (await lines()).length);
      await new Promise((r) => setTimeout(r, 600));
      const got = await lines();
      assert.strictEqual(got.length, 1);
      assert.strictEqual(got[0].text, 'Nurul\'s task "second part" is waiting for a task that was stopped ("LONG first part"). Press Run again on its row in the work board, or stop the waiting one.');
    });
    await test('a failed need: the manager is told who waits and how to retry; an unclaimed role task is named by its role', async () => {
      const put = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
      const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
      const lines = async (id) => (await req('GET', '/api/chat/pa')).body.messages.filter((m) => m.from === 'system' && m.kind === 'error' && m.task === id);
      const role = JSON.parse(read('office.json')).staff.find((s) => s.id === 'siti').role;
      put('b3', 'staff: ghost', 'will fail'); put('b4', `role: ${role}\nneeds: b3`, 'role part'); put('b5', 'staff: nurul\nneeds: b3', 'nurul part');
      await until(async () => (await lines('b4')).length && (await lines('b5')).length);
      const tail = 'is waiting for a task that failed ("will fail"). Press Run again on its row in the work board, or stop the waiting one.';
      assert.strictEqual((await lines('b4'))[0].text, `A task for the next free ${role} ("role part") ${tail}`);
      assert.strictEqual((await lines('b5'))[0].text, `Nurul's task "nurul part" ${tail}`);
      const prompts = () => fs.readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse);
      await until(async () => prompts().some((m) => m.includes('task b3')));
      assert.ok(prompts().find((m) => m.includes('task b3')).includes('Waiting for this task: b4, b5. To retry, write the new task with again: b3.'));
    });
    await test('project links: set only by the Projects page, adopted once for an older office', async () => {
      const O = require('../lib/office');
      const ext = path.join(tmp, 'proj link'); fs.mkdirSync(ext);
      const links = () => JSON.parse(read('office.json')).projectLinks || {};
      assert.strictEqual((await req('PUT', '/api/projects/kedai-ali-website', { linked: ext })).status, 200);
      assert.match(read('projects/kedai-ali-website/CLAUDE.md'), new RegExp(`^linked: ${ext.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`, 'm'));
      assert.strictEqual(links()['kedai-ali-website'], ext);
      assert.deepStrictEqual(O.listLinked(dir).map((l) => [l.project, l.ok]), [['kedai-ali-website', true]]);
      await req('PUT', '/api/projects/kedai-ali-website', { linked: '' });
      assert.ok(!('kedai-ali-website' in links())); assert.doesNotMatch(read('projects/kedai-ali-website/CLAUDE.md'), /^linked:[ \t]*\S/m);
      // an office from before: a project line, no projectLinksAdopted
      const d3 = path.join(tmp, 'office3'); G.writeOffice(d3, G.buildConfig({ company: 'Three', pa: 'Hana', staff: D.STAFF.slice(0, 1).map(({ name, role, job }) => ({ name, role, job })) }));
      const f3 = path.join(d3, 'office.json'), c3 = JSON.parse(fs.readFileSync(f3, 'utf8')); assert.strictEqual(c3.projectLinksAdopted, true, 'a new office needs no adoption');
      delete c3.projectLinksAdopted; fs.writeFileSync(f3, JSON.stringify(c3));
      const p3 = O.createProject(d3, { title: 'Old shop' });
      fs.writeFileSync(path.join(d3, 'projects', p3.id, 'CLAUDE.md'), `---\nlinked: ${ext}\n---\n# Old shop\n`);
      assert.deepStrictEqual(G.linkedFolders(d3), [], 'not adopted yet: not trusted');
      assert.deepStrictEqual(O.adoptProjectLinks(d3), [p3.id]);
      assert.deepStrictEqual(G.linkedFolders(d3).map((l) => l.project), [p3.id]);
      const p4 = O.createProject(d3, { title: 'Sneaky' });
      fs.writeFileSync(path.join(d3, 'projects', p4.id, 'CLAUDE.md'), `---\nlinked: ${ext}\n---\n# Sneaky\n`);
      assert.deepStrictEqual(O.adoptProjectLinks(d3), [], 'adopts once');
      assert.deepStrictEqual(G.linkedFolders(d3).map((l) => l.project), [p3.id]);
    });
    await test('a change to office.json is picked up by waiting tasks at once', async () => {
      // its own fresh office: on Linux, Node's recursive watch can lose a file after it was swapped in once
      const dir2 = path.join(tmp, 'office2'); G.writeOffice(dir2, G.buildConfig({ company: 'Two', pa: 'Hana', staff: D.STAFF.slice(0, 2).map(({ name, role, job }) => ({ name, role, job })) }));
      const srv2 = createServer(dir2); await srv2.listen(0);
      const t2 = (id) => { try { return fs.readFileSync(path.join(dir2, 'tasks', `${id}.md`), 'utf8'); } catch { return ''; } };
      const until = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
      try {
        const f = path.join(dir2, 'office.json'), oc = JSON.parse(fs.readFileSync(f, 'utf8')), role = oc.staff.find((s) => s.id === 'aina').role;
        fs.writeFileSync(path.join(dir2, 'tasks', 'w1.md'), '---\nstaff: aina\nstatus: new\n---\nLONG busy\n');
        fs.writeFileSync(path.join(dir2, 'tasks', 'w2.md'), `---\nrole: ${role}\nstatus: new\n---\nfor the role\n`);
        await until(() => /status: working/.test(t2('w1')));
        await new Promise((r) => setTimeout(r, 500)); // let the start settle, so only office.json changes now
        fs.writeFileSync(f, JSON.stringify({ ...oc, staff: oc.staff.map((s) => (s.id === 'aina' ? { ...s, role: 'Gone' } : s)) }, null, 2));
        await until(() => t2('w2').includes(`There is no active staff with the role "${role}".`), 30); // well before w1 ends (5 s)
      } finally { await srv2.close(); await new Promise((r) => setTimeout(r, 300)); }
    });
    await test('archiving the only staff with a role fails a task waiting for that role at once, with no file watch needed', async () => {
      const put = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
      const until = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
      const role = JSON.parse(read('office.json')).staff.find((s) => s.id === 'nurul').role;
      put('v1', 'staff: nurul', 'LONG busy'); put('v2', `role: ${role}`, 'for the role');
      await until(async () => (await req('GET', '/api/tasks')).body.active.some((a) => a.id === 'v1'));
      await until(async () => (await req('GET', '/api/tasks')).body.waiting.some((w) => w.id === 'v2'));
      assert.strictEqual((await req('POST', '/api/staff/nurul/archive')).status, 200);
      assert.strictEqual(read('tasks', 'v2.md').match(/There is no active staff with the role "[^"]+"\./)?.[0], `There is no active staff with the role "${role}".`);
      await req('POST', '/api/tasks/v1/stop');
      await until(async () => !(await req('GET', '/api/tasks')).body.active.length);
      assert.strictEqual((await req('POST', '/api/staff/nurul/reactivate')).status, 200);
      await new Promise((r) => setTimeout(r, 600)); // let the file watch settle before the office is removed
    });
    await test('add staff: a software office gets the software text, the default rules and commands; a business office is unchanged', async () => {
      const O = require('../lib/office'), T = require('../lib/templates');
      const sdir = path.join(tmp, 'soft');
      G.writeOffice(sdir, G.buildConfig({ company: 'Acme Labs', pa: 'Hana', type: 'software', staff: D.SOFTWARE_STAFF.slice(0, 2).map(({ name, role, job }) => ({ name, role, job })) }));
      const sread = (...q) => fs.readFileSync(path.join(sdir, ...q), 'utf8');
      const arif = D.SOFTWARE_STAFF.find((d) => d.name === 'Arif');
      O.addStaff(sdir, { name: 'Arif', role: 'DevOps Engineer', job: arif.job });
      const t = sread('staff/arif/CLAUDE.md');
      assert.match(t, /deploy, publish a package, delete data, change a live setting or a secret/);
      assert.doesNotMatch(t, /discount or refund/);
      for (const r of arif.rules) assert.ok(t.includes(`- ${r}`), r);
      assert.match(t, /^- Commands you may run/m);
      assert.deepStrictEqual(JSON.parse(sread('office.json')).staff.find((s) => s.id === 'arif').commands, ['git', 'node']);
      assert.match(sread('.claude/agents/arif.md'), /^tools: .*\bBash\b/m);
      O.addStaff(sdir, { name: 'Ali', role: 'backend engineer', job: 'APIs' }); // renamed: the role default still counts
      assert.deepStrictEqual(JSON.parse(sread('office.json')).staff.find((s) => s.id === 'ali').commands, ['git', 'node']);
      assert.ok(sread('staff/ali/CLAUDE.md').includes('- Commit small, with a message that says why.'));
      // business: exactly what the add gave before
      const bdir = path.join(tmp, 'biz');
      const bcfg = G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 2).map(({ name, role, job }) => ({ name, role, job })) });
      G.writeOffice(bdir, bcfg);
      const farah = D.STAFF.find((d) => d.name === 'Farah');
      O.addStaff(bdir, { name: 'Farah', role: 'Marketing', job: farah.job });
      const oc = JSON.parse(fs.readFileSync(path.join(bdir, 'office.json'), 'utf8'));
      const s = { id: 'farah', name: 'Farah', role: 'Marketing', job: farah.job, colour: oc.staff[2].colour, rules: farah.rules, look: farah.look };
      const full = { company: bcfg.company, pa: oc.pa, addons: oc.addons, staff: [...oc.staff.slice(0, 2), s] };
      assert.strictEqual(fs.readFileSync(path.join(bdir, 'staff/farah/CLAUDE.md'), 'utf8'), T.staffClaude(full, s));
      assert.strictEqual(fs.readFileSync(path.join(bdir, '.claude/agents/farah.md'), 'utf8'), T.agentMd(full, s));
      assert.deepStrictEqual(oc.staff[2], { id: 'farah', name: 'Farah', role: 'Marketing', colour: s.colour, look: farah.look });
    });
    await test('staff commandMode: Auto stored, lines and Bash follow, Listed restores the same text, bad value 400, manager ignores it', async () => {
      const id = 'siti', rd = () => read('staff/siti/CLAUDE.md'), agent = () => read('.claude/agents/siti.md');
      const co = () => JSON.parse(read('office.json')).staff.find((x) => x.id === id);
      await req('PUT', `/api/staff/${id}`, { commands: ['git'], docs: true });
      const before = rd(), agentBefore = agent();
      assert.match(before, /^- Commands you may run/m);
      let r = await req('PUT', `/api/staff/${id}`, { commandMode: 'auto' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.commandMode, 'auto');
      assert.strictEqual(co().commandMode, 'auto'); assert.deepStrictEqual(co().commands, ['git'], 'ticks are kept');
      assert.match(rd(), /^- Commands: you may run.*Claude Code checks each command and may refuse it/m); assert.doesNotMatch(rd(), /^- Commands you may run/m);
      assert.match(agent(), /^tools: .*\bBash\b/m);
      await req('PUT', `/api/staff/${id}`, { commands: ['git'] }); await req('PUT', `/api/staff/${id}`, { commands: ['git'] }); // saving again does not add the line again
      assert.strictEqual(rd().match(/^- Commands: you may run/gm).length, 1);
      await req('PUT', `/api/staff/${id}`, { commands: [], customCommands: [], docs: false }); // Auto with nothing ticked still has Bash
      assert.match(agent(), /^tools: .*\bBash\b/m); assert.match(rd(), /^- Commands: you may run/m);
      await req('PUT', `/api/staff/${id}`, { commands: ['git'], docs: true });
      assert.strictEqual((await req('GET', `/api/staff/${id}`)).body.commandMode, 'auto');
      r = await req('PUT', `/api/staff/${id}`, { commandMode: 'listed' });
      assert.strictEqual(r.body.commandMode, 'listed'); assert.strictEqual(co().commandMode, undefined);
      assert.strictEqual(rd(), before); assert.strictEqual(agent().match(/^tools: .*$/m)[0], agentBefore.match(/^tools: .*$/m)[0]);
      r = await req('PUT', `/api/staff/${id}`, { commandMode: 'yes' });
      assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'Commands can be "listed" or "auto".');
      assert.strictEqual((await req('PUT', '/api/manager', { commandMode: 'auto' })).status, 200);
      assert.strictEqual(JSON.parse(read('office.json')).pa.commandMode, undefined);
    });
    await test('jobs: a job task end adds a chat line but wakes no manager; the job reaching done wakes it once; GET /api/jobs counts tasks', async () => {
      const { Jobs } = require('../lib/jobs');
      const dir4 = path.join(tmp, 'office4'); const cfg4 = G.buildConfig({ company: 'Four', pa: 'Hana', staff: D.STAFF.slice(0, 3).map(({ name, role, job }) => ({ name, role, job })) }); G.writeOffice(dir4, cfg4);
      const req4 = (m, u) => req(m, u, null, { 'x-office-key': cfg4.key });
      const srv4 = createServer(dir4), p0 = port; port = await srv4.listen(0);
      const until = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
      const prompts = () => fs.readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse);
      try {
        fs.writeFileSync(path.join(dir4, 'jobs', 'j9.md'), '---\nproject:\nstatus: approved\n---\nLogin page\n\nSpec\n');
        await until(async () => (await req4('GET', '/api/jobs')).body.some((j) => j.id === 'j9'));
        const j = (await req4('GET', '/api/jobs')).body.find((x) => x.id === 'j9');
        assert.deepStrictEqual([j.title, j.status, j.done, j.total], ['Login page', 'planned', 0, 0]);
        const mk = (id, head, text) => fs.writeFileSync(path.join(dir4, 'tasks', `${id}.md`), `---\n${head}\nstatus: new\n---\n${text}\n`);
        mk('k1', 'staff: siti\njob: j9', 'part one'); mk('k2', 'staff: nurul\njob: j9\nneeds: k1', 'part two');
        await until(async () => (await req4('GET', '/api/tasks')).body.waiting.some((w) => w.id === 'k2'));
        assert.strictEqual((await req4('GET', '/api/tasks')).body.waiting.find((w) => w.id === 'k1').reason, "Waiting for the boss's OK on the plan");
        const before = prompts().length;
        new Jobs(dir4).setStatus('j9', 'approved'); mk('k3', 'staff: siti\njob: j9\nneeds: k2', 'part three'); // a change in tasks/ makes the office look again
        await until(async () => (await req4('GET', '/api/jobs')).body.find((x) => x.id === 'j9').status === 'done', 150);
        await until(() => prompts().some((m) => m.includes('The job "Login page" is done.')));
        await new Promise((r) => setTimeout(r, 500));
        const fresh = prompts().slice(before), wakes = fresh.filter((m) => m.startsWith('[Office update'));
        assert.strictEqual(wakes.length, 1, `one manager run, got ${wakes.length}`);
        assert.match(wakes[0], /^\[Office update, not from the boss\] The job "Login page" is done\.\n- Siti, "part one": done\./);
        assert.ok(wakes[0].includes('- Nurul, "part two": done.') && wakes[0].includes('hand it out with a task file.'));
        const lines = (await req4('GET', '/api/chat/pa')).body.messages.filter((m) => m.task === 'k1' && m.from === 'system');
        assert.ok(lines.some((m) => m.done && /finished: part one/.test(m.text)), 'the chat line for a job task is still added');
        const j2 = (await req4('GET', '/api/jobs')).body.find((x) => x.id === 'j9');
        assert.deepStrictEqual([j2.done, j2.total], [3, 3]);
        // a job whose last task was asked by a staff: the asking staff hears as today, and the manager hears the job is done
        fs.writeFileSync(path.join(dir4, 'jobs', 'j10.md'), '---\nproject:\n---\nSecond job\n');
        await until(async () => (await req4('GET', '/api/jobs')).body.some((x) => x.id === 'j10'));
        new Jobs(dir4).setStatus('j10', 'approved');
        const before2 = prompts().length;
        mk('m1', 'staff: nurul\nfrom: siti\njob: j10', 'ask nurul');
        await until(async () => (await req4('GET', '/api/jobs')).body.find((x) => x.id === 'j10').status === 'done', 150);
        await until(() => prompts().slice(before2).some((m) => m.includes('your request m1')));
        await new Promise((r) => setTimeout(r, 500));
        const fresh2 = prompts().slice(before2);
        assert.strictEqual(fresh2.filter((m) => m.includes('The job "Second job" is done.')).length, 1, 'one manager run with the job text');
        assert.strictEqual(fresh2.filter((m) => m.includes('your request m1')).length, 1, 'the asking staff is told as before');
      } finally { await srv4.close(); port = p0; await new Promise((r) => setTimeout(r, 300)); }
    });
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${n} server tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
