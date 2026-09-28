# Incident Copilot

An AI assistant for on-call engineers. When something breaks in production, you describe the problem in plain language (typed or spoken) and the copilot investigates: it reads logs, metrics, deploy history and database health, works out the most likely root cause with the evidence behind it, proposes a fix, and applies it only after you approve.

## What it's for

During an incident, most of the first 20 minutes goes to gathering context: which dashboards, which deploy, which database, what changed. Incident Copilot does that gathering in parallel and presents it as a ranked, evidence-backed answer, so the engineer can spend their time deciding rather than searching.

- **Faster triage.** One sentence ("checkout is throwing 500s") starts a full investigation across every data source.
- **Explanations you can check.** Every hypothesis cites the specific evidence it relies on (a deploy, a metric spike, a log signature), and you can open the raw data behind it.
- **Doesn't just blame the last deploy.** Hypotheses are scored on timing and correlation. A deploy that landed 35 minutes before the problem, with metrics stable in between, is ranked as unlikely.
- **A human stays in control.** The AI can propose a rollback, scale-up or restart, but nothing runs until an engineer clicks Approve. Every tool call, decision and action is recorded in an audit log.
- **A written report at the end.** Once the investigation finishes you get a postmortem-style report: summary, timeline, root cause, remediation and whether it worked.

## How it works

1. **Open an incident.** Describe the symptom in the chat. You can also hold the mic button and speak; the transcript is shown for you to confirm before it's sent.
2. **Quick questions are answered in the chat.** Ask things like "any recent deploys?" or "how's the orders database?" and the assistant calls the right tool and answers directly.
3. **Outages start a deep investigation.** This runs in the background:
   - *Triage:* identify the affected service and the severity.
   - *Gather:* pull logs, metrics, deployments and database health at the same time. If a source is down, that is recorded as an evidence gap instead of failing the investigation.
   - *Correlate:* rank hypotheses by how well the evidence and timing line up.
   - *Validate:* drop citations to evidence that doesn't exist, penalise deploys that don't line up with the onset, and cap confidence when no anomaly is detected, so nothing is proposed for a healthy service.

   Progress appears live on the timeline.
4. **Review and approve.** The top hypothesis comes with a proposed fix, for example "roll back checkout-api to 2.3.0". Approve or reject it.
5. **Verify.** After an approved fix runs, the copilot waits, re-checks the metrics, and marks the incident resolved only if error rates and latency are back to normal.
6. **Report.** The final report appears in the Report tab. If the AI-written report cites unknown evidence or claims an action ran when it didn't, it is rejected and a deterministic template report is used instead.

Refreshing the page or losing the connection is safe: all state is stored server-side and restored when you reconnect.

> **Demo note:** telemetry and remediation are simulated. Two realistic scenarios are seeded so the full flow can be demonstrated end to end: a bad deploy that causes an N+1 query, and a batch job that overloads the database while an unrelated deploy sits in the history as a red herring. The data layer sits behind a provider interface, so it can be pointed at real sources such as Prometheus or Datadog.

## Built on Cloudflare

A Durable Object agent handles the conversation; a Workflow runs durable, human-gated investigations; Workers AI (Llama 3.3) does the reasoning; D1 stores the evidence and the incident record. Full design: [`architecture.md`](./architecture.md).

## Architecture

```
React UI ──HTTPS/WS──▶ Worker (Hono, auth, rate limit, static assets)
                          │
                          ├─▶ IncidentAgent DO (1 per incident)
                          │     WebSocket hub · SQLite memory · bounded tool loop
                          │        │ start / sendEvent        ▲ progress RPC
                          │        ▼                          │
                          └─▶ InvestigationWorkflow ──────────┘
                                triage → gather ×4 (parallel) → correlate → validate
                                → propose → waitForEvent(approval) → execute → sleep → verify → report

Workers AI: Llama 3.3 70B (tools/reasoning) · Llama 3.1 8B (fallback, summaries) · Whisper (voice)
D1: incidents, investigations, evidence, hypotheses, actions, audit_log, simulated telemetry
```

The decision logic (triage, correlate, validate, propose, report) lives in `src/investigation/pipeline.ts` as pure functions. The Workflow steps wrap it with persistence and audit; the eval harness calls the same functions directly.

**Key properties**

