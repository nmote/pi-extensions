# Auto-approve evaluator benchmark

Benchmarks the current auto-approve evaluator behavior against a fixed case
dataset — it is not an exact historical replay. Shared contracts live in
`contracts.ts`; the evaluator-side log-record schema lives in
`exts/auto-approve/eval-log.ts`.

- `cases.jsonl` — case dataset, one JSON object per line (added per case only
  after explicit approval)
- `contracts.ts` — case schema + loader, run-result schema, sparse symlink
  resolver, fictional environment

## Curation

Use the repo-local [curation skill](../../.agents/skills/auto-approve-curation/SKILL.md)
with `/skill:auto-approve-curation` from this checkout. Its helper batches private
logs, applies explicit fictionalization mappings, and tracks dispositions in
`<log-dir>/curation-state.json` without editing source logs. State writes need
permission; public case additions require individual approval. The skill is not
exposed by the installed extension package.

## Running

```sh
# Validate cases and reconstruct current instructions without auth or requests.
npm run --silent benchmark:auto-approve -- --provider anthropic --model claude-haiku-4-5 --dry-run

# Billable: run only when ready to contact the selected provider.
npm run --silent benchmark:auto-approve -- --provider anthropic --model claude-haiku-4-5
```

Use `--help` for options. Defaults: low effort, 30-second timeout, three
repetitions. Two repetitions are supported. Cases default to this directory's
`cases.jsonl`, regardless of invoking cwd; explicit paths use invoking cwd.
Compare models/efforts with separate invocations over the same dataset.

Requests run serially, repetition first then dataset order, without runner
retries or verdict memoization. The runner validates the entire dataset before
initializing auth. It never executes case tool calls. Ctrl-C stops scheduling,
aborts active work, and requires no report. Exit status is zero when every
attempt returns a valid verdict, regardless of score; failures exit nonzero
but still produce a report. Invalid configuration/output errors also fail.

By default stdout shows summary tables, not individual outcomes or JSON.
Each run saves `report.txt` (summary plus per-case outcomes/reasons) and
`results.json` (complete structured results) in a unique timestamped directory
under gitignored `logs/auto-approve/`. File paths and a single run-status line
go to stderr. Use `--log-dir PATH` to choose another directory; custom paths
may need their own ignore rule. Dry-run writes no run logs.

Use `--json` for JSON stdout instead of tables. `--output PATH` optionally
writes an additional JSON copy; existing files are never overwritten.
`--silent` suppresses npm's script banner, which is especially useful with
`--json`. Reports contain verdict reasons and minimal telemetry, not rendered
prompts, raw responses, or credentials. Keep reports private when using
nonpublic cases or rationales.

### Evaluator matrix

```sh
# Offline validation and planned request counts; no auth or logs.
npm run --silent benchmark:auto-approve:matrix -- --dry-run

# Billable: runs each available evaluator serially, without retries.
npm run --silent benchmark:auto-approve:matrix
```

`matrix.json` pins OpenAI `gpt-6-luna`, Fireworks
`accounts/fireworks/models/deepseek-v4p1-flash`, and Anthropic
`claude-haiku-5-5`, plus Fireworks `accounts/fireworks/models/glm-5p3-flash`,
all at medium effort. Models are never substituted.
The command accepts shared `--cases`, `--repetitions`, `--timeout-ms`,
`--auth-path`, and `--log-dir` options with the single-run defaults.
Dry-run validates the matrix and reconstructs inputs through the single-run
command; it does not check model availability.

Actual runs check the built-in physical chat-model catalog, without custom
models or network refresh. Unavailable models and failed runs do not prevent
later entries from running. Stdout shows only evaluator labels, review-positive
precision, recall, F2, unanimous/mixed/insufficient consistency counts,
average estimated cost per evaluation in USD, the full estimated run cost in
USD, and average latency in milliseconds. A final row totals the run costs; a
trailing `+` marks a partial total when some entries have unknown cost.
Latency includes request/auth time for valid and failed attempts.
Cost uses the report's average over attempts with known cost, including failures;
it is a catalog estimate, not provider billing. The run cost is unknown if any
attempt lacks a cost. Unknown costs, absent latency,
and missing scores are `n/a`. Failed
attempts remain excluded from score denominators; stderr warns when a report
excludes failures.

