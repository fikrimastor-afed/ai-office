// Defaults used by the wizard. Every answer can be changed later in the dashboard
// or by editing the files in the office folder.

const COMPANY = 'My Company Sdn Bhd';
const FOLDER = 'my-company';
const PA = { name: 'Hana', colour: '#8338EC', look: { scarf: true, skin: '#F2C9A0' } };
// Avatar look for staff the user invents (they can change it in the dashboard).
const LOOK = { scarf: false, skin: '#E8B98A', hair: '#2B2233' };
const STAFF_COUNT = 4;
const PORT = 4747;

const STAFF = [
  {
    name: 'Aina', role: 'Customer Service', colour: '#FF6B6B',
    look: { scarf: true, skin: '#F3C7A2' },
    job: 'Answer enquiries, FAQ and product info. Read the inbox first. Pass bigger jobs on.',
    rules: [
      'Reply politely, in the language the customer used.',
      'Check inbox/ for new items before anything else.',
      'Quotes, invoices and tech problems go back to the PA, so the right staff takes them.',
    ],
  },
  {
    name: 'Siti', role: 'Sales', colour: '#FF9F1C',
    look: { scarf: true, skin: '#EDB98A' },
    job: 'Quotes from the price list, follow up leads, take orders.',
    rules: [
      'Reply to new leads fast.',
      'Use the price the boss gives, or the one in price-list.md in your folder. Never invent a price.',
      'Ask the boss before any discount.',
    ],
  },
  {
    name: 'Nurul', role: 'Finance', colour: '#2EC4B6',
    look: { scarf: true, skin: '#F5D0AE' },
    job: 'Invoices, payments, monthly report.',
    rules: [
      'An invoice must match the agreed quote.',
      'Never mark a payment as received without proof.',
      'Ask the boss before sending an invoice or recording a payment.',
    ],
  },
  {
    name: 'Ahmad', role: 'Tech', colour: '#3A86FF',
    look: { scarf: false, skin: '#E3AE7C', hair: '#2B2233' },
    job: 'Website, fix bugs, small tools.',
    rules: [
      'Explain changes in plain words.',
      'Test before you say it is done.',
      'Ask the boss before publishing anything live.',
    ],
  },
  {
    name: 'Farah', role: 'Marketing', colour: '#06D6A0',
    look: { scarf: true, skin: '#F1C27D' },
    job: 'Social media posts, promos, captions.',
    rules: [
      'Keep the brand voice friendly and short.',
      'Prepare drafts. Never post publicly yourself.',
      'Ask the boss before any promo or price is announced.',
    ],
  },
  {
    name: 'Mei Ling', role: 'Operations', colour: '#F15BB5',
    look: { scarf: false, skin: '#F7D7B5', hair: '#1A1A1A' },
    job: 'Orders, stock, delivery schedule.',
    rules: [
      'Keep the order and stock lists up to date.',
      'Flag low stock early.',
      'Ask the boss before cancelling or changing a confirmed order.',
    ],
  },
  {
    name: 'Kumar', role: 'HR', colour: '#8D6E63',
    look: { scarf: false, skin: '#A8724A', hair: '#1A1A1A' },
    job: 'Staff schedule, leave, job posts.',
    rules: [
      'Keep staff data private.',
      'Use the schedule and leave files in your folder.',
      'Ask the boss before posting a job ad.',
    ],
  },
  {
    name: 'Daniel', role: 'Admin', colour: '#118AB2',
    look: { scarf: false, skin: '#F0C8A0', hair: '#6B4423' },
    job: 'Documents, letters, filing.',
    rules: [
      'Name documents by date so they sort well.',
      'Never delete files. Move old ones to an archive folder.',
      'Ask the boss before sending any official letter.',
    ],
  },
];

// Rules for staff the user invents (no default to copy from).
const GENERIC_RULES = [
  'Keep your work files in your own folder.',
  'Say plainly when something is unclear, instead of guessing.',
];

// Invois Online: optional add-on. Tool names are the MCP server's own.
const INVOIS = {
  id: 'invois-online',
  name: 'Invois Online',
  mcpName: 'invois.online', // how the wizard says it
  ask: 'Do you send quotations or invoices? Connect the invois.online MCP so your sales and finance staff\n    make real ones (free plan: 60 documents a month)',
  url: 'https://mcp.invois.online',
  site: 'https://invois.online/?ref=ai-office',
  // The same server can also come from the user's claude.ai connector, under this name.
  // Tool names differ (mcp__claude_ai_Invois_Online__get_quotations), so the office allows both.
  aliases: ['claude_ai_Invois_Online'],
  // role match -> tools, and which of them always need the boss's OK
  roles: [
    {
      match: /sales/i,
      what: 'quotations',
      tools: ['get_companies', 'get_clients', 'get_client', 'search_clients', 'create_client',
        'get_quotations', 'get_quotation', 'create_quotation', 'update_quotation', 'send_quotation_email'],
      askFirst: ['send_quotation_email'],
    },
    {
      match: /financ|account/i,
      what: 'invoices and payments',
      tools: ['get_companies', 'get_clients', 'get_client', 'search_clients', 'get_quotations', 'get_quotation',
        'convert_quotation_to_invoice', 'get_invoices', 'get_invoice', 'create_invoice', 'update_invoice',
        'send_invoice_email', 'get_payments', 'create_payment', 'get_bank_accounts'],
      askFirst: ['send_invoice_email', 'create_payment'],
    },
  ],
};

// Role matches for the software office. Deterministic: "Senior Software Engineer" is a senior, never a plain
// engineer (SE excludes "senior"), so the result does not depend on block order.
const R = {
  sa: /architect/i,
  sse: /senior.*(software engineer|developer)/i,
  se: /^(?!.*senior).*(software engineer|developer)/i,
  qa: /\bqa\b|tester|quality/i,
  ux: /\bux\b|designer/i,
};

