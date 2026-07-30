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
- **Watch progress** in the status widget above the editor, or with `/task` for the full
  report (requirements, per-verifier gate states, blocking comments, and spend), or run
  `council board` for the dedicated cockpit. The board reads disk state, supervises an RPC
  Owner, and sends append/kill actions through that Owner—it never edits task files. Use
  ↑/↓ (or j/u) to scroll, `a` to append, `k` to kill with confirmation, and q/Esc to close.
  State is plain files under `.pi/council/tasks/<id>/`, including verdict, activity,
  status, and spend projections.

## The verifier panel

`clean-code`, `interfaces`, `user-local-pov`, `user-global-pov`, `design`,
`task-completeness` (both gates), plus `ux-bugs` and `github-clarity` (implementation
gate). Each query runs the verifier afresh with its system prompt, repo/task context, and a
bounded history of its own prior verdicts (never other agents' negotiation). Shipped definitions live in
[`prompts/agents/verifiers/`](prompts/agents/verifiers/); a project can
override or extend them in `.pi/council/verifiers/*.md` (matched by `name`). Perception
verifiers may set `browser: true` to use available Playwright/Chromium rendering via `bash`;
they fall back to code inspection when browser tooling is unavailable.

## Configuration

`.pi/council/config.json` (all optional):

```json
{
	"model": "provider/model-for-all-spawned-agents",
	"verifierModel": "provider/default-verifier-model",
	"workerModel": "provider/default-worker-model",
	"verifierModels": { "clean-code": "provider/specialized-model" },
	"concurrency": 8,
	"timeoutMinutes": 20,
	"inactivityMinutes": 3
}
```

`timeoutMinutes` is the absolute child runtime cap. `inactivityMinutes` (default 3, valid
0.1–120) terminates a child that emits no JSONL events; sleep/wake clock jumps also fail
in-flight children so missing verdicts can be re-sourced after resume.

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
