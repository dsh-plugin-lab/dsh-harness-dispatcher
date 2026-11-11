<p align="center">
  <img src="icon.svg" alt="dsh-harness-dispatcher" width="80" height="80">
</p>

<h1 align="center">dsh-harness-dispatcher</h1>

<div align="center">
  <p><em>Score the harness, not the model. <code>Model + Harness = Agent</code></em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="powered by dsh"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-harness-dispatcher/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-harness-dispatcher/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT license"></a>
  </p>

  <p>
    <strong><a href="README.md">English</a></strong> · <a href="README_zh.md">简体中文</a>
  </p>
</div>

---

An agent's behaviour is a property of what it is **assembled** with — system prompt, tool set, model
route — at least as much as of its model. This plugin makes that assembly a controlled variable: one
fixed task, one harness at a time, one JSONL line per trial.

It computes no statistics. Means, intervals and significance belong to R or Python, outside this
repository, because the definition of an analysis changes and the records must stay recomputable under a
different one.

## What it offers

- **Three tools forming one zero-cost loop.** `harness_inspect` mounts, audits and probes without
  starting an agent or spending a token; `harness_export` writes a preset's rows out as a runnable file;
  `harness_run` runs the task and leaves a self-sufficient record directory behind.
- **Discovery before anything else.** `harness_inspect` with no arguments lists the presets **and** the
  model routes this host has, both read from local registries. `provider` alone then names one route's
  models — the single read that costs an adapter call, and the way to find out which models declare
  `image` input before attaching one.
- **A fault gate** — inject `deny` / `fail` / `latency` into named tools, for the subject only, with no
  change to any other agent.
- **The host's own numbers, exported** (`host`) — whatever the host registered among a fixed list of
  projection keys, copied back unchanged. Adding a host projection is one string in that list.
- **Two views this plugin folds**: what the subject *was given* (`modelInput`, the evidence that two
  runs applied the same harness) and the three counts no projection offers (`trace`).
- **The subject's answer, whole** (`output`), never a prefix: a cut cannot be recomputed, and the raw
  layer below it is already larger by an order of magnitude.
- **The subject's raw event log** (`events.jsonl`, on by default) — so a record can be re-folded under
  a definition this plugin never had.
- **A skill registered by the plugin** (`dsh-harness-dispatcher`, same name as the package) carrying
  the loop and the traps that each cost an experiment, so an agent finds them without reading source.

## Install

Unreleased, so install from a checkout rather than from a registry:

```shell
git clone https://github.com/dsh-plugin-lab/dsh-harness-dispatcher
dsh plugin --profile <profile> add ./dsh-harness-dispatcher
```

The add step gives a **link**, so edits to the checkout take effect without reinstalling.

## Compatibility

| | |
|---|---|
| `engines.dsh` | `^0.2.2-rc.1` — verified against host `0.2.2-rc.1` |
| Node | `>= 20` |

The host's extension surface is read from the **running** version's `lib/**/*.d.ts`, never from a source
checkout: the two lines differ, and a difference of one patch is enough for the same API to have a
different shape. What was measured, including the points where the checkout would have produced
silently broken code, is in
[the host surface check](.agents/notes/2026-11-10-host-api-surface-0.2.2-rc.1.md).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `outputRoot` | `$DSH_HOME/harness-dispatcher/runs` | Directory receiving one subdirectory per run |
| `harnessDir` | `$DSH_HOME/profiles/<name>/harness` | Where a bare harness name resolves and `harness_export` writes |
| `defaultTools` | `fs`, `fs-search`, `pwsh` | Catalogue keys the shortcut mounts when it names none |
| `defaultMaxDepth` | `1` | Delegation budget granted to a subject |
| `maxTrials` | `10` | Upper bound on trials per call |
| `trialTimeoutMs` | `0` | Per-trial wall-time budget; `0` disables it |

`$DSH_HOME` unset means `~/.dsh`. The two paths live under **different roots on purpose**: records are
user data, while a harness file's bare row names only resolve inside a profile tree, so exporting one
anywhere else produces a file that cannot run.

## The record

```text
<outputRoot>/<runId>/
  run.json          # run identity, task, stimulus identity, probed capability surface
  harness.<ext>     # verbatim copy of the harness under test (harness.json for the shortcut)
  trials.jsonl      # one line per trial: the stimulus, the outcome, the host's numbers, our two views
  events.jsonl      # the subject's committed Session events, verbatim
  README.txt        # for whoever reads the data: which field to compare
```

**The copy is evidence, not the thing that ran** — the source file is what gets mounted. And
`events.jsonl` holds prompts and model output as the subject saw them; redact before sharing.

## Development

```shell
pnpm install
pnpm run check     # typecheck + build + test + lint + format:check + check:release
```

`check` is exactly the set of steps CI runs, and a red line holds that equivalence: it once ran the
first four, so a green laptop pushed red.

The host-level path — actually mounting, starting a subject, arming a fault — is **not** covered by
`check`, and installing a plugin does not prove it ran. Those steps are manual and written down in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check); the current state of what
has and has not been verified is in [AGENTS.md](AGENTS.md).

## Before you run

Advice that changes the experiment, not rationale. The reasoning — why the record is shaped this way,
what was tried and rejected — is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **Inspect before you run.** It is free, and it is the same resolution `harness_run` uses: whatever
  the inspection says about a harness, the run applies exactly that.
- **Discover two things for free, one thing for an adapter call.** The bare `harness_inspect` is local;
  asking for a route's models is not, because only the adapter knows whether answering means asking its
  endpoint. Ask it anyway before attaching an image — it is the only place that says which models take
  one.
- **A harness is a delta unless you seal it.** Mounted as a preset it sits inside the host, so by
  default the subject also inherits every tool the host mounts for itself. `sealed: true` masks those.
  Use it whenever the tool set is the variable; leave it off when the question is "does this harness
  work in *this* deployment".
- **Skills are switched off by withholding the `skill` tool, not by masking.** A harness that mounts
  `tool-skill` itself keeps that row, and the inherited catalogue then reaches the subject with no API
  able to stop it. `harness_inspect` reports what the subject can actually load.
- **`deny`, `fail` and `latency` are three different experiments**, not three settings of one: absence,
  recovery, patience.
- **Compare by `stimulus.fingerprint`, never by file name.** It covers the harness content, the route
  and the delegation depth.

## License

[MIT](LICENSE)