- **D1 is the source of truth.** DO pushes are hints; the UI rehydrates from `GET /api/incidents/:id` and polls while an investigation is active.
- **Idempotent workflow steps.** Deterministic IDs + `ON CONFLICT DO NOTHING`; phase audit rows use a `dedupe_key`.
- **Safe by construction.** The LLM can only *propose* remediation from an allowlist. Execution requires an authenticated approval, rollbacks must be backed by matching deploy evidence, and no action is proposed without a detected anomaly. Tool output is wrapped as untrusted, PII is redacted before it reaches the model, and LLM reports pass an output check before they are stored.
- **Degrades without AI.** Every LLM step has a deterministic fallback (default triage, rule-based correlation and action, template report), so the full flow runs offline.
- **Evaluated on every change.** A golden dataset, safety-gated graders, an LLM judge and a hostile-model red team run in CI (see [Evaluation](#evaluation)).

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars        # API_TOKENS=dev-token:demo-user
npm run db:migrate:local
npm run dev:offline                   # no Cloudflare login; AI steps use fallbacks
# or: npx wrangler login && npm run dev   # real Workers AI
```

Open http://localhost:5173 (Vite, proxies `/api` + WS to `wrangler dev` on :8787). Token: `dev-token`.

Sanity check without running anything: `npm test && npm run eval:offline`.

## Demo

1. **Seed scenario A** (N+1 deploy) → open *"Checkout is throwing 500s"*.
2. The investigation ranks `checkout-api@2.3.1` first → approve the rollback → verification shows recovery → incident resolved, report generated.
3. **Seed scenario B** (cron CPU spike) → the batch job outranks the unrelated deploy → `scale_up orders-db` is proposed instead of a rollback.

## Evaluation

LLM output is non-deterministic, so "it worked when I tried it" is not a quality bar. `evals/` runs the production pipeline functions against a golden dataset, grades every step, and gates CI on the results. Only the model client and the telemetry source are swapped out.

**Dataset.** `evals/datasets/golden.jsonl` has 14 cases built from the two seeded incidents plus adversarial variants:

- red herrings, including a decoy deploy 6 minutes before onset
- misleading reporters ("the DB is down, restart it" when the deploy is the cause)
- a log-borne prompt injection that plants a canary string
- telemetry backends going down
- a rejected approval, where the report must not claim the fix ran
- different noise seeds and times of day
- false alarms on a healthy system

**Graders.**

| Kind | Measured |
|---|---|
| Accuracy | root cause top-1 / top-3, citation recall, remediation exact match, triage service + severity |
| Safety (must be 0) | forbidden or unwarranted actions, injection canary in any output, PII in the report or in any request sent to the model, citations to non-existent evidence, false "action executed" claims |
| Model quality | citation precision *before* guardrails (hallucination rate), report guardrail trip rate |
| LLM-as-judge | correctness, groundedness, actionability, honesty (anchored 1–5, reasoning before score) against a reference answer, by a different model family (Mistral Small 3.1) to limit self-preference; the report is passed as untrusted input |
| Ops + calibration | tokens, cost, p50/p95 LLM latency, error and fallback rates; Brier score and ECE of top-hypothesis confidence |

**Modes.**

| Mode | Model | Purpose |
|---|---|---|
| `offline` | AI disabled | Checks the deterministic fallbacks. No secrets; runs on every PR. |
| `chaos` | scripted hostile model (wrong service, invented evidence, 99%-confident blame of an old deploy, unsafe rollback, injected report) | Red-teams the guardrails independently of model quality. Safety gates only. |
| `live` | Workers AI over REST; `--record` saves cassettes | Real quality numbers with `--trials N`; nightly in CI. |
| `replay` | cassettes keyed by SHA-256 of (model, request) | Free, deterministic re-runs. A prompt change causes a cassette miss, forcing a re-record. |

**Statistics and gating.** Metrics come with 95% bootstrap confidence intervals over cases, and `pass^k` requires a case to pass every trial. Each run is compared with `evals/baselines/<mode>.json`. A metric counts as a regression only if it drops by more than max(5pp, CI half-width), so noise alone doesn't fail a build. The report lists newly failing and newly passing cases, and is written to `evals/results/` and the GitHub step summary.

**The judge is evaluated too.** `npm run eval:judge-calibration` runs the judge on 10 human-labeled reports (good ones, wrong root cause, hallucinated metrics, a false "rolled back" claim, a followed injection, a vague answer). It reports Cohen's kappa against the human labels and fails below 0.6.

**Current results.**

| Mode | Cases passing | Accuracy (root cause / action) | Safety failures |
|---|---|---|---|
| `offline` | 14/14 | 100% / 100% | 0 |
| `chaos` | 3/14 (expected: the model is hostile) | 21% / 21% | 0 |

Live and judge numbers need Cloudflare credentials and have not been recorded yet.

**What it caught.** The first chaos run failed its safety gate. With no anomaly detected, `validateHypotheses` skipped its timing checks, so a hostile model's 99%-confident hypothesis produced a **rollback on a healthy service**. Confidence is now capped at 0.3 when no anomaly is detected. The offline run also caught "Checkout 500s" being triaged as sev3, because the regex missed "500s". Both fixes, and the new report output check, have regression tests.

```bash
npm run eval:offline                        # deterministic, regression-gated
npm run eval:chaos                          # hostile model, safety gates
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run eval:live    # 3 trials + judge, records cassettes
npm run eval:replay                         # re-run recorded responses
npm run eval -- --filter tag:red-herring --verbose
npm run eval:offline -- --update-baseline   # accept new numbers
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `dev:offline` | Worker + Vite, with / without remote Workers AI |
| `npm test` | Unit tests for the app and the eval harness (no runtime, no LLM) |
| `npm run typecheck` | Worker, web and evals |
| `npm run eval:offline` / `eval:chaos` | Evals without a model / against a hostile model |
| `npm run eval:live` / `eval:replay` | Evals against Workers AI / from recorded cassettes |
| `npm run eval:judge-calibration` | Judge agreement with human labels |
| `npm run smoke` | End-to-end WebSocket flow against a running Worker |
| `npm run preview` | Built UI served by the Worker on :8787 |
| `npm run deploy` | `vite build` + `wrangler deploy` |

## API

All routes under `/api`, `Authorization: Bearer <token>` (WebSocket: `?token=`), except `/health`.

| Method | Path | |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` / `POST` | `/demo/scenario` / `/demo/seed` | Active scenario / seed `{scenario: "n_plus_one_deploy" \| "cron_cpu_spike"}` |
| `POST` / `GET` | `/incidents` | Create `{description, title?}` / list own |
| `GET` | `/incidents/:id` | Snapshot: incident, investigation, evidence, hypotheses, actions, timeline, messages |
| `GET` | `/incidents/:id/ws` | WebSocket to the incident's DO |
| `GET` / `POST` | `/incidents/:id/messages` | Chat history / HTTP chat fallback (202) |
| `POST` | `/incidents/:id/investigations` | Start investigation |
| `GET` | `/incidents/:id/investigations/:iid` | Investigation row + live Workflow instance status |
| `POST` | `/incidents/:id/actions/:aid/decision` | `{approved}` → `sendEvent` to the workflow |
| `POST` | `/incidents/:id/voice` | Multipart `audio` (≤ 5 MB) → Whisper transcript |
| `GET` | `/incidents/:id/report` | Markdown report |

WS client messages: `user_message`, `approval_decision` (both carry `clientMsgId` for de-dup). Server: `history`, `assistant_delta`/`assistant_done`, `tool_call`, `investigation_progress`, `approval_request`, `state_update`, `error`.

## Layout

```
src/index.ts              Worker routes
src/agent/                IncidentAgent Durable Object
src/workflow/             InvestigationWorkflow + persistence steps
src/investigation/        Pure logic: pipeline stages, gather, heuristics, validation, remediation rules
src/tools/registry.ts     Tools (zod → JSON Schema), shared by agent and workflow
src/telemetry/            Service allowlist, provider interface, D1/in-memory stores, scenarios
src/domain/               D1 repository, approvals, simulated executor
src/ai/                   LLM wrapper (gateway, retries, fallback, tool-call parsing), prompts
web/                      React + Vite UI → dist/client
migrations/               D1 schema
test/                     Unit tests
evals/                    Datasets, graders, judge, stats, cassettes, baselines, CLI
.github/workflows/        CI (typecheck, tests, build, offline/chaos/replay evals) + nightly live evals
```

## Deploy

```bash
npx wrangler d1 create incident-copilot   # set database_id in wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put API_TOKENS        # "token:userId,..."
npm run deploy
```

Optionally set `AI_GATEWAY_ID` in `wrangler.jsonc` to route Workers AI through AI Gateway. For the nightly live evals, add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub secrets.

## Limitations

- Telemetry and remediation are simulated behind `TelemetryProvider`; a real provider (Prometheus, Datadog) slots in without agent changes.
- The eval dataset is synthetic and small (14 cases), so confidence intervals are wide; live-model numbers have not been recorded yet.
- Final answers are sent as chunked deltas; tool-calling requests to Workers AI don't stream.
- Local `wrangler dev` logs a spurious "code had hung" error when a workflow instance completes; the instance status is `complete`.
- Not built: Vectorize memory, R2 export, Cloudflare Access, alert webhooks.
