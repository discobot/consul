# launch-review

A [pi](https://pi.dev) extension that turns development into a launch-committee process:
you set a task, an **Owner** agent completes it, and a panel of transient **Verifiers**
gives go / no-go verdicts at the design gate and the implementation gate. Nothing passes a
gate without a full set of fresh GO verdicts — freshness is pinned to content hashes, so
any change (including a requirement you append mid-task) automatically stales the
approvals it invalidates.

See [DESIGN.md](DESIGN.md) for the full design.

## Usage

The dedicated launcher starts pi with the extension and the launch-review TUI skin
(branded header with the live task, committee working indicator) preloaded:

```bash
launch-review/bin/launch-review            # uses `pi` from PATH
LAUNCH_REVIEW_PI=/path/to/pi/dist/cli.js launch-review/bin/launch-review
```

Any arguments pass through to pi (`--model`, `--provider`, …). Alternatively load the
extension into a plain pi session:

```bash
# one-off
pi -e /path/to/launch-review/index.ts

# or install into a project (auto-loads, hot-reloadable)
ln -s /path/to/launch-review your-project/.pi/extensions/launch-review
```

Then, in a git repository with at least one commit:

- **Your first message is the task.** It becomes the immutable task statement; the Owner
  derives requirements, designs, sources the design gate, implements, sources the
  implementation gate, and completes.
- **Later messages append requirements** (or ask to kill). You cannot reword the task —
  kill it with `/task kill` and start over.
- **Watch progress** in the status widget above the editor, or with `/task` for the full
  report (requirements, per-verifier gate states, blocking comments). All task state is
  plain files under `.pi/launch/tasks/<id>/`.

## The verifier panel

`clean-code`, `interfaces`, `user-local-pov`, `user-global-pov`, `design-consistency`,
`task-completeness` (both gates), plus `ux-bugs` and `github-clarity` (implementation
gate). Each query runs the verifier afresh — its system prompt, the repo status, and the
task are all it ever sees. Definitions live in [`verifiers/`](verifiers/); a project can
override or extend them in `.pi/launch/verifiers/*.md` (matched by `name`).

## Configuration

`.pi/launch/config.json` (all optional):

```json
{
	"model": "provider/model-for-all-spawned-agents",
	"verifierModel": "override-for-verifiers",
	"workerModel": "override-for-workers",
	"concurrency": 8,
	"timeoutMinutes": 20
}
```

Without a config, spawned agents use the main session's model. `LAUNCH_REVIEW_PI` can
point at a specific pi entry (binary or cli.js) for spawned children; by default the
running pi re-invokes itself.

## Development

```bash
node --test test/unit.ts                                    # logic tests, no LLM
LAUNCH_REVIEW_PI=/path/to/pi/dist/cli.js \
  node test/integration-child.ts provider/model             # one real verifier run
```
