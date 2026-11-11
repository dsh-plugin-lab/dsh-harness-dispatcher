# dsh-harness-dispatcher

Score the **harness**, not the model.

```text
Model + Harness = Agent
```

An agent's behaviour is a property of what it is assembled with — system prompt, tool set, model route —
at least as much as of its model. This plugin turns that into a controlled variable: it runs one fixed
task repeatedly against one harness, folds each run's committed events into deterministic facts, and
writes one JSONL line per trial.

It computes no statistics. Mean, interval, and significance belong to R or Python, outside this
repository — because the analysis口径 changes and the records must stay recomputable under a different
one.

## What you get

- **Three tools forming one zero-cost loop**:
  - `harness_export` — write a preset's rows out as a runnable harness file (subtract from something
    that already works);
  - `harness_inspect` — mount, audit and probe it, reporting what the subject could *actually* call.
    **No agent started, no tokens spent.** It also takes `{ preset: "standard" }` to inspect a preset the
    host already has, with **no file to create at all**;
  - `harness_run` — task + harness + trial count → a run handle and per-trial outcomes. The record file
    is the deliverable.
- **A fault gate** — inject `deny` / `fail` / `latency` into specific tools, for the subject only, with
  no change to any other agent.
- **Two folds** — what the subject *did* (`trace`: turns, steps, tool calls, per-tool errors, token
  accounting, final text) and what it *was given* (`modelInput`: system-prompt digest, tool names and
  schema digest, actual route). Pure facts; no judgement.
- **A skill registered by the plugin** (`dsh-harness-dispatcher`, same name as the package) carrying that
  loop and the traps that each cost an experiment, so an agent finds them without reading source.

Records land in one **self-sufficient** directory per run. Two roots, and the split is deliberate:

| | Default | Why there |
|---|---|---|
| **Records** (`outputRoot`) | `$DSH_HOME/harness-dispatcher/runs/<runId>/` | user data; one directory per run |
| **Harness files** (`harnessDir`) | `$DSH_HOME/profiles/<name>/harness/` | it is the directory holding the profile's `cordis.patch.yml`, so it follows the **profile**, not the home: a harness file's bare row names only resolve inside a profile tree, and exporting anywhere else produces files that cannot run |

`$DSH_HOME` unset means `~/.dsh`. **There is no `<DSH_HOME>/harness-dispatcher/harness/`** — that is only
the fallback for a context with no profile file at all.

```text
<outputRoot>/<runId>/
  run.json          # run identity, task, stimulus identity, probed capability surface
  harness.<ext>     # verbatim copy of the harness under test (harness.json for the shortcut)
  trials.jsonl      # one line per trial: the stimulus, the outcome, both folds
  README.txt        # for whoever reads the data: which field to compare
```

**The copy in the run directory is evidence, not the thing that ran.** What gets mounted is the source
file where it sits — so the two appear side by side, and only the source is worth editing. Runs that
used the `tools`/`persona` shortcut have no source file at all; their `harness.json` is the compiled
row list and *is* everything.

## Design notes worth knowing before you use it

- **A harness is a plugin row list**, and it may live anywhere; it is **copied into the run directory**
  when it runs. "The same harness" is therefore guaranteed by the copy plus the recorded
  `stimulus.fingerprint`, not by where the file sits.
- **Inspect before you run.** It is free, and it is the same resolution `harness_run` uses — whatever
  the inspection says about a harness, the run applies exactly that.
- **A harness is a delta unless you seal it.** Mounted as a preset it sits inside the host, so by default
  the subject also inherits every tool the host mounts for itself — the same forty-odd tools in every
  variant you ever compare. `sealed: true` masks those, leaving exactly what the harness declares. Use it
  whenever the tool set is the variable; leave it off when the question is "does this harness work in
  *this* deployment".
- **Skills are switched off by withholding the `skill` tool, not by masking.** The host has no skill
  mask, and a same-name entry does not shadow an inherited one (measured twice: registrations land in the
  host's layer, where the first one wins). The catalogue is only ever published to a subject that can
  call `skill`, so sealing — which removes the host's `skill` tool — is enough. A harness that mounts
  `tool-skill` itself keeps that row, and the inherited catalogue then reaches the subject with no API
  able to stop it. `harness_inspect` reports what the subject can actually load.
- **The shortcut is sugar, not the definition.** `harness.tools` names keys from a fixed catalogue and
  `harness.persona` is an enum; it compiles into the same kind of row list and is captured the same way.
  What the shortcut cannot express (groups, `isolate`, skills, `!!js` conditions) is a file.
- **The host parses the file** (`cordis:include`); this plugin implements no second dialect.
- **`deny`, `fail`, and `latency` are three different experiments**, not three settings of one.
  `deny` removes the tool (tests detouring), `fail` returns an error (tests recovery), `latency`
  withholds the answer (tests patience).
- **Reading a finished session log synchronously is deprecated in the host** (`snapshotEvents`,
  `eventAt`, `ownEvents` all say *new calls are prohibited*). This plugin folds `session/event` instead.

Full rationale, with `file:line` evidence and the assumptions that turned out wrong, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[.agents/notes/2026-11-11-harness-shape.md](.agents/notes/2026-11-11-harness-shape.md).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `outputRoot` | `$DSH_HOME/harness-dispatcher/runs`, i.e. `~/.dsh/…` when it is unset | Directory that receives one subdirectory per run |
| `harnessDir` | `$DSH_HOME/profiles/<name>/harness` | Where a bare harness name resolves, and where `harness_export` writes. Follows the profile directory, not the home: a harness file elsewhere cannot import its own rows |
| `defaultTools` | `fs`, `fs-search`, `pwsh` | Catalogue keys the shortcut uses when it names none |
| `defaultMaxDepth` | `1` | Delegation budget granted to a subject |
| `maxTrials` | `10` | Upper bound on trials per call |
| `trialTimeoutMs` | `0` | Per-trial wall-time budget; `0` disables it |

## Status

Unpublished (`private: true`). The unit-test suite covers the pure layer (capture, normalization, the
folds, record writing, row compilation). The host-level path — actually mounting, starting a subject,
arming a fault, reading a live fold — is verified by hand, and the verification steps are written down
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check) **because installing a
plugin does not prove it ran**.

## License

MIT
