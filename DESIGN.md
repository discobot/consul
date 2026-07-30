# council — a launch-committee process for pi

A pi extension that turns code development into a non-interactive, task-based process,
loosely modeled on Google's search launch review: an accountable **Owner** drives the work,
a fixed panel of **Verifiers** (the council) gives go / no-go verdicts at two gates
(design and implementation), and nothing ships past a gate without a full, *fresh* set of GO
verdicts.

## Principles

1. **The task is the unit of organization.** It is created from the user's first chat
   message. After creation the statement is immutable; the user may only *append*
   requirements, or kill the task and start over.
2. **Development is not interactive.** The user sets the task; agents complete it. The user
   watches status, they don't steer implementation details.
3. **One accountable Owner.** The Owner derives requirements, produces a design, dispatches
   workers for any work, sources verdicts, and reconciles every change. If the user appends
   a requirement, it is the Owner's job to propagate it — into requirements, into the
   design, into the implementation, and into re-sourced reviews.
4. **Verifiers are transient and fresh.** Every query starts a verifier afresh with its own
   system prompt, repo status, task/gate artifact, and only a bounded history of that same
   verifier's prior verdicts to prevent relitigation. It receives no other agent history.
5. **Approvals are pinned to content, not to time.** A verdict records a hash of exactly
   what was reviewed. If the relevant content changes — including via an appended
   requirement — the approval is *stale* and the gate closes again. Re-sourcing is the
   Owner's job, proactively.
6. **Everything that can run in parallel does.** Verifier panels always fan out in
   parallel; independent workers run in parallel.
7. **The process is enforced by code, not by prompt.** The state machine lives in the
   extension. The Owner cannot advance phases by rhetoric; `gate_status` / phase
   transitions recompute hashes and verify verdicts mechanically.

## Roles

### Owner (persistent)
The main pi session agent, given the Owner role via an appended system prompt and a set of
process tools. Persistent across the whole task. Responsibilities:

- Derive an explicit requirements list from the task statement (stored alongside the task).
- Produce `design.md` describing the intended change.
- Source the design gate: query the full verifier panel in parallel; address NO-GO comments
  by revising; re-source until all GO.
- Implement (directly and/or by dispatching workers), then source the implementation gate
  the same way.
- Propagate every appended requirement and re-source any approval its changes staled.

### Workers (transient)
Fresh headless pi sessions dispatched by the Owner for any chunk of work — research,
implementation slices, test runs. Full tool access by default, run in parallel, report
back their final message. No memory between dispatches.

### Verifiers (transient, preset panel)
Each verifier is a markdown definition (frontmatter + system prompt). Built-in panel:

| name | cares about |
|---|---|
| `clean-code` | Thermo-nuclear code quality: dramatic simplification ("code judo"), no file >1000 lines unjustified, no spaghetti conditionals, canonical reuse, tight types |
| `interfaces` | Interfaces, APIs, data models: is every change there sensible and justified? |
| `user-local-pov` | Each created/changed user-facing view in isolation: fresh-eyes clarity, sensible journey, a pleasure to follow |
| `user-global-pov` | Changes across pages/views: do they play together sensibly? |
| `design` | Intended design and information design at both gates: consistency, brand adherence, clarity, simplicity, and implementation adherence |
| `ux-bugs` | Everything that should be readable / hearable / viewable is fully so (implementation gate only) |
| `visual-design` | Perceptual visual quality and consistency of rendered surfaces (implementation gate only) |
| `github-clarity` | Is a PR created; are comments & checks addressed? (implementation gate only) |
| `task-completeness` | Does the design address the task? Does the realization follow the design? |

Projects can add/override verifiers in `.pi/council/verifiers/*.md`.

Each query receives exactly its verifier prompt, task/gate context, repository status, and
bounded same-verifier history. Tools are read-only by default. Perception verifiers may set
`browser: true`, adding `bash` to drive available Playwright/Chromium rendering (screenshots,
DOM, accessibility), with graceful fallback to code inspection. The browser-enabled
`visual-design` verifier is deliberately stricter: it cannot approve from code alone. For
TUI changes it renders and inspects actual output in a PTY at narrow, typical, and wide
terminal widths, including rendered color; for web changes it uses the browser at
representative viewports and states. It judges visual hierarchy, spacing/alignment/rhythm,
rendered color and contrast, typographic consistency, and cross-surface visual consistency.
An unavailable relevant rendering path is a blocker. This implementation-only perceptual
role is distinct from `design`, which continues to assess intended and information design
at both gates and implementation adherence to that intent. It answers with:

```json
{ "verdict": "go" | "no-go", "comments": ["..."] }
```

An unparseable answer counts as NO-GO (safe default).

## The task lifecycle

```
user message ──▶ REQUIREMENTS ──▶ DESIGNING ──▶ DESIGN_GATE ──▶ IMPLEMENTING ──▶ IMPL_GATE ──▶ DONE
                     ▲                 ▲              │               ▲              │
                     │                 └──── no-go ───┘               └─── no-go ────┘
                     └── user may append requirements at any time (staleness cascades)
user may KILL at any time (task archived; start over)
```

- **REQUIREMENTS**: Owner calls `task_set` with the verbatim statement and derived
  requirements. Statement immutable from here on.
