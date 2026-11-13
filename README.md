<p align="center">
  <img src="icon.svg" alt="dsh-harness-dispatcher" width="80" height="80">
</p>

<h1 align="center">dsh-harness-dispatcher</h1>

<div align="center">
  <p><em>The assembly is the variable. The record is the deliverable.</em></p>

  <p>Model + Harness = Agent</p>

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

An agent behaves the way it is **assembled** — prompt sections, tools, skills, middleware, model route —
at least as much as it behaves the way its model does. Normally that makes those choices a matter of
opinion, because changing one and noticing the difference is guesswork.

This plugin makes the assembly a file. Write it down, run one fixed task against two variants, and keep
the record of what each one actually did.

## What you can find out

- **Whether the wording earns its tokens.** A harness row that reuses a shipped tool's name **replaces**
  that tool for the subject alone, description and parameters included. "Does this description matter?"
  becomes one edit and two runs.
- **Whether the tool set matters at all.** `sealed: true` makes the harness the whole tool set; leave it
  off and the subject also inherits everything the host mounts, which is a different question. A harness
  stripped to a single tool answers the same task in a very different number of calls.
- **What your own code does.** Any row can point at a package, a subpath, or a path — `./mine.js` beside
  the harness file, or a `file:///` URL — so a prompt section, a middleware or a tool set you write is as
  much a variable as a shipped one.
- **What breaks.** `deny` / `fail` / `latency` injected into named tools, for the subject only: absence,
  recovery, patience, as three separate experiments.
- **Whether a difference is real.** N trials per variant, and a fingerprint that says whether the two
  variants were actually different things.

## How it works

| Step | Tool | Cost |
|---|---|---|
| List the presets and model routes this host has; find which models take images | `harness_inspect` — no arguments, or `provider` alone | free · one adapter call |
| Mount, audit, report what the subject could call | `harness_inspect` with `preset` or `harness` | free |
| Write a working row list out to edit | `harness_export` | free |
| Run one task against it, one or many trials | `harness_run`, optionally in the background | **one model call per trial** |

The three free steps are the same resolution the run uses, so an inspection's verdict is the run's
verdict. That is what makes "write it wrong, find out, fix it" cheap enough to do first.

## What the record holds

One run is a self-sufficient directory:

```text
<outputRoot>/<runId>/
  run.json          # run identity, task, stimulus fingerprint, probed capability surface
  harness.<ext>     # verbatim copy of the harness under test (harness.json for the shortcut)
  trials.jsonl      # one line per trial
  events.jsonl      # the subject's committed Session events, verbatim
  README.txt        # for whoever reads the data: which field to compare
```

Inside a trial line, two layers, and the split is the point:

- **`host`** — what the host already computed (timing, token buckets, context pressure, policy, delegation),
  copied back unchanged. A second set of totals would be a second set of definitions.
- **`modelInput` + `trace`** — what the subject was *given*, and the three counts no host projection
  offers. This is the evidence that two runs applied the same assembly.

Beside the line sits the third layer, and it is a separate file:

- **`events.jsonl`** — the subject's committed events, verbatim, on by default. It is what lets a record be
  re-folded under an analysis this plugin never anticipated, which is why the plugin computes no statistics:
  means, intervals and significance belong to R or Python, outside this repository.

**The copy is evidence, not the thing that ran** — the source file is what gets mounted, because a row's
bare module names only resolve inside a profile tree. And `events.jsonl` holds prompts and model output as
the subject saw them: redact before sharing.

## Where it stops

- **The fingerprint covers the declaration, not the behaviour.** It hashes the row list, the route, the
  delegation depth and whether the harness was `sealed`. Edit the file a row points at, or let a `!!js`
  row condition resolve differently, and two runs still carry one fingerprint. `modelInput` is what the
  subject actually received; where the two disagree, believe `modelInput`.
- **Skills cannot be masked, only starved.** They reach a subject only through a `skill` tool, so sealing,
  which removes the host's, cuts the channel — but a harness that mounts `tool-skill` itself keeps that row
  and the inherited catalogue follows. `harness_inspect` reports what is actually loadable.
- **A masked name is masked by name.** Under `sealed`, a row that reuses a host tool's name is hidden along
  with it. The probe reports the surviving names; read it rather than assuming a replacement is there.

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
| `engines.dsh` | `^0.2.2-rc.2` — checked against host `0.2.2-rc.2`: the declaration installed here is byte-identical to the running host's, and the activation spec is the flat one |
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

## Development

```shell
pnpm install
pnpm run check     # typecheck + build + test + lint + format:check + check:release
```

`check` is exactly the set of steps CI runs, and a red line holds that equivalence: it once ran the
first four, so a green laptop pushed red.

Commits also autofix format and lint through [.pre-commit-config.yaml](.pre-commit-config.yaml), using the
`prettier` / `eslint` already in `node_modules`. Enable once per clone with `pre-commit install`
(`pre-commit` is a separate CLI, e.g. `uv tool install pre-commit`).

The host-level path — actually mounting, starting a subject, arming a fault — is **not** covered by
`check`, and installing a plugin does not prove it ran. Those steps are manual and written down in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-真机验证不属于-pnpm-run-check); the current state of what
has and has not been verified is in [AGENTS.md](AGENTS.md).

## Before you run

Advice that changes the experiment. The reasoning — why the record is shaped this way, what was tried and
rejected — is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **Inspect before you run.** Free, and the same resolution `harness_run` uses: whatever the inspection
  says about a harness, the run applies exactly that.
- **Discover two things for free, one thing for an adapter call.** The bare `harness_inspect` is local;
  asking for a route's models is not, because only the adapter knows whether answering means asking its
  endpoint. Ask it anyway before attaching an image — it is the only place that says which models take one.
- **`deny`, `fail` and `latency` are three different experiments**, not three settings of one: absence,
  recovery, patience.
- **One variable at a time.** Assembly, route, fault, attachment, delegation depth. The task stays fixed;
  that is the whole point.

## License

[MIT](LICENSE)
