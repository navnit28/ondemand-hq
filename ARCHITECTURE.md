# ARCHITECTURE.md — ODA Productivity Suite

**Phase 2 build · 2026-07-16 · completion pass 2026-07-16 ~21:30 UTC (post-audit): NOTES.md + PLUGIN_TESTS.md rebuilt from live API, public/ brand assets regenerated, all 10 adopted plugins re-verified HTTP 200, gap-fill data routes re-verified HTTP 200, redeployed to a fresh ephemeral Vercel Sandbox (preview URL in the run response)**
Stack: thin Node/Express backend (Vercel-serverless-compatible layout, `vercel.json` included) + Vite/React SPA. One repo, one deploy unit.

---

## 1 · Repository / file structure

```
app/
├── package.json              # single deploy unit: express server + vite SPA
├── vite.config.js            # dev proxy /api → :8080, allowedHosts, hmr off
├── vercel.json               # serverless mapping: /api/* → server/index.js, rest → static dist/
├── .env.example              # ONDEMAND_API_KEY / ONDEMAND_BASE_URL / PORT placeholders
├── .gitignore                # .env, node_modules, dist, uploads — no secrets in git, ever
├── index.html                # SPA shell + self-hosted @font-face (Montserrat, Lora, Noto Naskh Arabic)
├── public/
│   ├── oda-logo.png          # official ODA logo (bundled blueprint asset logo-oda.png, 640px; official web
│   │                         #  sources oda.gov.ae / mediaoffice.abudhabi unreachable — fetch attempts logged)
│   ├── oda-watermark.png     # watermark derived from the official bundled logo (700px transparent square)
│   ├── oda-watermark-faded.png # pre-faded 10%-alpha copy → document covers
│   └── fonts/*.woff2         # Montserrat 400/600/700, Lora 600, Noto Naskh Arabic 400 (RTL-safe)
├── server/                   # ── BACKEND ──
│   ├── env.js                # .env loader; ONDEMAND_API_KEY only from env; model policy constants
│   ├── index.js              # Express app: conversations, SSE chat, upload, country-data, exports, static
│   ├── router.js             # oda:oda THINK step — LLM classification + loud deterministic fallback
│   ├── prompts.js            # orchestrator/worker system prompts (FAST/FULL, verify gate, no-invent, trace)
│   ├── plugins.js            # VERIFIED plugin registry (Phase-1 ADOPT list) + feature→plugin map
│   ├── ondemand.js           # OnDemand client: session create (201), SSE parse (thinking vs answer), sync
│   ├── countryData.js        # DIRECT World Bank WDI / WHO GHO / UN SDG calls + country code resolution
│   ├── exports.js            # PPTX (pptxgenjs) / XLSX (exceljs) / DOCX (docx) / PDF (pdfkit) assembly
│   ├── extract.js            # upload text extraction: pptx (zip+xml), docx (mammoth), pdf (pdf-parse), xlsx
│   ├── store.js              # in-memory session-scoped store (conversations, files, artifacts) — resets on restart
│   └── data/country_codes.csv# bundled from blueprint country-data skill (330 countries, iso3/m49/region/income)
└── src/                      # ── FRONTEND (React SPA, 8-step UI spec) ──
    ├── main.jsx · App.jsx    # shell, state machine, streaming, wizard, exports, error handling
    ├── api.js                # fetch client + SSE reader
    ├── markdown.jsx          # sanitized markdown (marked+DOMPurify), ```options/```trace dissection
    ├── styles.css            # white minimal aesthetic; ODA accents from blueprint tokens.css
    └── components/
        ├── Sidebar.jsx       # 280px sidebar: logo, New chat, date-grouped history, 8 quick-start tools
        ├── Composer.jsx      # rounded input, attach (pptx/docx/pdf/xlsx), Enter-to-send
        ├── Messages.jsx      # bubbles, thinking accordion, trace card, artifact cards, skeletons
        └── PreviewPane.jsx   # wizard steps (Scope→Outline→Draft→Review→Export) + live HTML preview
```

Supporting repo docs: `ARCHITECTURE.md` (this file), Phase-1 `NOTES.md` (API digest) and `PLUGIN_TESTS.md` (verification log) at the workspace root; blueprint bundle at `./oda-plugin/`.

---

## 2 · Model policy (uniform, verified)

Every model call on every endpoint — router classification, all 8 workers, wizard steps, title generation — uses **gpt-5.6-sol-medium**, implemented exactly as Phase 1 verified it against the live API:

