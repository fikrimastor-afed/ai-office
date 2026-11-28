# AI Office

Your own AI office staff, working on your computer with your own Claude account.

You talk to one manager. The manager hands the work to the right staff (sales, finance, marketing,
customer service, admin, tech), checks the result and reports back. You watch it all happen in a live
office in your browser, and you approve anything important before it leaves the office.

![The AI Office dashboard: a live 3D office, the work board, the chat with the manager and the usage bar](docs/images/office.jpg)

**Status: beta (v0.1).** Tested on Windows and on Linux (also inside WSL). Mac should work but is not tested yet.

## What your staff can do

| Ask for | You get |
|---|---|
| A sales deck, a training deck | A real PowerPoint file (`.pptx`) with slides, charts, tables and pictures |
| A sales report, a price list, an invoice list | A real Excel file (`.xlsx`) with formulas and formatting |
| A letter, meeting notes, a proposal | A real Word file (`.docx`) |
| A quotation, a flyer, a report to print | A PDF |
| A poster, a social media post, a banner, a chart | A PNG picture, designed by the staff (Claude does not paint photos, but it designs well) |
| Replies to customers, follow-ups, summaries | Drafts in the office, sent only when you say OK |
| Work in your own folders (a website, a shop) | Edits in folders you link, with the commands you allow |

![A poster and a PowerPoint deck made by the Sales staff from one request](docs/images/made-by-staff.jpg)

File paths in the chat are links: click one and the file opens in its app (PowerPoint, Excel, your browser).

## Software house

Choose "software" at setup (right after the company name) and the office is a software team instead of a
business team. The manager becomes your tech lead, and the default team is Zara (Product Analyst), Irfan
(Backend Engineer), Wei Jie (Frontend Engineer), Priya (QA Engineer) and Hakim (Reviewer). Arif (DevOps
Engineer) and Sofia (Designer) are optional. The type cannot be changed later.

- The code lives in a linked project folder, not inside the office. Engineers start with Git and npm commands ticked, the Reviewer with Git.
- The tech lead can look up a GitHub issue, pull request or project item by number, read only. It is a tick box on the manager's card (on in a software office), works in the dashboard chat and needs `gh` logged in.
- Staff cannot push or publish. You do that yourself, in your own terminal.
- In a terminal, Claude Code agent teams are on by default (experimental; switch in Settings > General). Your own Claude skills work as usual there.
- Coming next: reviews and tests enforced by the office, one branch per task, budgets, pushing after your approval. For now the tech lead is told to add a QA task and a Reviewer task, but nothing forces it.

## What you need

- [Claude Code](https://claude.com/claude-code), logged in with your Claude account (Pro or Max).
- Optional: the GitHub `gh` tool, logged in, so the manager can look up an issue or pull request by number (software house).
- Nothing else. The installer finds Node.js or puts a private copy in your home folder, and the office
  installs its own document tools the first time it starts.

## Install

**Let Claude do it (easiest).** Open Claude Code and paste:

```
Install AI Office for me: https://raw.githubusercontent.com/epool86/ai-office/main/INSTALL.md
```

Claude asks you a few questions one at a time (company name, folder, your manager's name, which staff),
creates your office folder and opens the dashboard. You only answer and say OK.

**Or in a terminal**, with Node.js 18 or newer:

```
npx github:epool86/ai-office
```

Next time, double-click **Start AI Office** in your office folder (on Linux and WSL: run `./start-office.sh`).
The dashboard opens at http://localhost:4747.

## Using it

| Where | What |
|---|---|
| **Office** | The live office. Who is working, on what, and who waits for you. The work board (top left) lists every running task with a Stop button, and the tasks that are waiting (for other tasks, a free staff or a free place) with the reason. |
| **Chat** (bottom right) | Talk to the manager, or to any staff directly. The manager gets a summary of direct chats. |
| **Needs your OK** (top right) | Anything that leaves the office (sending an email, a quotation, recording a payment) waits here for Approve or Reject. You can set an action to Always allow. |
| **Staff** | Each person's job, rules, look, model and effort, and the commands they may run. |
| **Projects, Inbox** | One folder per project with its own notes; customer requests waiting for the team. |
| **Usage bar** (bottom left) | Your Claude plan use: the 5-hour and weekly limits, when they reset, and tokens per person today. |

You can also run `claude` in the office folder and talk to the manager in the terminal. Same office, same files.

![Staff settings: job, look, model, effort and allowed commands](docs/images/staff.jpg)

## What it costs

AI Office is free. The work runs on your own Claude plan, like any Claude Code use, and the usage bar shows
how much you have used. To keep it light:

- The manager runs on Opus and the staff on Sonnet, at medium effort. Change it per person on the Staff page.
- Runs only load the tools that person needs, and long chats start fresh with a short recap.

As an example, the poster and deck above (manager plus one staff, start to finish) used about $0.30 of
Claude usage at API prices. On a Claude subscription you are not billed this; it counts toward your plan's limits.

## What staff can and cannot touch

| | |
|---|---|
| Files | Only the office folder and folders you link (Settings, or per project). Everything else is refused. |
| Office rules | Staff cannot change their own rules, the office settings or the approvals log. |
| Commands | Only what you tick per staff (git, npm, pnpm, Yarn, Python, Go, Rust, composer, Laravel, Office documents; GitHub read only for the manager), checked by a small guard script before every command, and only in the office or a linked folder. Never from the dashboard: `git push`, `reset --hard`, deleting with `rm`, `curl`, `sudo` and similar. |
| Office documents | Staff may run `node` only on a script saved inside the office. |
| Actions that leave the office | Ask first by default (Needs your OK). |
| Your data | Stays in your office folder. The dashboard listens on your own computer only (localhost). AI Office stores no logins or passwords. |

The guard and the hooks are short, readable files in your office folder (`.office/guard.js`, `.office/hook.js`).

## Make it yours

The office is plain files you can read and edit: the manager's instructions (`CLAUDE.md`), one folder per
staff, `inbox/`, `approvals/`, `projects/` and `tasks/`. `OFFICE.md` in your office explains every part, so
your own Claude can extend it: connect email, WhatsApp, your shop or any API, or add a new kind of approval.

**Optional add-on: [Invois Online](https://invois.online/?ref=ai-office).** Connect it during setup and your sales and
finance staff make real quotations, invoices and payments in your Invois Online account. Sending and
recording always ask you first.

## License

MIT. See [LICENSE](LICENSE).