Each invocation creates a private, unique `matrix-*` directory under
`logs/auto-approve/` (or `--log-dir`), containing `summary.txt`, `manifest.json`,
and numbered evaluator directories. The manifest records statuses and paths
to each evaluator's `report.txt`, schema-validated `results.json`, and captured
stdout/stderr. Progress, warnings, and log paths go to stderr. Exit status is
zero only if every entry completes without failures; scores do not affect it.
Ctrl-C stops scheduling, terminates the active child, preserves completed logs,
and exits 130. An interrupted evaluator may have no report.

### Authentication

Uses Pi's built-in physical chat models and normal auth, without sessions,
settings, extensions, live approval configuration/guidance, `models.json`,
or network catalog refresh. Use `--auth-path` to override the credential
file; otherwise Pi's normal agent directory applies. Stored credentials take
precedence over provider environment/ambient credentials. No API-key flag is
provided; use provider environment variables for keys without shell-history
exposure. Credential-file overrides do not disable ambient credentials.

Expired OAuth credentials refresh at request time and may update the normal
auth file. Stored API-key commands may execute under Pi's auth rules; this is
separate from benchmark tool calls, which never execute. Dry-run initializes
neither auth nor requests and does not verify provider/model availability.
Offline tests verify OAuth refresh and persistence at the injected credential
store boundary, not through a live login or real credential-file write.

## Fictional universe

Every case runs in a fixed fictional environment: no real filesystem, local
policy, home directory, or live session state. `home` is `/home/dev`, and the
runner maps every installation root the extension reads onto
`FICTIONAL_INSTALL` (agent dir `/home/dev/.pi/agent`, skills dir
`/home/dev/.pi/agent/skills`, plus fictional README/docs/examples/CHANGELOG
paths), identified by `SUBSTITUTION_ID` (`fictional-install-v2`). The runner
supplies the five fictional skills/install-doc read roots and the bundled
`exts/auto-approve/defaults.json` preset's read/write roots. The whole agent
directory is not a builtin read grant. Runs are deterministic in their inputs;
the model is not.

This baseline assumes `builtin:defaults`, which production configuration may
omit. Logs do not record whether that preset was imported; supplemental roots
alone do not establish faithful historical scope. Curation must exclude cases
with uncertain scope or disclose a synthetic baseline adaptation for individual
case approval.

## Case format

Fields per `caseSchema`:

- `id` — stable identifier; never reuse an id after changing a case's meaning
- `tool`, `input` — the call under test
- `cwd`, `home` — fictional absolute paths
- `writeRoots`, `readRoots` — supplemental to the builtin baseline, raw as
  configured; relative and `~` forms resolve against the case `cwd`/`home` at
  run time, exactly as in production (that normalization is behavior under test).
  Validation rejects lexical equivalents of builtin grants: write roots cannot
  repeat builtin write grants; read roots cannot repeat builtin read/write
  grants. Extra write permission for a builtin read-only root is valid, as are
  parent/child overlaps; symlink equivalence is not inferred.
- `matchedRules` — context rules matched at curation time, instructions as
  data; the runner passes them verbatim and never recomputes the match
- `realPaths` — sparse symlink facts; `null` marks an unresolvable path
- `sessionGuidance` — case-specific trusted session authorization only;
  standard extension guidance is never stored; cases use a fixed revision 0
- `expected` — intended policy including session authorization, not a model
  verdict (`allow` | `review`)
- `rationale` (required), `tags`, `pairWith`

Matching happens at curation time (curation skill or logging) with live
config. Consequently context-rule matching is outside benchmark coverage:
runs are stable across matching-logic changes, but matching regressions are
invisible to the runner. The scope instruction is still rebuilt at run time
from the builtin baseline plus case roots, so prompt construction stays under
test.

Private eval logs keep `schemaVersion: 1`: older records contain full effective
roots; newer records may contain only supplemental roots, omitting exact
raw-string builtin duplicates. Equivalent aliases still require normalization
during curation. `structuredContext.instructions` retains the full evaluated
instruction list, not just matched rules. Root arrays alone are not a complete
historical-scope record.

### realPaths resolution

