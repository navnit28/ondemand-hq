# BASELINE_AUDIT.md — pre-implementation behavior record
Date: 2026-07-20 · HEAD fe9cad9 · captured via headless Chromium against the local build
(PORT 8099, deep-v2 run store: sparse KE-20260719072125 + dense BD-20260720021500).

## Baseline screenshots (repo `baseline/` — regression reference set)
| File | What it locks in |
|---|---|
| baseline/baseline-globe-landing.png | ODA Intelligence landing w/ COBE globe container, country rows, quick-start rail. ⚠ CAVEAT: the COBE WebGL canvas renders BLANK under headless-Chromium SwiftShader (GLOBE_SHOT canvas-check false) — layout/rows/cards captured; the sphere itself needs a GPU browser for pixel-accurate regression. |
| baseline/baseline-ke-sparse-graph.png | Sparse KE run (5 evidence · 4 tier edges): tier colors/styles, evidence badges, legend strip, filter chips, ECharts panels — post-de-purple state. |
| baseline/baseline-bd-dense-lod-zoomout.png | Dense BD-20260720021500 zoomed out: LOD discs, badge pills SUPPRESSED (<1.15× zoom gate), no pill soup. In-window graph = 28 nodes / 89 links (365-day default maxAge filter of the 188 stored edges). |
| baseline/baseline-bd-dense-lod-zoomin-badges.png | Same run at 3× zoom: badge pills visible per LOD gate, collision-aware placement. |
| baseline/baseline-bd-evidence-breakdown.png | Badge click → EvidenceBreakdown drawer OPEN (verified true): distinct-record count, relationship-type groups, per-edge evidence rows. |
| baseline/baseline-bd-relationship-inspector.png | Connection click → Relationship Inspector OPEN (verified true): tier + conf + claim + source types. |

Interaction verdicts recorded during capture: BREAKDOWN_OPEN=true · INSPECTOR_OPEN=true ·
BD graph 28 nodes/89 in-window links · badge LOD gates as designed.

## Privacy findings — media services (documentary basis ONLY; scan of all 26 public
OpenAPI specs fetched live 2026-07-20; zero keyword hits for retention/training/privacy)

| Question | Finding | Basis |
|---|---|---|
| Where is microphone audio sent? | App-controlled: mic audio stays in the browser (MediaRecorder) until POSTed to OUR server (/api/speech/transcribe); server calls OnDemand STT with an `audioUrl` — i.e. audio must be hosted at a URL the service fetches. | Recorder.jsx, speech.js, convertaudiototext spec |
| Raw audio retained/logged by OnDemand? | **Undocumented/deployment-dependent** — the docs define request/response only; no retention statement. Our server keeps blobs in-memory max 30 min (speech.js putAudio TTL). | docs scan; speech.js |
| Partial transcripts? | Not offered — STT is single-shot final transcript ({data:{text}}). No partial/streaming transcript API exists in the public docs. | convertaudiototext spec |
| Final transcripts persisted? | On OUR side: transcript enters chat flow like typed text (store.js in-memory). On OnDemand's side: **undocumented/deployment-dependent**. | docs scan |
| Generated audio (TTS) stored? | Our side: in-memory blob, 30-min TTL. OnDemand side: **undocumented**. | speech.js; converttexttoaudio spec |
| Third-party speech engines? | STRONG INDICATION: TTS model enum [tts-1, tts-1-hd] + voice enum [alloy, echo, fable, onyx, nova, shimmer] match OpenAI's TTS API surface — but the docs never NAME the provider ⇒ **inferred, not documented**. | converttexttoaudio spec |
| Data leaves deployment region? | **Undocumented** — no region/residency statements anywhere in the public specs. | docs scan |
| Retention configurable/deletable? | Media API has Delete Media (DELETE) for uploaded files; no retention-config or transcript-deletion API documented. | deletemedia spec; docs scan |
| Used for model training? | **Undocumented** — no training-use statement either way. | docs scan |

### Conservative in-product disclosure draft (verified behavior only)
> **Voice features & your data.** When you use the microphone, your audio is recorded in
> your browser and sent to the ODA server, which forwards it to the OnDemand speech
> service to produce a text transcript. The transcript is then handled exactly like a
> typed message. Our server keeps audio clips in memory for at most 30 minutes and does
> not write them to disk. The upstream speech service's own storage, retention, regional
> processing, and training practices are not specified in its public documentation; do
> not speak sensitive information you would not type into the chat.

## Rules locked for the upcoming voice/globe implementation
1. PRESERVE the deploy-time ONDEMAND_API_KEY injection model (env.js + keyLoaded) — no changes.
2. Voice must be TURN-BASED over documented APIs (record → host → STT → SSE LLM → TTS);
   VAD/barge-in are client-side constructs (AnalyserNode gating + SSE/audio abort).
3. GLM 4.7 = `byoi-6e314690-4eaf-4def-a33c-380809acf1f5` (only ACTIVE GLM 4.7 endpoint).
4. Brand: white/green, #159a7a/#1dac89 accents, purple grep must stay 0.
5. Globe renderer is COBE — extensions build on cobe's marker/onRender API, not a rewrite.
