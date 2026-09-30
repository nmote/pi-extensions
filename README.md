# Nat's Pi Extensions

This is a set of Pi extensions I have built to fit my workflow. I intend it as a
quickly-evolving set of tools with no stability guarantees. I don't take issues
or pull requests. With that in mind, if you find this useful feel free to use
it, or fork it to suit your own purposes. This codebase is entirely written by
AI. I have done no more than skim the source code. Keep this in mind.

The extensions are installed as a set as they are interdependent. For example,
the subagents extension interacts with the auto-approve extension to route
approval requests from subagents to the user, the small-model extension serves
both session-topic and auto-approve, etc.

| Extension | Interface / requirements |
|---|---|
| agent-config | `/agent-config`; optional instructions and named-agent directory |
| auto-approve | `/auto`, `request_tool_approval`; optional authenticated small model |
| backlog | `backlog`, `/backlog`, `/backlog-graph`; Graphviz `dot` and macOS `open` or Linux `xdg-open` only for graphs |
| cloud-agents | `cloud_agent`, `cloud_agent_status`, `cloud_agent_apply`, `/cloud-agent-setup`; GitHub remote, Cursor credentials/access or `codex` CLI with ChatGPT login and verified environment |
| model-list | `list_models`; available Pi model catalogue |
| provider-ids | `/provider-ids`; provider request identifiers in session metadata |
| session-memory | `session_notes`, `session_todos`, `/notes`, `/todos`; branch-aware session state |
| session-topic | `/topic`; optional authenticated small model for titles/summaries |
| small-model | `/small-model`; shared background-model selection |
| subagents | `list_subagents`, `subagent`, reply/status/cancel tools, `/subagents`, `/subagent-models`; isolated Pi child processes |
| web | `web_fetch`; anonymous GET only, guarded addresses/redirects and bounded text output |

## Install

```sh
pi install git:github.com/nmote/pi-extensions@v0.1.0
```

To follow the default branch instead:

```sh
pi install git:github.com/nmote/pi-extensions
```

### Local development

```sh
npm ci --ignore-scripts
pi install /absolute/path/to/pi-extensions
npm test
npm run check
```

Local installs load the checkout in place. Code edits take effect after `/reload`
or restart: no build, commit, push, or release is needed. After dependency changes,
rerun `npm ci --ignore-scripts` and restart. Local dependency installation and
updates are the checkout owner's responsibility. Limit tests/checks with
`./scripts/test exts/auto-approve` or `./scripts/check exts/subagents`.

### Resource selection

Use `pi config`, or narrow the package entry in `<agent-dir>/settings.json`:

## Configuration

`<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it.
Configuration and state are independent of the package checkout.

- Optional `<agent-dir>/AGENT_CONFIG.md` expands recursive `@path` instruction
  imports. Absence adds no instructions; a present broken root/import blocks
  prompts. Pi also discovers its native context files and skills. Register your
  own skill paths in `settings.json.skills`.
- Named agents default to `<agent-dir>/agents/`. An absent default directory is
  an empty catalog. Optional `extensions/agent-config.json` selects one replacement
  directory: `{"agents":"~/my-agent-config/agents"}`. Absolute paths, `~`, and
  paths relative to the config file are supported. Invalid explicit settings
  report discovery errors without fallback. `/agent-config` and `list_subagents`
  show the effective directory and errors. Reload after editing definitions.
- [examples/](examples/) contains optional neutral configuration and a named
  agent. Nothing there is installed automatically.

### Approval policy

At the first session startup, an absent
`<agent-dir>/extensions/auto-approve.json` is atomically seeded with a default
approval policy.

The default grants tool-level approval to most extension-provided tools along
with a few other allowances.

Lists concatenate (imports first); empty local lists do not erase imported
values. Local `defaultMode` wins and `evaluator` fields merge individually. Deny
rules always win. To customize shipped lists, copy the preset to your own file,
omit `builtin:defaults`, and import your copy. Package updates change the policy
for users retaining the builtin import.

Engine base behavior allows session-local tools and file access in cwd plus
configured roots, excluding Git/Hg metadata. Global skill reads are in scope.
`manual` prompts for unmatched calls, `auto` evaluates them, and `yolo` allows
them; deny rules apply in every mode. `/auto`, `/auto manual|auto|yolo`,
`/auto effort`, `/auto test`, and `/auto stats` inspect/control policy. `--auto`
overrides startup mode. Evaluator failure/review never grants access; prompts
without a usable UI block. **This is not an OS sandbox.**

`/small-model` selects the shared approval/topic model from authenticated models;
there is no default. `/subagent-models` optionally selects basic/routine/complex
preferences; unset slots inherit the session model. Model calls may incur costs.

MIT licensed; see [LICENSE](LICENSE).
