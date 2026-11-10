# dsh-harness-dispatcher

Score the **harness**, not the model.

```text
Model + Harness = Agent
```

An agent's behaviour is a property of its *assembly* — system prompt, tool set, model route — at least as
much as of its model. This plugin turns that assembly into a controlled variable: it runs one fixed
task repeatedly against one harness variant, folds each run's committed events into deterministic
facts, and writes one JSONL line per trial.

It computes no statistics. Mean, interval, and significance belong to R or Python, outside this
repository — because the analysis口径 changes and the records must stay recomputable under a different
one.

## What you get

- **One tool, `run_benchmark`** — task + harness variant + trial count → a run handle and per-trial
  outcomes. The record file is the deliverable.
- **A fault gate** — inject `deny` / `fail` / `latency` into specific tools, for the subject only, with
  no change to any other agent.
- **A trace fold** — turns, steps, tool calls, per-tool errors, unrecovered failures, token accounting,
  the final assistant text. Pure facts; no judgement.

Records land in one directory per run:

```text
<outputRoot>/<runId>/
  run.json        # run identity, task id, record schema version
  trials.jsonl    # one line per trial: the harness, the outcome, the folded trace
```

## Design notes worth knowing before you use it

- **The harness is a closed vocabulary, not free JSON.** `tools` names keys from a fixed catalog,
  `persona` is an enum, and a fault is one of three modes. A model that free-writes a plugin tree can
  silently produce a fault injection that does nothing — and an empty experiment looks like a result.
- **`deny`, `fail`, and `latency` are three different experiments**, not three settings of one.
  `deny` removes the tool (tests detouring), `fail` returns an error (tests recovery), `latency`
  withholds the answer (tests patience).
- **The bench declares its own composition** rather than cloning a shipped preset: a preset's display
  YAML is not re-mountable, and re-mounting it would silently change the stimulus.
- **Reading a finished session log synchronously is deprecated in the host** (`snapshotEvents`,
  `eventAt`, `ownEvents` all say *new calls are prohibited*). This plugin folds `session/event` instead.

Full rationale, with `file:line` evidence and the four assumptions that turned out wrong, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `outputRoot` | `~/.dsh/harness-dispatcher/runs` | Directory that receives one subdirectory per run |
| `defaultTools` | `fs`, `fs-search`, `pwsh` | Catalog keys used when a harness names none |
| `defaultMaxDepth` | `1` | Delegation budget granted to a subject |
| `maxTrials` | `10` | Upper bound on trials per call |

## Status

Unpublished (`private: true`). The unit-test suite covers the pure layer (normalization, the fold, row
building, record writing). The host-level path — actually starting a subject, arming a fault, reading a
live trace — is verified by hand, and the verification steps are written down in
[docs/ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check) **because installing a
plugin does not prove it ran**.

## License

MIT
