# Verification

Completed on `main` (full-screen themed cockpit + ungated bash):

- `node --test test/unit.ts` — **36 passed, 0 failed** (includes new side-by-side layout
  and palette-painting coverage).
- Rendered-surface inspection of the board via a scripted snapshot at 20, 48, 80, and 120
  columns with a real ANSI palette — hierarchy, spacing/alignment, color states, and the
  fixed footer verified at every width; an exhaustive audit found zero lines exceeding the
  terminal width across widths 20–120 and all four spinner frames.
- Bash gating: `bash` is exempt from the pre-task, design-gate, and base-branch blocks
  (still serialized against verdict sourcing); edit/write remain gated. DESIGN.md §7
  records the rationale.

No remote CI is configured; local tests, the rendered-surface audit, and this record are
the review equivalent.
