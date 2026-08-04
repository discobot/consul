# council

A [pi](https://pi.dev) extension that turns development into a launch-committee process:
you set a task, an **Owner** agent completes it, and a panel of transient **Verifiers**
gives go / no-go verdicts at the design gate and the implementation gate. Nothing passes a
gate without a full set of fresh GO verdicts — freshness is pinned to content hashes, so
any change (including a requirement you append mid-task) automatically stales the
approvals it invalidates.

See [DESIGN.md](DESIGN.md) for the full design.

## Usage

The dedicated launcher starts pi with the extension and the council TUI skin
(branded header with the live task, committee working indicator) preloaded:

```bash
council/bin/council            # Owner session; uses `pi` from PATH
council/bin/council board      # separate disk-driven cockpit + supervised RPC Owner
council/bin/council reset      # wipe process state, reseed the task, judges-first pass
COUNCIL_PI=/path/to/pi/dist/cli.js council/bin/council
```

Any arguments pass through to pi (`--model`, `--provider`, …). Alternatively load the
extension into a plain pi session:

```bash
# one-off
pi -e /path/to/council/index.ts

# or install into a project (auto-loads, hot-reloadable)
ln -s /path/to/council your-project/.pi/extensions/council
```

Then, in a git repository with at least one commit:

- **Your first message is the task.** It becomes the immutable task statement; the Owner
  derives requirements, designs, sources the design gate, implements, sources the
  implementation gate, and completes.
- **Later messages append requirements** (or ask to kill). You cannot reword the task —
  kill it with `/task-kill` (`/task kill` remains an alias) and start over.
- **`council reset` starts over, judges first.** It wipes the process state (verdicts,
  sessions, ledgers — config stays), reseeds the same statement and requirements as a
  fresh task, carries the previous design forward verbatim, and — before any Owner
  exists — runs the full design panel plus the Clerk headlessly. Then start
  `council board`: the Owner wakes into a sourced gate and an open-items ledger.
  `--no-judges` skips the panel pass.
- **Everything is resumable.** All task state lives on disk and verdicts are pinned to
  content hashes, so quitting and restarting loses nothing — held gates stay held.
  `council -r` (or `--resume`) opens pi's session picker — pick one, press enter, and it
  resumes right there: an interactive session opened over an active task nudges the Owner
  to continue automatically (no requirement is appended, so no approvals stale).
  `council -c` resumes the latest session the same way, and `/task-resume` re-sends the
  nudge manually. The auto-nudge never fires for the board's supervised Owner, and it
  stands down when another live Owner is already heartbeating on the task.
- **Watch progress** in the status widget above the editor, or with `/task` for the full
  report (requirements, per-verifier gate states, blocking comments, and spend), or run
  `council board` for the dedicated cockpit. The board reads disk state, supervises an RPC
  Owner, and sends append/kill actions through that Owner—it never edits task files. It is
  a full-screen, keyboard-navigable TUI: the task, both gates, blockers, running children,
  and spend are collapsible tree sections with colored ✓/✗/⚠/○ verifier states and a live
  spinner while reviews run. Healthy sections fold to one line (a holding gate is a single
  `✓ HOLDS` row, blockers fold to their count) so hard tasks stay on one screen; NO-GO
  verifiers preview their first comment and expand to the full text, and the activity
  section always shows the Owner's pulse (run count, last finished turn) beside any
  running children. Verifier rows, requirements, and blockers carry timestamps (blockers
  show the time of the verdict that raised them, and are marked when that verdict is
  stale). Tab switches to a Runs view: the recent worker and verifier runs from the spend
  ledger — status, time, and cost, newest first. Content is capped at a readable 120
  columns on ultra-wide terminals. Move with ↑/↓ (or j/u), toggle with Enter/Space,
  fold with ←/→ (← climbs to the parent), page with PgUp/PgDn, jump with g/G, `a` to
  append, `k` to kill with confirmation, and q/Esc to close. State is plain files under
  `.pi/council/tasks/<id>/`, including verdict, activity, status, and spend projections.

## The verifier panel

The nine built-ins are `clean-code`, `interfaces`, `user-local-pov`, `user-global-pov`,
`design`, and `task-completeness` (both gates), plus `ux-bugs`, `visual-design`, and
`github-clarity` (implementation gate only). `design` reviews intended design and
information design at both gates, including implementation adherence; `visual-design`
separately reviews the perceptual quality and consistency of the rendered implementation.
Each query runs the verifier afresh and stateless: its system prompt and repo/task context
only — no memory of its own prior verdicts and no other agents' negotiation, so every round
is fresh eyes. Verifiers review adversarially: the shared doctrine assumes AI-authored work
is polished in detail and suspect as a whole.

The **Clerk** is the stateful counterweight: after every panel round it folds the raw
verdicts into a persistent, deduplicated ledger of items (`clerk.json`), rules on
tug-of-wars once and permanently, kills re-litigation, and may overrule a verdict whose
every blocking comment it has overruled — a gate holds when each verifier's fresh verdict
is GO or clerk-overruled. The Owner works from the Clerk's open items, never from raw
comments. Shipped definitions live in
[`prompts/agents/verifiers/`](prompts/agents/verifiers/); a project can
override or extend them in `.pi/council/verifiers/*.md` (matched by `name`). Perception
verifiers may set `browser: true` to use available Playwright/Chromium rendering via `bash`;
they fall back to code inspection when browser tooling is unavailable. The implementation-only
`visual-design` verifier has a stricter rendered-surface contract: it must inspect TUI work
in a real PTY at narrow, typical, and wide terminal widths, and must use the browser for web
work at representative viewports and states. If a relevant renderer is unavailable, it
blocks rather than approving from code alone.

## Configuration

`.pi/council/config.json` (all optional):

```json
{
	"model": "provider/model-for-all-spawned-agents",
	"verifierModel": "provider/default-verifier-model",
	"workerModel": "provider/default-worker-model",
	"verifierModels": { "clean-code": "provider/specialized-model" },
	"clerkModel": "provider/clerk-model",
	"concurrency": 9,
	"timeoutMinutes": 20,
	"inactivityMinutes": 3
}
```

`concurrency` defaults to 9, allowing the full built-in implementation panel to run in one
parallel round. `timeoutMinutes` is the absolute child runtime cap. `inactivityMinutes`
(default 10, valid 0.1–120) terminates a child that emits no JSONL events — streamed tool
output counts, so foreground jobs with visible progress stay alive while genuinely hung
children die; sleep/wake clock jumps also fail in-flight children so missing verdicts can
be re-sourced after resume.

Verifier model precedence is frontmatter, named `verifierModels`, `verifierModel`, shared
`model`, then the session model. Worker entry overrides precede `workerModel` and shared
fallbacks. All shipped agent prompts are discoverable under `prompts/agents/`.

Without a config, spawned agents use the main session's model. `COUNCIL_PI` can
point at a specific pi entry (binary or cli.js) for spawned children; by default the
running pi re-invokes itself.

## Development

```bash
node --test test/unit.ts                                    # logic tests, no LLM
COUNCIL_PI=/path/to/pi/dist/cli.js \
  node test/integration-child.ts provider/model             # one real verifier run
```