`sparseRealPath(realPaths)` mirrors `realPathOf`'s parent-recursive behavior:
for a queried absolute path, the longest listed ancestor (or the path itself)
supplies the mapping, and the resolution is that mapping plus the remainder;
`null` anywhere on the chain is unresolvable; a path with no listed ancestor
resolves lexically to itself. Facts keys and values, and `cwd`/`home`, must be
lexically normalized absolute paths (the loader enforces this; queries are
built with `resolve()`, so unnormalized facts could never match), and a
facts key cannot be the filesystem root, which is never a symlink. Resolution
chains at most 40 symlink hops, mirroring the kernel's symlink depth limit,
which `realPathOf` surfaces as unresolvable.

### Contrast pairs

Members of a `pairWith` pair must share identical replay inputs
(`tool`/`input`/`cwd`/`home`/roots/`matchedRules`/`realPaths`) and differ only
in `id`/`sessionGuidance`/`expected`/`rationale`/`tags`/`pairWith`. The
loader enforces this, plus: unique ids, mutual and resolvable `pairWith`, and
absolute `cwd`/`home` and `realPaths` keys/values. Guidance-text/path
consistency is curation-review responsibility, not schema validation.

## Coverage boundaries

In scope: evaluator classification, prompt construction (scope instruction,
matched instructions, guidance block, symlink note), session-guidance
precedence.

Out of scope: the allow/deny gate, context-rule matching, memoization,
escalation UX, soft-reject guidance shown to the main agent.

## Run results

Per `runResultSchema`: the runner replays each case × repetition through the
current pure prompt functions (`evaluatorInstructions`,
`buildSystemPrompt`, `buildDataMessage`) and records per-outcome results.
Failure kinds (`timeout`, `parse`, `non-stop`, `error`) are not model review
judgments and are excluded from verdict-metric denominators. Metrics are
review-positive (`tp` = expected review, verdict review). Zero denominators
yield `null` metrics with the explicit counts retained. `safeCaseAllowRate`
covers expected-`allow` cases; `completionRate` is reported separately from
verdict metrics. `evaluatorPolicyIdentity` pins the extension version, a
sources hash, and the substitution scheme, so results are attributable to a
specific evaluator and replay policy. The deterministic source hash includes
sorted repository-relative filenames and bytes of every `.ts` file recursively
under `exts/auto-approve/` (including tests), its `defaults.json`, and
`benchmark/auto-approve/runner.ts` and `contracts.ts`. `fictional-install-v2`
identifies replay with both fictional installation and bundled preset roots.
Model identity records installed Pi versions, selected capabilities, catalog
pricing, and a hash of selected
metadata including thinking/sampling defaults. Requested effort is not proof
of effective effort; reported provider effort/response model remain null when
unavailable.

Scores pool valid repeated evaluations of the same cases, not additional
independent cases or real-world prevalence. Baselines use the same valid
population. F2 is `5TP / (5TP + 4FN + FP)`; completion is valid attempts divided
by planned attempts. Complete means all outcomes are recorded, not that all
attempts succeeded. Fail-closed synthetic reviews never count as verdicts.
Consistency is unanimous with at least two matching valid verdicts, mixed with
both verdicts, and insufficient with fewer than two valid verdicts. Failures
are counted independently. Individual outcomes retain repetition and reason;
there is no majority vote or per-repetition score summary.

Latency includes request/auth time for valid and failed attempts. Usage from
failed attempts counts when available; all-zero SDK usage is treated as
unknown because it can be default-initialized. Token totals are null if any
attempt lacks a component. Reasoning tokens are included in output, not added
again.

Costs are USD catalog estimates, not provider billing or subscription charges.
Rates are per million tokens, with the highest applicable input-token pricing
tier; the report identifies the installed catalog metadata used. Pi's
calculated `usage.cost` is not authoritative provider billing and is ignored.
Missing usage or all-zero catalog pricing yields unknown cost, not zero. The
known-cost subtotal includes priced failures; the average divides by priced
attempts, and the full total is null if any attempt has unknown cost. SDK
normalization can hide missing individual usage components; positive usage
is used as reported. Special provider surcharges are not inferred. The
request uses no cache retention.

Default tests make no paid requests. Live model validation requires separate
authorization.
