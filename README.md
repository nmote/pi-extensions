# Nat's Pi Extensions

This is a set of Pi extensions I have built to fit my workflow. I intend it as a
quickly-evolving set of tools with no stability guarantees. I don't take issues
or pull requests. With that in mind, if you find this useful feel free to use
it, or fork it to suit your own purposes. This codebase is entirely written by
AI. I have done no more than skim the source code. Keep this in mind.

The extensions are installed as a set because they are interdependent. Each
extension's README lists its commands, agent tools, and usage requirements.

| Extension | Purpose |
|---|---|
| [agent-config](exts/agent-config/README.md) | Shared instructions and named-agent configuration |
| [auto-approve](exts/auto-approve/README.md) | Tool permissions and model-assisted approval |
| [backlog](exts/backlog/README.md) | Persistent repository-labeled work and dependency graphs |
| [cloud-agents](exts/cloud-agents/README.md) | Cursor and Codex Cloud dispatch, status, and local handoff |
| [model-list](exts/model-list/README.md) | Available Pi model discovery |
| [openai-limits](exts/openai-limits/README.md) | Subscription usage and cooperative pause/resume |
| [provider-ids](exts/provider-ids/README.md) | Provider request identifiers for troubleshooting |
| [session-memory](exts/session-memory/README.md) | Branch-aware session notes and todos |
| [session-topic](exts/session-topic/README.md) | Automatic session titles and summaries |
| [small-model](exts/small-model/README.md) | Shared background-model selection |
| [subagents](exts/subagents/README.md) | Reusable, supervised Pi children |
| [web](exts/web/README.md) | Anonymous public-page fetching |

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

Use `pi config`, or narrow the package entry in `<agent-dir>/settings.json`.

## Configuration

`<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it.
Configuration and state are independent of the package checkout. See each
extension's README for its settings and [examples/](examples/) for optional
configuration; nothing there is installed automatically.

MIT licensed; see [LICENSE](LICENSE).
