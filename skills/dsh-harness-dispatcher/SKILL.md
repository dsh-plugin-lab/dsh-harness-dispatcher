---
name: dsh-harness-dispatcher
description: "How to test an agent's assembly instead of its answers: list the presets and model routes this host has, find which models take images, inspect a harness for free, replace a shipped tool's description, bring your own code as a row, run one fixed task against variants, and read the records. Covers the two tool-name namespaces and why runs are compared by fingerprint."
author: zlZayn
metadata:
  source:
    repo: https://github.com/dsh-plugin-lab/dsh-harness-dispatcher
    path: skills/dsh-harness-dispatcher
---

# An assembly can be an experiment

An agent is `model + harness`. The **harness** is the row list it runs with: prompt sections, tools,
skills, middleware. This bench applies one harness to one child agent, holds the task fixed, and writes
down what happened. **It judges nothing** — you get records, and the verdict is yours.

Three consequences, and everything below is one of them:

- **The harness is text.** Varying the assembly is a file edit, so two variants are two files and a
  difference is a diff. That is the whole reason this is testable at all.
- **Every trial is a model call.** The free steps come first and are meant to be spent freely; the
  expensive one is last and is meant to be spent once, deliberately.
- **The record is the deliverable.** Not a score: the right analysis changes, and the raw layer has to
  survive a definition nobody has thought of yet.

## The loop

1. **Ask what exists.** `harness_inspect` with **no arguments** lists the presets and model routes this
   host has. Both reads are local. Do this before naming anything.
2. **Look before you spend.** `harness_inspect` with `preset` or `harness` mounts and audits without
   starting an agent: the same resolution `harness_run` uses, so its verdict is the run's verdict. Keep
   `problems` (it would fail, or would not be the experiment asked for) apart from `warnings` (it runs, and
   some row contributes nothing).
3. **Start from something that runs.** `harness_export` writes a preset's rows out as a file. Editing that
   file is the experiment.
4. **Run, then change one thing.** Same `task_id`, byte-identical prompt, different harness. Long runs go
   behind `run_in_background: true` — a job returns at once, `job_output` shows per-trial progress, and
   `job_kill` cancels the trial in flight while keeping what was already recorded.

## The moves that change an answer

- **Replace a shipped tool's description or parameters.** The sharpest experiment here: same name, same
  shape, different words. A row using `dsh-harness-dispatcher/tool` with an existing tool's name
  **replaces** it for this subject only — that is how "does the wording matter?" stops being a debate.
- **Point a row at your own code.** `name` takes a path — `./mine.js` beside the harness file, or a
  `file:///…` URL — and any plugin you write becomes a variable: a prompt section, a middleware, a tool set.
- **Take rows away.** `sealed: true` makes the harness the whole tool set. Without it the subject also
  inherits every tool the host mounts for itself, which is right when the question is "does this harness
  work in *this* deployment" and wrong when the tool set is the variable.
- **Inject faults.** `deny` / `fail` / `latency` are three experiments — absence, recovery, patience — not
  three settings of one. They sit beside the harness rather than in it, so one file runs under several.
- **Attach.** An `attachments` image is something the subject SEES only if its route declares `image`
  input; the host would otherwise swap it for a placeholder line **without failing**, so this bench refuses
  to start instead. A file is only a path handle — a subject with no file tool cannot open it, and that is
  a finding, not a defect.
- **Run more than one trial.** One trial of a non-deterministic subject is an anecdote.

## What must not move

- **The task.** Same `task_id` and a byte-identical prompt across variants, or two variables moved at once.
- **One axis at a time.** Assembly, route, fault, attachment, delegation depth, `sealed` —
  `stimulus.fingerprint` covers the harness text, the route, the depth and whether it was sealed, so two
  runs of different fingerprints are not comparable. Varying the route also makes an attached image a
  route question; an image pins the route.
- **The declaration is not the behaviour.** The fingerprint covers the row list, **not** the package or file
  a row points at, and not what a `!!js` row condition resolves to on the day. `modelInput` is what the
  subject actually received, so compare it too before calling two runs the same stimulus. Where the two
  disagree, believe `modelInput`.
- **The failure is data.** A broken subject, a fault hit, a trial cut short — all observations. A trial
  stopped by `timeout_ms` is `aborted` with `timedOut: true`; one stopped from outside is `aborted` with
  `timedOut: false`. Neither says the harness was bad.

## Reading the record

- `host` — what the HOST computed, copied back unchanged: timing, token buckets, context pressure, the
  policy the subject ran under, its delegation and todo behaviour. **Compare timings here**; a second set of
  totals would be a second set of definitions.
- `modelInput` — what the subject WAS GIVEN: the system prompt as a digest and a length, the assembled tool
  schemas, the route actually used. This is the evidence that two runs applied the same thing.
- `trace` — the three counts no host projection offers: tool calls, tool errors, the per-tool split.
- `output` — the answer; `events.jsonl` — the same run as it happened, verbatim, on by default. Go there for
  tool arguments, tool results, injected context, per-step timing, retries and compaction.
- `surface` (in `run.json`) — what it mounted with, and the tool and skill names callable in that scope.

## Four things that will cost you an experiment

- **Two namespaces.** `harness.tools` takes CATALOGUE KEYS (`fs`, `pwsh`); `faults[].tool` takes
  MODEL-FACING TOOL NAMES (`read`, `grep`). A fault naming a catalogue key never fires, and a fault that
  never fires still leaves a clean-looking record.
- **Skills are the one thing sealing cannot mask.** They reach the subject only through a `skill` tool, so
  sealing, which removes the host's, cuts the channel. A harness that mounts `tool-skill` itself keeps that
  row and the inherited catalogue follows — no API stops that.
- **Delegation is gated by the row.** A subject can spawn only if the harness's own `tool-subagent` row
  sets `maxDepth` high enough; the request-level `max_depth` does not grant it, and a host default of `0`
  makes every attempt look like the model refusing.
- **A row that reuses a host tool's name under `sealed` is masked with it.** `harness_inspect` reports the
  names that survive, so read the report rather than assuming your replacement is there.

## Do not

- Compute means, intervals or p-values in conversation and call it a result. Export the JSONL.
- Vary the task between harnesses. The task is the controlled variable.
- Put credentials in a harness file. It is copied verbatim into the run directory.
