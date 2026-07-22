# MIGRATION_MAP.md — ODA Productivity Tool: Claude plugin bundle → native OnDemand application

> **Phase 1 gate deliverable.** Written BEFORE any Phase 2 product code, per the ODA master
> implementation plan. Base commit: `996ab90d21dcdad8b966046c7b9fe7014b9580f4` (master, verified).
> Source bundle: **`oda-plugin/` v1.6.0-merged** (orchestrator + 8 worker skills + shared contracts,
> retrieved from the uploaded-file directory manifest: SKILL.md files, `harmonization.md`,
> `trinity.md`, `full-mode.md`, `output-contracts.md`, `discipline-chrome.md`, design-system
> `readme.md`, `styles.css` tokens, templates, assets).
> Live OnDemand API documentation consulted **2026-07-22T17:45–17:53Z** (never from memory) — see §4.
> Phase 1 completed: **2026-07-22T17:56Z**.

---

## 1. Capability inventory — what the bundle does today (Claude form)

### 1.1 The orchestrator

| Skill | Invocation | Role |
|---|---|---|
| `oda` | `oda:oda` (the `/oda` command) | Front door. Runs the Trinity loop at orchestration level: decomposes the request, routes to exactly the right worker(s) with a one-line brief + `mode:` hint, inserts mandatory EXTRACT stages for any external figure (no-invent rule), verifies worker returns, synthesises one answer. Never does a worker's job itself. |

### 1.2 The eight workers (target skill ids, with bundle lineage)

| Target skill id | Bundle lineage (v1.6.0) | Purpose | Modes | Deliverable |
|---|---|---|---|---|
| `design` | `design` | Branded ODA decks, one-pagers, HTML/PPTX assets on the EMU-faithful ODA design system (ink `#1D252C`, gold `#AD833B`, cream, mist; Lora titles / Montserrat body / Sakkal Majalla AR; 12 canonical slide layouts; editable-PPTX export contract) | fast/full | Deck / one-pager / asset (HTML→PPTX) |
| `problem-solve` | `problem-solve` | MBB seven-step framework (Define → Structure → Creative options → Prioritise → Plan → Analyse → Synthesise → Recommend), confirm gate after each step in FULL; issue trees MECE-tested; every figure tagged fact/assumption/web | fast/full | Markdown problem-solving workbook → 1–5 leadership-ready recommendations (partnership-framed, entity-named) |
| `benchmark` | `benchmark` | Five-stage evidence funnel over development/humanitarian/philanthropic programmes worldwide: scope → 15–20 longlist → 5–7 shortlist → parallel case research → synthesis | fast/full | Benchmarking report: standardized source-cited cases, graded evidence, 3–5 confidence-rated UAE implications |
| `data-scout` | `country-data` | The bundle's data engine. PROFILE lane (country packs, fast facts, dashboards) + EXTRACT lane (sourced, benchmarked series for any sibling skill — the stage the orchestrator inserts whenever a worker needs a figure). ~90 public sources, 14+ domains, comparators always fetched | fast/full | 5-sheet cited Excel workbook + insight pack / fast-facts / evidence summary |
| `model` | `problem-solve` Step-5 quantitative lane (`scripts/build_model.py`, xlsx skill soft-dependency) — promoted to a first-class worker | Quantitative model construction: weighted scoring matrices, size-of-prize BOTE, Low/Base/High scenarios, sensitivity on top-two drivers; assumptions shown on-sheet | fast/full | `.xlsx` model + assumptions register |
| `storyline` | NEW — absorbs `summary` (five-zone exec one-pager) and `action-titles` (3 ranked titles, 15–20 words) as compatibility routes | Narrative architecture: storyline/dot-dash for a deck or document, executive summaries, action-title passes; MAIN vs APPENDIX split; answer-first top-down structure | fast/full | Storyline spec / five-zone one-pager (SUMMARY route) / ranked action titles (TITLES route) |
| `translate` | `translate` | English → Emirati-register Arabic (PPTX/DOCX layouts preserved, Sakkal Majalla +2pt) AND Arabic QA review against the terminology corpus. The only Arabic skill. English approved before Arabic starts | fast/full | Arabic document/deck or QA findings |
| `media` | `media` | Bilingual (EN-then-AR) media & communications in WAM editorial register — six modules: 01 media strategy, 02 digital/content calendar, 03 PR & crisis, 04 content production, 05 press release, 06 Fast Track launch kit | fast/full | Bilingual media deliverable(s) |