```json
{ "endpointId": "predefined-gpt-5.6-sol", "reasoningEffort": "medium", "responseMode": "stream" }
```

(The suffixed id `predefined-gpt-5.6-sol-medium` is invalid → HTTP 400; the decomposition returns 200.) Streaming is ON everywhere user-facing; reasoning tokens are requested via `reasoningEffort` and surfaced when the model emits `fulfillment_thinking` frames. There is **no silent model fallback**: any OnDemand non-2xx is logged loudly (`🔴 [HARD-FAIL] …`) and surfaced to the UI as an error event with retry. The only fallback anywhere is the router's deterministic keyword classifier, which logs `🔴 [FALLBACK]` when the LLM router fails so routing never bricks a request.

## 3 · SSE pipeline — thinking vs answer separation

```
Browser ──POST /api/chat (JSON)──► Express ──POST /chat/v1/sessions/{id}/query (SSE)──► OnDemand
Browser ◄──SSE: routing│plugin_status│thinking│answer│metrics│done│error── Express ◄── SSE frames
```

Upstream frames (verified byte-level in Phase 1) are normalized server-side:

| Upstream (`eventType`) | Payload path | Proxied to browser as |
|---|---|---|
| `fulfillment_thinking` | `.thinking.delta` | `{type:"thinking", delta}` → collapsed "Thinking…" accordion (live-streams while open, auto-collapses when the answer starts, always re-expandable) |
| `fulfillment` | `.answer` | `{type:"answer", delta}` → token-by-token markdown stream |
| `statusLog` | `.currentStatusLog` | `{type:"status"}` → skeleton loader text |
| `metricsLog` | `.publicMetrics` | `{type:"metrics"}` |
| `data:[DONE]` | — | `{type:"done"}` |

The gpt-5.6 family emitted no thinking frames in Phase-1 captures (model-dependent behaviour); the UI therefore renders the accordion only when thinking deltas actually arrive — nothing breaks when they don't.

## 4 · Feature → plugin map (only Phase-1 ADOPTed plugins ship)

| Product feature | Attached plugins (verified ids) | Data route |
|---|---|---|
| **design / deck** | GPT Image 2 `plugin-1776826082` · Internet `plugin-1713924030` · Perplexity `plugin-1722260873` | imagery + WAM/u.ae verification |
| **summary** | File Directory `plugin-1743257072` · Web Extractor `plugin-1737365406` | + server-side upload extraction |
| **problem-solve** | Internet · Perplexity · GPT Search `plugin-1741871229` | research evidence |
| **benchmark** | Perplexity · Internet · Tavily `plugin-1740745780` | evidence funnel (3ie/J-PAL/WB IEG/OECD via web) |
| **translate** | *(none — LLM-direct)* | no translation plugin exists; platform translate service was 502; blueprint treats translate as a prompt/QA discipline |
| **media** | Perplexity · Internet · GPT Image 2 | WAM-style verification + visuals |
| **action-titles** | *(none — pure LLM)* | blueprint: always-FAST |
| **country-data** | Internet (fallback only) | **primary: DIRECT keyless APIs** — World Bank WDI v2, WHO GHO OData, UN SDG UNSD (live-verified HTTP 200 in Phase 1 AND re-verified 2026-07-16 21:26 UTC: 563/629/810 ms); server fetches → tags rows `[fact]` with per-row citations → model may ONLY use those rows |

Rejected plugins (dead backing services, inactive configs — see PLUGIN_TESTS.md) are not referenced anywhere in the code.

**Re-verification status (2026-07-16 21:04–21:07 UTC):** all 10 adopted plugin ids above were re-tested live (session create 201 + representative query 200 + sane output) — 10 ADOPT / 0 REJECT, zero downgrades; full log in PLUGIN_TESTS.md. **Custom gap-fill plugins:** the OnDemand tool-creation surface returned Cloudflare 524 origin timeouts on both attempts this run (21:19:40Z, 21:26:21Z — logged in PLUGIN_TESTS.md), so the country-data gap remains covered by the direct keyless API route above; when the surface recovers, the three sources can be wrapped as free custom plugins with `plugins.js` as the only touch point.

## 5 · Mode logic (oda:oda routing, mirrored from the blueprint SKILL.md)

