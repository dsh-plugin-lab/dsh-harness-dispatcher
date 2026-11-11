---
name: dsh-harness-dispatcher
description: "How to use this bench: list the presets and model routes this host has, find which models accept images, inspect a harness for free, export a working one to edit, redefine or add a tool in the file, run a task against it, and read the records. Covers the two tool-name namespaces and why runs are compared by fingerprint."
author: zlZayn
metadata:
  source:
    repo: https://github.com/dsh-plugin-lab/dsh-harness-dispatcher
    path: skills/dsh-harness-dispatcher
---

# Benchmarking a harness

A **harness** is the row list a child agent runs with. The **experiment** is that list plus three things
that sit beside it and never inside it: the model **route**, the injected **faults**, and the task. This
bench runs one fixed task against one experiment and records what happened. It scores nothing — the
records are the deliverable, and analysis happens outside.

Parameter shapes live in each tool's own schema, which is in your context whenever the tool is. This page
holds only what no schema can: the order to call things in, the choices that quietly ruin an experiment,
and how to read the record.

## The loop

1. **Ask what exists.** `harness_inspect` with **no arguments** lists this host's presets (default marked)
   and its model routes. Free. Do this first whenever you do not already hold an id.
2. **Ask one route what models it has.** `harness_inspect` with `provider` alone. This one costs an
   adapter call, so ask it when the answer decides something — above all **which models declare `image`
   input**, which is the only way to know before attaching one.
3. **Look before you leap.** Given a target, `harness_inspect` mounts, audits and reports what the
   subject could actually call, still spending no tokens. Keep the two verdicts apart: `problems` means
   the run would fail or would not be the experiment you asked for; `warnings` means it will run and some
   row will not contribute. A harness with warnings is still a harness.
4. **Start from something that runs.** `harness_export` writes a working row list. Edit it with your file
   tools: delete rows, change `config`, add `disabled`, group rows with `isolate`. It is a Loader entry
   list, parsed by the host itself.
5. **Run it.** `harness_run` takes the task, the harness and a trial count. Add `run_in_background: true`
   when the trials would keep you waiting for minutes: it returns a job id, `job_output` shows per-trial
   progress, and `job_kill` cancels the trial in flight while keeping what was already recorded.
6. **Change one thing.** Keep `task_id` and `prompt` byte-identical between harnesses — that is the whole
   experiment.

## Shaping the subject

- **A harness is a delta, not a world.** By default the subject also inherits every tool the host mounts
  for itself. `sealed: true` makes the harness the whole tool set; without it you are comparing two
  harnesses that share tools you never chose.
- **Skills are the one thing sealing cannot mask.** They reach the subject only through a `skill` tool, so
  sealing, which removes the host's, cuts the channel. A harness that mounts `tool-skill` itself keeps that
  row and the inherited catalogue follows — no API stops that.
- **A tool can be defined in the file.** A row named `dsh-harness-dispatcher/tool` stands one up. Reusing
  a name the host already has **replaces** it, which is how a shipped tool's description or parameters
  become a variable; a name another row *in this harness* uses instead fails the mount. The tool always
  succeeds — failure and latency belong to `faults`.
- **Or bring your own code as a row.** `name` takes a package (`@deepseek-ai/dsh-tool-fs`), a subpath
  (`dsh-harness-dispatcher/tool`), or a path — `./mine.js` beside **the harness file**, or a `file:///…`
  URL. The file is an ordinary plugin (`export const name`, `export function apply(ctx)`), so a persona, a
  prompt section, middleware or a whole tool set you write is as much a variable as a shipped one. **The
  fingerprint covers the row list, not the file it points at**: edit `mine.js` and two runs still carry one
  fingerprint, so compare `modelInput` too before believing they were the same stimulus. **Under
  `sealed`, a row that reuses a host tool's name is masked along with it** — `harness_inspect` reports the
  names that survive, so read it instead of assuming.
- **Persona replaces, it does not extend.** It compiles to a row, so it is inside the fingerprint like
  everything else, and the deployment persona is gone rather than added to. Judge it by
  `modelInput.systemPrompt.digest`, not by how much longer the prompt got.

## Traps that each cost an experiment

- **An attachment changes the experiment, not just the prompt.** An `attachments` image is something the
  subject SEES only if the model route declares `image` input — the host otherwise swaps it for a
  placeholder line **without failing**, so this bench refuses to start rather than run trials that never
  saw it, and the route becomes pinned. A file is a pointer the subject must follow, since the host never
  sends its bytes: a harness with no file tool scores zero there, which is a finding, not a defect.
- **Two namespaces.** `harness.tools` takes CATALOGUE KEYS (`fs`, `pwsh`). `faults[].tool` takes
  MODEL-FACING TOOL NAMES (`read`, `grep`). A fault naming a catalogue key never fires — and a fault that
  never fires still leaves a clean-looking record.
- **Faults are not part of the harness.** They sit beside it, on the tool pipelines, so one harness file
  runs under different faults. "Same harness, different fault" is two variables, not one.
- **Compare by `stimulus.fingerprint`, never by file name.** It covers the harness text, the route and the
  delegation depth — the **declaration**, not what a row resolves to. Two runs of one harness whose row
  points at a package or file that changed in between still carry one fingerprint. **Varying the route
  makes two runs incomparable**, and an attached image pins it.
- **Delegation is gated by the row, not by `max_depth`.** A subject can only spawn if the harness's own
  `tool-subagent` row sets `maxDepth` high enough; the request-level `max_depth` does not grant it, and a
  host default of `0` makes every attempt look like the model simply refusing.
- **An aborted trial is a budget event, not a harness failure.** `stopReason: "aborted"` with
  `timedOut: true` means `timeout_ms` fired; with `timedOut: false` it means something stopped the run.
  Neither says the harness was bad, so do not count either as one when you compare.

## What the records say

- `output` — the subject's answer, and `events.jsonl` — the same run as it happened, verbatim, on by
  default. Go to `events.jsonl` for tool arguments, tool results, injected context, per-step timing,
  retries and compaction: it is what lets you re-fold a run under a definition this bench never had.
- `host` — what the HOST computed, copied back unchanged: timing, token buckets, context pressure, the
  policy the subject ran under, and the harness behaviours. **Compare timings here**; a second set of
  totals means a second set of definitions.
- `modelInput` — what the subject WAS GIVEN: the system prompt as a digest and a length, the assembled
  tool schemas, the route actually used. This is why "the same harness" is checkable rather than trusted.
- `trace` — the three counts no host projection offers: tool calls, tool errors, and the per-tool split.
- `surface` (in `run.json`) — what it mounted with: each row's enablement, plus the tool and skill names
  callable in the subject's scope.

## Do not

- Compute means, intervals or p-values in conversation and call it a result. Export the JSONL.
- Vary the task between harnesses. The task is the controlled variable.
- Put credentials in a harness file. It is copied verbatim into the run directory.