### 1.3 Compatibility routes (must keep working)

| Legacy invocation | Routes into | Notes |
|---|---|---|
| `summary` / "exec one-pager from this deck" | `storyline` (SUMMARY route) | Fixed five-zone page (Scope · Context · Approach · Objectives · Next steps) from an existing deck/doc. Chains onward: SUMMARY → `translate` |
| `action-titles` / "title this slide" | `storyline` (TITLES route) | 3 ranked options per slide, typed to slide taxonomy (Context/Thesis/Method/Finding/Options…), 15–20 words, word counts shown; `design` → storyline TITLES interop target 15–18 words |

### 1.4 Shared bundle contracts (bind every skill)

- **Trinity contract** (`trinity.md`): Thinker (decompose/plan, states definition of done) → Worker (executes, self-report, never self-certifies) → Verifier (adversarial PASS / REVISE / ESCALATE against the pre-stated definition of done; ≤2 REVISE loops then 1 ESCALATE; independent verifier for Chairman-bound output). **Nothing reaches the user until the Verifier passes it.**
- **Harmonization** (`harmonization.md`): `oda-*` naming, rich trigger-dense frontmatter, disambiguation matrix (design vs summary; problem-solve vs benchmark; who owns a request), ODA voice (British English, sentence case, answer-first, restrained bold, uppercase k/M/B/T units), no-invent + WAM/u.ae named-entity verification hard rule, brand constants, self-containment rule (a skill never reaches into a sibling's folder).
- **Mode selection**: deterministic FAST vs FULL decided ONCE at entry (user-asked in FULL-capable skills; `action-titles` always FAST); FULL loads `references/full-mode.md`; FAST is self-sufficient and must never emit the FULL-gate trigger phrase "Continue to Step".
- **Output contracts** (`output-contracts.md`): canonical 5-sheet Excel (README / Data_Long / Data_Wide / Metadata / QA_Log, per-row citations); deck-spec markdown (one block per slide, deterministic enough to render 1:1); fast-facts 9-section spine.
- **Design discipline** (`discipline-chrome.md`, design `readme.md`): reading-order, no bare-bullet pages, one body size, canvas fill rules, sources-line rules (entity-name hyperlinks only, no self-citation), cover carries exactly four elements, partnership lens on every "what" page.

---

## 2. Claude-specific dependencies found (must be replaced)

| # | Claude dependency | Where it appears in the bundle |
|---|---|---|
| C1 | `ask_user_input_v0` tappables — mode choice, per-step confirm gates, elicitation forms, QA-depth choice | every FULL-capable SKILL.md + full-mode.md (Thinker gathers inputs "in one ask_user_input_v0 call") |
| C2 | `mcp__visualize__show_widget` progress widget (`_shared/progress-widget.md`, STATE object edited verbatim) | FULL mode of every worker; banned in FAST |
| C3 | Claude subagents + model routing hints (opus Thinker/Verifier, sonnet Worker, haiku mechanical passes; independent fresh-opus verifier subagent) | trinity.md, routing-policy.md, full-mode.md fan-out rules |
| C4 | Hooks enforcing process gates — the literal phrase "Continue to Step" reserved as a FULL-gate hook trigger; frontmatter-driven router | SKILL.md mode rules across the bundle |
| C5 | Local skill folder references loaded from disk at each step (`references/step-*.md`, `full-mode.md`, `tree-taxonomy.md`, `uae-context.md`, source catalogs) | problem-solve, data-scout, media, benchmark, design |
| C6 | Claude session context: uploaded workbook resume ("re-upload the workbook, read its status header"), chat-scoped files, seed-PPTX upload per chat | problem-solve workbook, design seed/ODA-template-seed.pptx, storyline/summary inputs |
| C7 | Skill outputs saved to local folders (`outputs/…` relative cwd, "downloadable area" of the Claude sandbox) | output-contracts.md, problem-solve workbook path |
| C8 | Local scripts executed in the Claude sandbox (`scripts/build_model.py`, `render_tree_svg.py`, `fetch_data.py`, `build_workbook.py`, `render_deck.py`; "probe py -3 → python3 → python") | problem-solve, data-scout, design |
| C9 | Web/API retrieval instructed as in-skill behaviour (WAM web-searches, aggregator-first fetch OWID/DBnomics → keyless primaries) | data-scout playbooks, media WAM verification, problem-solve Step 5 |
| C10 | Claude file presentation (inline artifact rendering / download affordances of claude.ai) | all deliverables |
| C11 | Self-learning ledgers appended on acceptance (`self_learning/reflections.md`, promotion in maintenance sessions) | every worker |
| C12 | Model *recommendations* as prose ("suggested model: opus/sonnet/haiku") instead of executable routing | trinity.md, full-mode.md |

## 3. Reusable OnDemand infrastructure already in this repo (verified at 996ab90)

| Repo asset | What it provides | Reused by the port as |
|---|---|---|
| `server/ondemand.js` | Battle-tested OnDemand client: session create (201, transient-404 retry), SSE streaming passthrough (fulfillment / *_thinking frames, `[DONE]`, stall watchdog, error envelope parsing), sync query, `plugin-…`→`agent-…` id translation, retry/backoff, fail-fast empty-key guard | The ONLY wire to the platform — all ODA skill calls go through `streamQuery`/`syncQuery`/`createOdSession` |
| `server/plugins.js` | ADOPTED plugin registry (Internet, Perplexity, GPT Search, Tavily, Web Extractor, File Directory, MD→PDF, HTML→DOCX, GPT Image 2, OnDemand Agent) — every id 200-verified in PLUGIN_TESTS.md | `requiredConnectors` resolution for skill manifests (existing connectors/plugins — nothing new fetched ad hoc) |
| `server/artifacts.js` | Artifact route map (docx/pdf/pptx/xlsx/csv/md/html/image/audio), URL validation (HEAD + range-GET), phase status streaming | Artifact materialisation layer behind versioned run artifacts |
| `server/index.js` `/api/chat` | Existing SSE transport: `text/event-stream`, keepalive comments, `event:`/`data:` framing, static dist serving | The SAME transport pattern carries `ODARunEvent` streaming (`/api/oda/runs/:id/events`) |
| `server/store.js` | In-memory conversation/file/export stores | Pattern for the durable `ODARun` store (extended with disk persistence for refresh/reconnect recovery) |
| `server/env.js` | Central env + model-policy module with validated reasoning efforts; documented dead-ends (suffixed model ids = HTTP 400; INACTIVE glm registry entries) | Superseded for ODA by `server/oda/models.js` (central, testable, observable); env.js stays authoritative for legacy surfaces |
| `server/exports.js` | Local pptxgenjs/exceljs/docx/pdfkit assembly fallback | Fallback artifact worker when a converter plugin is down |
| `server/router.js`, `server/prompts.js` | GLM-based classify + deterministic heuristic fallback | Pattern reused by the GLM 4.7 interpreter (structured control JSON, heuristic fallback) |
| `server/speech.js`, `server/voice.js` | Services API STT/TTS integration | Untouched; available to media/design flows later |
| Projects/run precedents (`server/data/…` seed runs) | Versioned per-run JSON files on disk | Pattern for `server/data/oda-runs/` durable run state |

## 4. LIVE OnDemand public API documentation — findings (consulted 2026-07-22T17:45–17:53Z)

Source: `GET {base}/config/v1/public/docs/categories` + `GET {base}/config/v1/public/docs/reference/api/{slug}` (authenticated, live). Base `https://api.on-demand.io`.

### 4.1 Chat sessions & queries (slugs `createchatsession`, `submitquery`)
- `POST /chat/v1/sessions` — header `apikey`; body requires `externalUserId`; optional `pluginIds[]` (≤20). Docs say 200; live returns **201** (repo-proven). Live platform also accepts `agentIds[]` (the `agent-…` twin of each `plugin-…` id) — required since the 2026-07-19 platform change where query-time `pluginIds` returned HTTP 400 "agents are invalid"; translation lives in `server/ondemand.js toAgentIds()`.
- `POST /chat/v1/sessions/{sessionId}/query` — required `query`, `endpointId`, `responseMode ∈ {sync, stream, webhook}`; optional `pluginIds[]` (≤20), `fulfillmentOnly` (skip RAG/plugins), `modelConfigs { fulfillmentPrompt, temperature, topP, stopSequences[≤4], … }`. Sync 200 response: `data.{sessionId, messageId, answer, status ∈ processing|completed|failed}`. Top-level `reasoningEffort` is a **live-accepted extension** beyond the documented schema (repo-proven; documented in NOTES.md).
- Error envelope: 4XX `ClientErrorResponse` and 5XX `ServerErrorResponse`, both `{errorCode, message}`.

### 4.2 Streaming / SSE format (documented + live-verified in NOTES.md §2026-07-17)
- `responseMode: "stream"` → `text/event-stream`. Frames carry `eventType`: `planning_thinking`, `planning_output`, `step_thinking`, `step_output` (plugin-call args), `fulfillment` (answer token in `.answer`), `fulfillment_thinking` (`.thinking.delta`), plus `statusLog`, `metricsLog`, heartbeat frames `{sessionId, messageId, time}`, monotonic `eventIndex`, and terminal `data:[DONE]`. `event:` names observed on the wire: `thinking` / `message` / `heartbeat`.
- The repo's `/api/chat` proxy forwards frames 1:1 (pure passthrough) — the ODA run-event stream reuses the same transport primitives but emits **ODARunEvent** frames sourced from real backend state.

### 4.3 Media endpoints (slugs `createmediaurl`, `fetchmedia`, `deletemedia`)
- `POST /media/v1/public/file` — `{ url, name, sessionId?, externalUserId?, createdBy?, updatedBy?, plugins? }` → registers external media by URL.
- `GET /media/v1/public/file` — fetch media records; `DELETE` — remove. Used for run-artifact registration when an artifact must be addressable platform-side.

### 4.4 Workflow endpoints (Agents Flow Builder API)
- `POST /workflow/{id}/activate` · `POST /workflow/{id}/deactivate` · `POST /workflow/{id}/execute` · `POST /workflow/stream_logs` (SSE log stream). Relevant for scheduled/recurring ODA jobs; NOT used for the interactive run engine (which is session-scoped).

### 4.5 Model endpoint registry (`GET /config/v1/public/endpoints`, live 2026-07-22T17:49Z — 68 endpoints)
| Endpoint | Status | Key facts |
|---|---|---|
| `predefined-claude-sonnet-5` (`anthropic/claude-sonnet-5`) | **active** | 1,000,000 ctx · streaming true · `reasoning_efforts ["low","medium","max"]` — THE worker endpoint for every substantive ODA skill |
| `byoi-6e314690-4eaf-4def-a33c-380809acf1f5` (Cerebras, `zai-glm-4.7`) | **active** | 65,000 ctx · streaming true — THE low-latency interpreter endpoint (control JSON only) |
| `predefined-glm-4.7`, `predefined-glm-4.7-flash` | **inactive** | Registry entries exist but are INACTIVE — never ship against them (re-confirmed live today) |
| Any Gemini Flash endpoint | — | **FORBIDDEN by ODA model policy** (no Gemini Flash, no silent downgrades) — enforced in code, §5 row M14 |

---

## 5. The compatibility table — Claude construct → OnDemand-native replacement

| # | Claude construct (bundle v1.6.0) | OnDemand-native replacement (this port) |
|---|---|---|
| M1 | **`oda:oda` command** — orchestrator skill invoked in Claude chat | **ODA application orchestrator** — backend run engine (`server/oda/orchestrator.js`): GLM 4.7 interpretation → pipeline plan → sequenced Sonnet 5 worker execution → verification → synthesis, exposed at `POST /api/oda/runs` and driven by durable `ODARun` state |
| M2 | **Individual `oda:*` skills** (folders with SKILL.md frontmatter routed by Claude) | **Native registered OnDemand skills** — `ODASkillManifest` records in the backend skill registry (`server/oda/manifests.js`): id, version, purpose, input/output schemas, modes, artifact types, connectors, permitted calls, model endpoint, verification/timeout/retry policies. `summary` and `action-titles` register as compatibility routes into `storyline` |
| M3 | **Claude subagents** (opus/sonnet/haiku fan-out, independent verifier subagent) | **Sonnet 5 worker endpoint calls** — every substantive role (Thinker synthesis, Worker execution, Verifier audit) is a discrete `predefined-claude-sonnet-5` call through the central model module; parallel branches = concurrent Sonnet 5 calls on genuinely independent pipeline nodes; the independent verifier = a fresh Sonnet 5 call with the verifier system prompt (never the drafting call's context) |
| M4 | **`ask_user_input_v0` gates** (mode choice, step confirms, elicitation forms) | **Native tappable decision/approval components** — resumable backend gate states (`server/oda/gates.js`): a gate raises `question.required` on the run event stream with typed options; the run parks in `waiting_for_user`; `POST /api/oda/runs/:id/gates/:gateId` resolves it and the run resumes exactly where it paused |
| M5 | **MCP progress widget** (`mcp__visualize__show_widget`, STATE object) | **Native live ODA run-state components** — the UI renders run progress from the real `ODARunEvent` stream (`GET /api/oda/runs/:id/events`, SSE): statuses, per-node skill.started/progress/completed, verification outcomes. No timer-faked progress — every frame corresponds to a real state transition |
| M6 | **Local skill references** (`references/*.md` read from the skill folder at each step) | **Selectively loaded skill context** — the context loader (`server/oda/contextLoader.js`) builds each model request from ONLY: shared ODA execution rules + the selected skill's own context + the reference sections relevant to the current step + user attachments + prior VERIFIED artifacts + relevant project memory + the precise handoff. The whole bundle is NEVER loaded into a request |
| M7 | **Shared Trinity contract** (trinity.md vendored per skill) | **Shared OnDemand execution policy** — one policy module applied by the orchestrator to every node: Thinker planning (definition of done), Worker execution (self-report), Verifier gate (structured findings, PASS/REVISE/ESCALATE, loop caps), enforced in code rather than prose |
| M8 | **Skill outputs saved to folders** (`outputs/…` in the Claude sandbox) | **Versioned OnDemand run artifacts** — artifacts attach to the run (`artifacts[]` with `artifactId`, `type`, `version`, `status`, `producedBy`, `verification`), prior versions preserved on regeneration; materialisation via the existing artifact service (`server/artifacts.js`) and registrable platform-side via the Media API |
| M9 | **Claude file presentation** (inline renders/downloads in claude.ai) | **Native artifact preview/download dock** — `artifact.created` / `artifact.preview.updated` events feed the workspace dock; downloads via validated artifact URLs (existing HEAD/range-GET validation) |
| M10 | **Local scripts** (`build_model.py`, `render_tree_svg.py`, `fetch_data.py`, `build_workbook.py`) | **Sandboxed terminal/artifact workers** — server-side workers produce the same artifact classes (xlsx via exceljs / OnDemand Agent plugin, SVG/HTML via local assembly, PDF/DOCX via converter plugins) inside the run's artifact pipeline; no user-side script execution |
| M11 | **Web/API retrieval instructions** (in-skill WAM searches, aggregator-first fetch playbooks) | **Existing OnDemand connectors/plugins/MCPs/APIs** — the ADOPTED registry (Perplexity, Internet, GPT Search, Tavily, Web Extractor, File Directory…) attached per skill via `requiredConnectors`; retrieval runs as plugin-attached queries on the platform, keeping the no-invent + citation rules |
| M12 | **Hooks enforcing process gates** ("Continue to Step" trigger, frontmatter routing) | **Backend workflow guards + state-transition validation** — the run store enforces the legal status graph (idle→interpreting→planning→waiting_for_user↔executing→verifying→revising→completed/failed/cancelled); sequencing rules refuse illegal skill edges; a dependent stage cannot start before its input artifact passes verification — violations throw, they don't warn |
| M13 | **Claude session context** (chat memory, re-uploaded workbooks) | **OnDemand project/thread/run state** — durable `ODARun` documents (disk-persisted, reload-safe) carry request, intent, mode, pipeline, contextBundle, evidence, assumptions, decisions, artifacts, verification, events; resume after refresh/reconnection is a read of the run + SSE replay (`?since=seq`) |
| M14 | **Model recommendations as prose** ("suggested model: opus") | **Explicit OnDemand model endpoint routing** — central, testable, observable module (`server/oda/models.js`): ALL substantive skill endpoints → `predefined-claude-sonnet-5`; GLM 4.7 (Cerebras BYOI) ONLY for low-latency request interpretation emitting control JSON; **NO Gemini Flash, NO silent downgrades** (forbidden-endpoint assertion throws); GLM interpretation affecting final output must be confirmed by the relevant Sonnet 5 worker |
| M15 | **Self-learning files** (`self_learning/reflections.md`) | **Controlled project/skill-learning records** — opt-in learning entries stored as structured records on the project/run state (never mid-run, never auto-promoted); promotion to skill manifests is an explicit maintenance operation |

## 6. Pipeline sequencing rules (enforced by `server/oda/sequencing.js`)

Allowed downstream edges (a dependent stage starts ONLY after its input artifact passes verification):

```
problem-solve → storyline → design
benchmark    → storyline → design
benchmark    → problem-solve
data-scout   → problem-solve
problem-solve → data-scout → model → problem-solve   (evidence loop)
data-scout   → model → design
storyline(SUMMARY) → translate
media        → design
design       → storyline(TITLES)
translate    = terminal stage for final document layouts (English approved before Arabic)
```

Parallelisation: only genuinely independent branches (e.g. `benchmark` ∥ `data-scout` feeding a later
join) run concurrently. Skills communicate through **verified artifacts and structured state only** —
never through shared prose context.

## 7. Phase 2 module map (all new files under `server/oda/` — additive, nothing existing regenerated)

| File | Workstream | Contents |
|---|---|---|
| `server/oda/contracts.d.ts` | foundation | `ODASkillManifest`, `ODASkillHandoff`, `ODARun`, `ODARunEvent`, `VerificationFindings`, gate + control-JSON types |
| `server/oda/manifests.js` | (a) skill registration | 9 manifests (`oda` + 8 workers) + compat routes + registry accessors |
| `server/oda/sequencing.js` | (a) skill registration | Allowed-edge graph, pipeline validation, parallel-branch detection |
| `server/oda/models.js` | (b) central model config | Sonnet-5/GLM-4.7 routing, forbidden-endpoint guard, call log (observability), worker/interpreter call helpers |
| `server/oda/runStore.js` | (c) run state | Durable `ODARun` store: status graph + transition validation, disk persistence, pause/resume/retry/cancel/return-to-stage, artifact versioning |
| `server/oda/events.js` | (c) event streaming | `ODARunEvent` SSE bus over the existing transport pattern, replay via `?since=` |
| `server/oda/verifier.js` | (d) verification | Thinker–Worker–Verifier engine → structured findings JSON; defect-ownership routing |
| `server/oda/gates.js` | (d) gates | The ten approval gates as resumable backend gate states |
| `server/oda/interpreter.js` | integration | GLM 4.7 low-latency interpretation → control JSON (no chain-of-thought exposure), safe status labels, heuristic fallback |
| `server/oda/contextLoader.js` | integration | Selective context bundle builder (M6) |
| `server/oda/handoff.js` | integration | Typed `ODASkillHandoff` construction + validation |
| `server/oda/orchestrator.js` | integration | The run engine (M1): interpret → plan → gates → execute → verify → revise → complete |
| `server/oda/routes.js` | integration | Express router: runs CRUD, SSE events, gate resolution, lifecycle ops, registry/model observability |
| `server/index.js` | integration | Two-line additive mount of `/api/oda` |

**Non-breakage guarantee:** every existing route (`/api/chat`, `/api/conversations`, `/api/export`,
`/api/health`, intel/correlation/msm/voice surfaces) and the whole frontend build are untouched;
the ODA engine is mounted additively under `/api/oda/*`.