1. **Router** (`server/router.js`): every turn is classified on gpt-5.6-sol-medium with `ROUTER_PROMPT` → `{feature, mode, analysisFirst, outOfScope}`. User quick-start tool selection overrides the lane; the wizard forces FULL.
2. **FAST vs FULL** (deterministic table in the prompt): FAST = one deliverable, one lane, small scope. FULL = pipelines, 3+ page decks, Chairman/board/Presidential-Court-bound work, file translations, multi-asset media, 40+ slide sources.
3. **§1.0 analysis-first bright line**: analyse/assess/recommend/strategy-class requests targeting design/media/summary get an ANALYSIS-FIRST instruction — the problem-solve discipline runs before any rendering, inside the same reply.
4. **§0.0 out-of-scope stop**: requests outside the eight crafts trigger announce-the-gap behaviour (list the eight, ask, produce nothing).
5. **Sourced-data hook**: country-data fetches run server-side BEFORE the model sees the request; the prompt receives only `[fact]`-tagged rows with citations, enforcing never-invent-a-number structurally, not just rhetorically.

## 6 · Verify gate + the one-deliverable contract

Every worker prompt ends with the shared HOUSE RULES block, which encodes the blueprint's two hard rules:

- **No-invent:** every figure tagged `[fact] / [assumption] / [from-web]`; every named UAE entity WAM/u.ae-verified via the attached search plugins or written as `[VERIFY AGAINST WAM — name]`; unavailable data goes to a "Gaps" line, never guessed.
- **One verified deliverable + routing trace:** the model must run a self-verify pass (voice, tags, entity checks, completeness) and end with a fenced ```trace block — `Mode / Worker / QA / Flags`. The UI renders it as the slim expandable trace card (Step 5), alongside the server-side routing metadata (worker, mode, plugins attached, model, router source).
- In the guided wizard, **Review is a dedicated gate step**: the model re-checks the draft against the house standards, outputs a Check/Result/Fix table, then the corrected final — before Export is offered.

## 7 · Guided document creation (Step 6)

Wizard = `Scope → Outline → Draft → Review → Export`, driven by per-step system-prompt overlays (`prompts.js WIZARD_INSTRUCTIONS`). Each step asks at most ONE question with tappable options (parsed from the model's ```options block). The Draft/Review steps emit `<section class="oda-slide">` HTML that the preview pane renders live as 16:9 scaled slide frames while tokens stream; clicking any slide/section sends a targeted EDIT REQUEST for that section only. Export taps route straight to `/api/export`.

## 8 · Exports (Step 7)

`server/exports.js` parses the draft (oda-slide HTML or markdown) into a section model, then assembles:

- **PPTX** — pptxgenjs, 16:9, white slides, Lora-styled action-title band with gold rule, watermark + logo + Montserrat-gold title on the cover (the blueprint's one cover exception), cover date "July 2026", closing "Sources and gaps" slide.
- **XLSX** — exceljs: Cover / Data (country-data rows with per-row citation column when present) / Sources & QA sheets.
- **DOCX** — docx: watermarked cover, Lora headings, bullets, sources-and-gaps section.
- **PDF** — pdfkit: watermarked cover + sectioned pages + sources page.

Every artifact card in-chat shows filename, type icon, Download + Open preview, its **citations**, and a **gaps list** for unverifiables. Artifacts live in the in-memory store (session-scoped, reset on restart — matching the session-scoped product contract).

## 9 · Security posture

- `ONDEMAND_API_KEY` is read ONLY from environment (`.env`, chmod 600, gitignored; `.env.example` ships). It never appears in source, logs (only the last 4 chars are echoed at boot), or the browser — all OnDemand calls are server-side.
- Upload handling is in-memory with a 25 MB cap; extraction is text-only.
- All rendered model HTML/markdown passes through DOMPurify with a tag/attr allow-list.

## 10 · Known trade-offs

- In-memory store = sidebar history resets on server restart (explicit product requirement).
- PPTX/DOCX/PDF assembly is deterministic template-based (native text boxes, editable) rather than the blueprint's full HTML-capture pipeline — the right scope for a serverless preview build; the section model keeps the swap possible later.
- Thinking-token UI depends on the model actually emitting `fulfillment_thinking` frames (gpt-5.6-sol did not in Phase-1 captures; the accordion appears whenever frames arrive).
- Vercel Sandbox previews sleep on TTL expiry; `vercel.json` documents the equivalent serverless mapping for a persistent deployment.