// GitHub, read-only v1: the /readonly URL only serves read tools, so write tools do not exist yet.
// askFirst still lists the write tools, so a later write mode (second id, plain /mcp/ URL) is gated from day one.
// All GitHub tool names: unverified tool name (the server needs a login, so tools/list could not be read).
const GITHUB_READ = ['get_file_contents', 'list_commits', 'get_commit', 'search_code', 'search_repositories', // unverified tool name
  'list_issues', 'issue_read', 'search_issues', 'list_pull_requests', 'pull_request_read', 'actions_get', 'actions_list']; // unverified tool name
const GITHUB_ASK = ['merge_pull_request', 'push_files', 'create_or_update_file', 'delete_file', 'delete_repository', // unverified tool name
  'create_repository', 'actions_run_trigger', 'pull_request_review_write', 'update_pull_request_branch', // unverified tool name
  'create_pull_request', 'update_pull_request']; // unverified tool name
const GITHUB = {
  id: 'github',
  name: 'GitHub',
  url: 'https://api.githubcopilot.com/mcp/readonly',
  site: 'https://github.com/github/github-mcp-server',
  aliases: ['claude_ai_GitHub'], // unverified tool name (connector name from memory)
  ask: 'Do your staff work from GitHub? Connect the GitHub MCP (read-only: code, issues, pull requests) for your\n    engineers, architect and QA',
  paTools: GITHUB_READ,
  roles: [
    { match: R.sse, what: 'code, issues and pull requests (read only)', tools: GITHUB_READ, askFirst: GITHUB_ASK },
    { match: R.se, what: 'code, issues and pull requests (read only)', tools: GITHUB_READ, askFirst: GITHUB_ASK },
    { match: R.qa, what: 'issues and pull requests (read only)', tools: GITHUB_READ, askFirst: [...GITHUB_ASK, 'issue_write', 'add_issue_comment'] }, // unverified tool name
    { match: R.sa, what: 'issues and pull requests (read only)', tools: GITHUB_READ, askFirst: [...GITHUB_ASK, 'issue_write', 'add_issue_comment'] }, // unverified tool name
  ],
};

// Figma: UI/UX writes to the boss's own drafts; engineers and the architect only read.
// All Figma tool names: unverified tool name (the server needs a login, so tools/list could not be read).
const FIGMA_READ = ['get_design_context', 'get_metadata', 'get_screenshot', 'get_variable_defs', 'get_comments', 'search_design_system']; // unverified tool name
// Every Figma write tool is ask-first (the plan lists use_figma and send_code_to_figma; generate_figma_design is added as a write tool too).
const FIGMA_ASK = ['use_figma', 'send_code_to_figma', 'generate_figma_design']; // unverified tool name
const FIGMA = {
  id: 'figma',
  name: 'Figma',
  url: 'https://mcp.figma.com/mcp',
  site: 'https://www.figma.com/',
  aliases: ['claude_ai_Figma'], // unverified tool name (connector name from memory)
  ask: 'Do you design in Figma? Connect the Figma MCP so your designer can work in it and engineers can read the designs',
  paTools: FIGMA_READ,
  roles: [
    { match: R.ux, what: 'designs', tools: [...FIGMA_READ, 'generate_figma_design', 'use_figma'], askFirst: FIGMA_ASK }, // unverified tool name
    { match: R.sse, what: 'designs (read only)', tools: FIGMA_READ, askFirst: FIGMA_ASK },
    { match: R.se, what: 'designs (read only)', tools: FIGMA_READ, askFirst: FIGMA_ASK },
    { match: R.sa, what: 'designs (read only)', tools: FIGMA_READ, askFirst: FIGMA_ASK },
  ],
};

// Context7: current library docs for every role, read only. Tool names confirmed with tools/list (2026-11-27).
const CONTEXT7_TOOLS = ['resolve-library-id', 'query-docs'];
const CONTEXT7 = {
  id: 'context7',
  name: 'Context7',
  noLogin: true,
  url: 'https://mcp.context7.com/mcp',
  site: 'https://context7.com/',
  aliases: ['claude_ai_Context7'],
  ask: 'Do your staff write code against libraries? Connect the Context7 MCP (current library docs, read only, no login)',
  paTools: CONTEXT7_TOOLS,
  roles: [{ match: /./, what: 'library documentation (read only)', tools: CONTEXT7_TOOLS, askFirst: [] }],
};

// Every add-on. All are opt-in: nothing is on until the boss turns it on (office.json addons[id].enabled).
const ADDONS = [INVOIS, GITHUB, FIGMA, CONTEXT7];
// The role block a person gets from an add-on: the first that matches, or null.
const addonRole = (addon, role) => addon.roles.find((r) => r.match.test(role)) || null;

// Which Claude model and effort each person runs on (Staff page). "default" = whatever the user's Claude Code uses.
const MODELS = [['default', 'Claude Code default'], ['fable', 'Fable (most capable, uses the most)'], ['opus', 'Opus (strong)'], ['sonnet', 'Sonnet (balanced)'], ['haiku', 'Haiku (fast, light)']];
const EFFORTS = [['default', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const RUN = { pa: { model: 'opus', effort: 'medium' }, staff: { model: 'sonnet', effort: 'medium' } }; // until the boss changes it

module.exports = { LOOK, COMPANY, FOLDER, PA, STAFF, STAFF_COUNT, PORT, GENERIC_RULES, INVOIS, GITHUB, FIGMA, CONTEXT7, ADDONS, addonRole, MODELS, EFFORTS, RUN };