- **DESIGNING**: Owner writes `design.md` (dispatching research workers as needed).
- **DESIGN_GATE**: Owner calls `request_verdicts(gate: "design")` — all panel verifiers run
  in parallel. Gate opens only when every applicable verifier's latest verdict is GO *and*
  fresh (artifact hash matches current). NO-GOs come back with comments; Owner revises and
  re-sources (full panel re-run after changed design; unchanged artifacts may re-source a
  named subset). Verifiers are fresh except for bounded same-verifier history.
- **IMPLEMENTING**: Owner implements on a work branch (workers in parallel where possible),
  keeps GitHub state clean (PR etc. — `github-clarity` will check).
- **IMPL_GATE**: same mechanics; artifact is the diff against the task's base commit.
- **DONE**: both gates hold with fresh, all-GO verdicts.

### What a verdict is pinned to

- Design gate: `hash(task statement + requirements + design.md)`
- Implementation gate: `hash(task statement + requirements + design.md + git diff base..HEAD)`

So: an appended requirement stales *both* gates; a design edit stales both; a code change
stales only the implementation gate. Staleness is recomputed on demand — the Owner and the
user always see truthful gate status.

### Appending requirements

While a task is active, user messages are requirement appends (or kills), not steering.
The extension prepends a notice to any mid-task user message reminding the Owner to record
it via `task_requirements_add` and propagate. Propagation is enforced mechanically by the
hash cascade: the gate simply will not hold until re-sourced against the new requirement
set.

## Owner tools (registered by the extension)

| tool | purpose |
|---|---|
| `task_set` | Create the task: verbatim statement + derived requirements. One active task at a time. |
| `task_requirements_add` | Append requirements (never edit/remove). |
| `design_write` | Write/update `design.md` (kept in the task dir, hashed for gates). |
| `dispatch_workers` | Run N workers in parallel: `[{name, instructions, tools?, model?}]`. Task context is injected automatically. |
| `request_verdicts` | Fan out the verifier panel (all applicable, or a named subset when re-sourcing) for a gate, in parallel. Records verdicts pinned to the current hash. |
| `gate_status` | Recompute freshness; report per-verifier: go / no-go / stale / pending, plus what the gate is blocked on. |
| `task_complete` | Request DONE. Refused (with reasons) unless both gates hold. |

User-facing commands: `/task` (full status: statement, requirements, phase, per-verifier
state, workers, verdict comments), `/task-kill` (archive and reset).

Status is also always visible in a persistent TUI widget:

```
◆ council #a3f1 IMPLEMENTING · 3 requirements (+1 new) · task summary
  design code✓ design✓ iface✓ complete✓ uglobal✓ ulocal✓ HOLDS
  impl   code✓ design✓ github✓ iface✓ complete✓ uglobal✓ ulocal✓ ux✓ vd…
  spend  $0.0420 12,300 tokens 9 runs
  running visual-design rendering cockpit
```

Gate cells wrap with a hanging indent at narrow widths; `vd` is the compact
`visual-design` label and `…` marks an actively reviewing verifier.

## Persistence

Everything lives in the repo at `.pi/council/`:

```
.pi/council/
  current            # id of the active task
  tasks/<id>/
    task.json        # canonical statement, requirements, pending input, base/status/timestamps
    requirements.md  # readable numbered projection (append-only through tools)
    design.md
    verdicts.jsonl   # every verdict ever sourced
    spend.jsonl      # Owner/worker/verifier tokens and USD
    activity.json    # live child projection
    status.json      # shared phase/gate/blocker/spend presentation snapshot
  verifiers/*.md     # project-level verifier overrides/additions
```

Plain files: the user can read the whole task state without the TUI, and the state
survives session restarts (`pi` resumes are safe — state is on disk, not in context).

## Execution model

- Workers and verifiers are spawned as `pi --mode json -p --no-session` subprocesses with
  replacement verifier `--system-prompt` (worker `--append-system-prompt`), restricted
  `--tools`, and explicit `--provider/--model`
  (configurable globally, by agent kind, and by named verifier in
  `.pi/council/config.json`; verifier frontmatter wins). Shipped prompts are co-located in
  `prompts/agents/`.
- Fan-out uses a concurrency-limited pool (default 9) — a full 9-verifier implementation
  panel is one round-trip wall-clock-wise. A configurable inactivity watchdog (default 3 minutes) and
  sleep/wake clock-jump detection terminate dead children; persisted verdicts make resume
  idempotent and only missing/stale reviews need re-sourcing.
- Every subprocess result streams into the tool-call renderer, so the user sees live
  per-verifier / per-worker progress inside the session, and the widget mirrors it.

## Launcher

`bin/council` is the dedicated entry point: it starts pi with the extension plus a
custom TUI skin (`src/tui-skin.ts`) — a branded startup header plus the extension's
persistent widget showing active task, id, phase, and requirement count, a council terminal title, and a
committee-flavored working indicator. All arguments pass through to pi; the pi entry is
resolved from `$COUNCIL_PI` or PATH.

`bin/council board` starts a separate pi-tui cockpit process. It watches the persisted
status/task/verdict/activity/spend contract, renders the full task board, and supervises a
session-resuming RPC Owner. Append and kill controls go through Owner RPC; the cockpit does
not mutate canonical task files.

## Self-verification (acceptance test for this project)

Run pi with this extension inside this repo and set the task: *"Verify that council
implements DESIGN.md; fix what doesn't."* The Owner must derive requirements, design its
verification approach, pass the design gate, do the work, and pass the implementation gate
— exercising task creation, worker dispatch, the parallel panel, staleness, and gating on
the system itself.
