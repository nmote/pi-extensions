# OpenAI limits

Tracks ChatGPT subscription allowance for `openai-codex` models on `chatgpt.com`.
Near exhaustion, asks the agent to leave its current operation safe, summarize
unfinished work, and stop. After the run settles, checks subscription availability
at the expected reset and sends a continuation prompt. Completed tools are not
replayed.

## Commands

| Command | Effect |
|---|---|
| `/openai-limits` | Refresh shared usage state and show windows, reset times, and pause state |
| `/openai-limits check` | Refresh usage immediately |
| `/openai-limits on` | Enable automatic pausing persistently |
| `/openai-limits off` | Disable automatic pausing; keep usage monitoring |
| `/openai-limits threshold <percent>` | Persist the pause threshold, e.g. `threshold 3` |
| `/openai-limits cancel` | Cancel the pending resume until replenishment |

A user prompt while wrapping up or paused cancels the scheduled resume and
permits continued work, potentially using overage credits. Automatic pausing
returns when subscription headroom is above the pause threshold; no resume
prompt is sent after a manual override. Skill and template prompts count;
registered slash commands and extension-generated messages do not.

Turning pausing off is persistent, unlike the temporary manual override.
Manual overrides survive model switches.
Switching models, navigating the session tree, reloading, or quitting cancels
scheduled continuation. Paused work is not automatically resurrected on restart.

## Display

The compact footer item appears only for supported models:

- `[OA 64%]`: remaining allowance in the most constrained applicable window.
- `[OA wrapping]`, `[OA paused]`, or `[OA override]`: automatic-pause state.
- `[OA 64% · off]`: monitoring with automatic pausing disabled.
- `[OA 64%?]`: cached allowance after a failed refresh.
- `[OA unknown]`: no known applicable allowance.

Low allowance and pause states use the warning color. A separate line below the
editor shows wrapping-up status or the resume countdown. Unknown reset times and
failed availability checks show a check countdown instead. Sending a manual
prompt removes that line. Reset times honor the macOS clock preference or POSIX
time locale (`LC_ALL`, `LC_TIME`, `LANG`); reload after changing system settings.

## Configuration

`<agent-dir>/extensions/openai-limits.json` defaults to:

```json
{
  "autoPause": true,
  "pauseAtPercent": 3
}
```

`pauseAtPercent` is remaining included allowance, from 0 to less than 100.
`/openai-limits threshold 3` applies and saves it without reloading; a `%` suffix
is optional. Existing saved thresholds are preserved. Changing the threshold
does not cancel a pending pause or manual override.
Both pausing and replenishment use this threshold to avoid repeated stop/start
cycles. Credits are not counted as included allowance: they can provide headroom
for wrapping up, but OpenAI controls billing and credit eligibility.

## Limitations

The `openai` ChatGPT login has no supported endpoint for remaining allowance or
reset times. Its tokens target `api.openai.com/v1` and are rejected by Codex's
usage endpoint. Subscription-sharing limits can be app-specific, so Codex quota
is not a substitute. This provider is not polled or automatically paused/resumed;
`/openai-limits check` explains the limitation and links to ChatGPT usage settings.
See OpenAI's [errors and recovery guide](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

Automatic pausing applies in interactive and RPC sessions. One-shot print/JSON
sessions are not automatically paused. Pi must remain open to send a continuation.

Pausing is cooperative, not an enforced request gate. Running tools are allowed
to finish; the agent may consume credits before stopping. If subscription usage
runs out first, a recognized quota error schedules continuation from history,
without requiring a wrap-up summary. Use `/openai-limits cancel` to explicitly
cancel scheduled continuation.

`/openai-limits check` reports sanitized authentication, HTTP, network, or
response-format errors when a refresh fails.

Usage comes from response headers, stream events, and the authenticated Codex
usage endpoint used by OpenAI's own client. The endpoint is not a stable public
API. Unknown data or network failures do not trigger continuation. Availability
is rechecked before resuming, with a 15-second reset margin. All near-limit
applicable windows must recover; unmapped model-specific limits are listed but
are not assumed to apply to the selected model.

Credentials are resolved through Pi, sent only to the fixed ChatGPT usage
endpoint, and never logged. Custom endpoints and API-key `openai` models are not
supported. No model switching, credit purchasing, or reset-credit redemption is
performed.
