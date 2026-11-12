---
name: dsh-harness-dispatcher
description: "Benchmark an agent's assembly rather than a model: run one fixed task against harness variants (tools, persona, route, faults, sealing) and keep per-trial JSONL records. Use when comparing two assemblies, ablating one variable, or asking why a subject behaved differently under a different tool set."
author: zlZayn
metadata:
  source:
    repo: https://github.com/dsh-plugin-lab/dsh-harness-dispatcher
    path: skills/dsh-harness-dispatcher
---

# An assembly can be an experiment

An agent is `model + harness`. The harness is the row list it runs with: prompt sections, tools, skills,
middleware. A **preset** is one of those row lists, named and held in the host's registry; the host mounts
it once, so every session naming it joins that mount. This bench applies one harness to one local child
agent (the **subject**), which inherits none of your conversation, holds the task fixed, and writes down
what happened. **It judges nothing**: you get records, and the verdict is yours.

> **The harness is text**: two variants, two files, one diff.
> **Every trial is a model call**: spend the free steps first.
> **The record is the deliverable**: no score.

## Running the loop

Three of these four calls cost no model call, which is what makes the fourth worth spending.

| Step | Call | What it gives you |
|---|---|---|
| 1 | `harness_inspect` with **no arguments** | The presets and model routes this host has. |
| 2 | `harness_inspect` with `preset` or `harness` | Whether that harness mounts, and what the subject could call. |
| 3 | `harness_export` | One preset's rows as an editable file. |
| 4 | `harness_run` | The recorded trials: one call per variant. |

In step 2, `problems` means the run would fail or is not the experiment asked for, while `warnings`
means it runs and some row contributes nothing. Edit step 3's export rather than a blank file: a harness
that has never mounted is the most expensive way to find a typo. In step 4, keep `task_id` and prompt
identical across variants; a long run takes `run_in_background: true`, reports through `job_output`, and
`job_kill` keeps whatever already landed.

## Varying the assembly

Change one thing per call; everything else must stay still. A row configures a plugin, while `provider`,
`model`, `reasoning_effort` and `max_tokens` are request-level — no harness file can hold them.

### In the harness file

A row is `{id, name, config}`; `disabled`, `group` and `inject` sit at that same level, and `!!js` scalars
are evaluated when the file loads.

- **Replace a shipped tool's description or parameters.** A row using `dsh-harness-dispatcher/tool` with
  an existing tool's name replaces it for this subject only: same name, same shape, different words.
- **Point a row at your own code.** `name` takes a path, `./mine.js` beside the harness file or a
  `file:///…` URL, so any plugin becomes a variable.
- **Add a persona.** A persona row `replaces` the deployment persona instead of appending to it (it
  registers under the same section name), so the system prompt barely grows. Do not infer that it applied
  from the prompt's length; compare `modelInput.systemPrompt.digest`.

The file is copied verbatim into the run directory, so it must not carry `credentials`.

### Beside the harness, at request level

- **Vary the route.** `provider`, `model`, `reasoning_effort` and `max_tokens` sit beside the harness
  rather than inside it, so one file runs under several requests.
- **Cut the host's tools out with `sealed: true`.** Unsealed, the subject inherits every tool the host
  mounts (measured on this host: 41 tools against 4); sealed, the harness is the whole tool set. It masks
  the **tool table, not the context**: host prompt sections and injected `user` messages arrive either
  way, so read `system/message` in `events.jsonl` before claiming the prompt was held constant.
- **Inject faults.** `deny` / `fail` / `latency` are absence, recovery and patience: three experiments,
  not three settings of one. They sit beside the harness, so one file runs under several fault sets.

### In the task

- **Attach.** An `attachments` image reaches the subject only if its route declares `image` input;
  otherwise the host swaps it for a placeholder line without failing, so this bench refuses the run. A
  file is only a path handle, so a subject with no file tool cannot open it — that is a result, not a
  defect.
- **Run more than one trial.** One trial is an anecdote; a non-deterministic subject needs more than one.

## Namespacing the tools

Two argument slots name tools, and they take different vocabularies.

| Location | Accepts | Example |
|---|---|---|
| `harness.tools` | CATALOGUE KEYS | `fs`, `pwsh` |
| `faults[].tool` | MODEL-FACING TOOL NAMES | `read`, `grep` |

A catalogue key is a package, not a switch: `fs` mounts read, write and edit together, so any axis finer
than the package needs a harness file. A fault naming a catalogue key never fires, and a fault that never
fires still leaves a clean-looking record.

## Holding the controls fixed

Two of these are rules (the task, the stimulus identity) and two are reminders about how to read a result
(the declaration, the failure); each one changes what the record proves.

- **The task.** Same `task_id`, byte-identical prompt. Hold `cwd` too: a directory other than the
  parent's adds a "working directory changed" `user` message, so the context moves with it.
- **The stimulus identity.** `stimulus.fingerprint` covers the harness text, the route (provider, model,
  `reasoning_effort`, token ceiling), the depth and whether it was sealed; two different fingerprints are
  not comparable.
- **The declaration is not the behaviour.** That fingerprint covers the row list, **not** the package or
  file that a row points at, nor what a `!!js` condition evaluates to at run time — so a shared
  fingerprint does not prove that two subjects received the same thing.
- **The failure is data.** `timeout_ms` firing gives `aborted` with `timedOut: true`; a stop from outside
  gives `aborted` with `timedOut: false`. Neither says the harness was bad.

## Reading the record

One line per trial lives in `trials.jsonl`: the three folded views below, plus `output` and the outcome.

| Field | What it is | How to use it |
|---|---|---|
| `host` | The host's own figures, folded by it from the committed log | Compare timings here; do not compute a second total. |
| `modelInput` | What the subject was given | Where it disagrees with the declaration, believe this one. |
| `trace` | The three counts no projection offers | They exist only here; do not re-derive them from events. |

A `null` `host` or `modelInput` carries `hostUnavailableReason` / `observationsUnavailableReason` on the same
line: absent, never zero.

Two files sit beside the line. `events.jsonl` is this bench's copy of the subject's committed log,
verbatim — tool arguments and results, injected context, per-step timing, retries, compaction — so go there
for what the aggregates cannot hold. `run.json` holds the stimulus, the task and the `surface` the harness
actually mounted with. `host.agentPreset` names the preset that session ran under, which may be a temporary
mount rather than a shipped preset. The run directory's `README.txt` carries the `jq`/PowerShell one-liner
for a several-KB line. Nothing here is a score: means and intervals are yours, computed outside from the
JSONL.

## Avoiding the traps

Each of these leaves a record that looks fine and proves nothing.

**Skills are the one thing sealing cannot mask.** They reach the subject only through a `skill` tool,
which sealing removes; a harness that mounts `tool-skill` itself keeps that row, and the host's skill
catalogue is delivered anyway.

**Delegation is gated by the row.** A subject spawns only if its own `tool-subagent` row sets `maxDepth`;
the request-level `max_depth` caps only how deep the subject itself may be started, so it never grants
anything the row withholds. A host default of `0` makes every attempt look like the model refusing.

**A row that reuses a host tool's name under `sealed` is masked with it.** Read `harness_inspect`'s
report instead of assuming your replacement is there.
