---
name: dsh-harness-dispatcher
description: "How to use this bench: list the presets this host has, inspect a harness for free, export a working one to edit, redefine or add a tool in the file, run a task against it, and read the records. Covers the two tool-name namespaces and why runs are compared by fingerprint."
author: zlZayn
metadata:
  source:
    repo: https://github.com/dsh-plugin-lab/dsh-harness-dispatcher
    path: skills/dsh-harness-dispatcher
---

# Benchmarking a harness

A **harness** is what a child agent runs with: its prompt and tool rows, plus the model route its
requests use. This bench runs one fixed task against one harness and records what happened. It scores
nothing — the records are the deliverable, and analysis happens outside.

Parameter shapes live in each tool's own schema; this page carries only what no single tool's
description can hold: the loop, the traps, and what the record means.

## The loop

1. **Ask what exists.** `harness_inspect` with **no arguments** lists this host's presets and marks the
   default. It is the entry point when you do not already know a preset id.
2. **Look before you leap.** Given a target, `harness_inspect` mounts, audits and reports what the
   subject could actually call — no agent, no tokens. It takes a preset, a small ablation, or a file you
   wrote. `ok` means it can serve as a subject; `problems` names rows that mounted but contribute
   nothing, unreachable faults, an unusable route.
3. **Start from something that runs.** `harness_export` writes a working row list. Edit it with your
   file tools: delete rows, change `config`, add `disabled`, group rows with `isolate`. It is a Loader
   entry list, parsed by the host itself.
4. **Run it.** `harness_run` takes the task, the harness and a trial count. Add `run_in_background: true`
   when the trials would keep you waiting for minutes: it returns a job id, `job_output` shows
   per-trial progress, and `job_kill` stops it while keeping what was already recorded.
5. **Change one thing.** Keep `task_id` and `prompt` byte-identical between harnesses — that is the
   whole experiment.

## Shaping the subject

- **A harness is a delta, not a world.** By default the subject also inherits every tool the host
  mounts for itself. `sealed: true` makes the harness the whole tool set; without it you are comparing
  two harnesses that share tools you never chose.
- **Skills are the one thing sealing cannot mask.** They are reachable only through a `skill` tool, and
  sealing removes the host's, so a sealed harness has no skill channel at all. A harness that mounts
  `tool-skill` itself keeps that row, and the inherited catalogue then reaches the subject — no API
  stops that.
- **A tool can be defined in the file.** A row named `dsh-harness-dispatcher/tool` stands one up.
  Reusing a name the host already has **replaces** it, which is how a shipped tool's description or
  parameters become a variable; a name another row *in this harness* uses instead fails the mount. The
  tool always succeeds — failure and latency belong to `faults`.
- **Persona replaces, it does not extend.** It compiles to a row, so it is inside the fingerprint like
  everything else, and the deployment persona is gone rather than added to. Judge it by
  `modelInput.systemPrompt.digest`, not by how much longer the prompt got.

## Traps that each cost an experiment

- **An attachment changes the experiment, not just the prompt.** An `attachments` image is something the
  subject SEES only if the model route declares `image` input — the host otherwise swaps it for a
  placeholder line **without failing**, so this bench refuses to start rather than run trials that never
  saw it, and the route becomes pinned. A file is a pointer the subject must follow, since the host
  never sends its bytes: a harness with no file tool scores zero there, which is a finding, not a defect.
- **Two namespaces.** `harness.tools` takes CATALOGUE KEYS (`fs`, `pwsh`). `faults[].tool` takes
  MODEL-FACING TOOL NAMES (`read`, `grep`). A fault naming a catalogue key never fires — and a fault
  that never fires still leaves a clean-looking record.
- **Faults are not part of the harness.** They sit beside it, on the tool pipelines, so one harness file
  runs under different faults. "Same harness, different fault" is two variables, not one.
- **Compare by `stimulus.fingerprint`, never by file name.** It covers the harness content, the route
  and the delegation depth. Equal fingerprints applied the same thing; different ones did not, whatever
  the files are called.
- **Delegation is gated by the row, not by `max_depth`.** A subject can only spawn if the harness's own
  `tool-subagent` row sets `maxDepth` high enough; the request-level `max_depth` does not grant it, and a
  host default of `0` makes every attempt look like the model simply refusing.
- **`timeout_ms` cancels the subject.** A trial it stops is recorded as `stopReason: "aborted"` with
  `timedOut: true` — an observation about the budget, not a harness failure, so do not count it as one
  when you compare runs.
- **Stopping your own turn stops everything.** The trial in flight is cancelled and recorded as
  `aborted` (`timedOut: false`), and no further trial starts. What you get back is the host's
  `Error: tool call aborted`, not a summary — read the run directory for what landed. To drop ONE trial
  and keep the run going, interrupt that child from its own session instead: the run continues and the
  trial lands as `aborted` with `interrupted: true`.

## What the records say

- `host` — what the HOST computed, copied back unchanged: timing and counts, the four disjoint token
  buckets, context pressure against the window, the policy the subject ran under, and the harness
  behaviours (delegation, planning, todos). **Compare timings here** rather than computing your own — a
  second set of totals means a second set of definitions.
- `modelInput` — what the subject WAS GIVEN: the system prompt (digest and length), the assembled tool
  schemas, the route actually used. This is why "the same harness" is checkable rather than trusted.
- `trace` — the three counts no projection offers: tool calls, tool errors, and the per-tool split.
- `events.jsonl` — the subject's committed events, verbatim, on by default. It is where tool arguments,
  tool results, injected context, per-step timing, retries and compaction live, and it is what lets you
  re-fold a run under a definition this bench never had. It also dominates the directory's size.
- `surface` (in `run.json`) — what it mounted with: each row's enablement, plus the tool and skill
  names callable in the subject's scope.

## Do not

- Compute means, intervals or p-values in conversation and call it a result. Export the JSONL.
- Vary the task between harnesses. The task is the controlled variable.
- Put credentials in a harness file. It is copied verbatim into the run directory.
