# Auto-approve evaluator benchmark

Benchmarks the current auto-approve evaluator behavior against a fixed case
dataset — it is not an exact historical replay. Shared contracts live in
`contracts.ts`; the evaluator-side log-record schema lives in
`exts/auto-approve/eval-log.ts`.

- `cases.jsonl` — case dataset, one JSON object per line (added per case only
  after explicit approval)
- `contracts.ts` — case schema + loader, run-result schema, sparse symlink
  resolver, fictional environment

## Fictional universe

Every case runs in a fixed fictional environment: no real filesystem, local
policy, home directory, or live session state. `home` is `/home/dev`, and the
runner maps every installation root the extension reads onto
`FICTIONAL_INSTALL` (agent dir `/home/dev/.pi/agent`, skills dir
`/home/dev/.pi/agent/skills`, plus fictional README/docs/examples/CHANGELOG
paths), identified by `SUBSTITUTION_ID`. Runs are deterministic in their
inputs; the model is not.

## Case format

Fields per `caseSchema`:

- `id` — stable identifier; never reuse an id after changing a case's meaning
- `tool`, `input` — the call under test
- `cwd`, `home` — fictional absolute paths
- `writeRoots`, `readRoots` — raw as configured; relative and `~` forms resolve
  against the case `cwd`/`home` at run time, exactly as in production (that
  normalization is behavior under test)
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
from the case roots, so prompt construction stays under test.

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
hash of every `.ts` source under `exts/auto-approve/`, and the substitution
scheme, so results are attributable to a specific evaluator implementation.
