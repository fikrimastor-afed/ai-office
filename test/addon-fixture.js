// Builds the Invois-only output snapshot used by test/addons.test.js.
// Regenerate (only when Invois behaviour changes on purpose): node test/addon-fixture.js > test/fixtures/invois-baseline.json
const G = require('../lib/generate');
const T = require('../lib/templates');

const roles = ['Sales', 'Finance', 'Accountant', 'Admin', 'Solution Architect', 'Senior Software Engineer', 'Software Engineer', 'QA Tester', 'UI/UX Designer'];
function build() {
  const cfg = G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', invois: true, staff: roles.map((role, i) => ({ name: `P${i}`, role, job: 'Does the work' })) });
  cfg.key = 'k'; cfg.created = 'x';
  const out = { addons: cfg.addons, who: {} };
  for (const who of ['pa', ...cfg.staff.map((s) => s.id)]) {
    const s = cfg.staff.find((x) => x.id === who);
    const alw = { ...cfg, addons: { 'invois-online': { ...cfg.addons['invois-online'], always: ['send_invoice_email'] } } };
    out.who[who] = {
      allowed: T.addonAllowed(cfg, who), allowedAlways: T.addonAllowed(alw, who), actions: T.addonActions(cfg, who),
      mcp: T.mcpRun(cfg, who, true), mcpNo: T.mcpRun(cfg, who, false),
      ...(s ? { claude: T.staffClaude(cfg, s), agent: T.agentMd(cfg, s) } : {}),
    };
  }
  return out;
}
module.exports = { build, roles };
if (require.main === module) console.log(JSON.stringify(build(), null, 1));
