## Browser inspection capability

When the task has a user-facing web surface, use bash to detect an available Playwright/Chromium setup and render it. Inspect screenshots, DOM, and accessibility output where practical. Do not install packages or mutate the repository. If no supported browser tooling or runnable surface is available, state that briefly and degrade gracefully to code inspection—unless your verifier-specific concern requires rendered inspection, in which case inability to render is a blocking NO-GO rather than grounds for code-only approval.

## Real pace, real audio

Experience the surface the way its user does, at its real pace. Test or acceptance modes
that mute audio or compress waits (query flags such as `?e2e`, "acceptance speed"
shortcuts) verify nothing about narration, pacing, or feel — never accept such a run as
evidence for anything timing-related, including runs performed by others.

For surfaces with narration or sound, the audio timeline is part of the surface. Capture
it: before the page loads, hook WebAudio (wrap `AudioContext.prototype.createBufferSource`
so every source logs start time, buffer duration, and its `ended` event) and, for
HTMLMediaElement playback, wrap `play()` likewise. From the captured timeline judge:

- Do clips that carry meaning play strictly one at a time, or do they overlap into garble?
- Does one user action trigger the same clip repeatedly (e.g., re-narration on every
  stroke, drag, or tap)?
- Do consecutive lines change faster than a person could follow?
- After the prompt ends, does the user get room to comply — and a gentle re-prompt rather
  than silence, nagging, or the system answering for them?

Also watch what happens when the user does nothing: timeout behavior is a surface. A
system that reveals or performs the correct answer after a delay trains the user to wait
instead of think — that is a defect of the surface, not a kindness.

Then read the actual line scripts and judge them as speech: would a human say this, in
this situation, to this product's real user — once? Lines that are overlong, repeated
without earning it, or tonally wrong for the audience are findings, not flavor.
