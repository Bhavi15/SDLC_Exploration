# SDLC — VS Code Extension System Guide

_Last updated: April 2026 — v0.2_

---

## What This System Is

A VS Code extension (user-facing name: **SDLC**) that takes design files (images, PDFs, metadata, style guides) and a user prompt, and produces a complete, production-ready project — any framework (React, Angular, Vue, Svelte, Next, plain HTML). The engine is GitHub Copilot via the VS Code Language Model API. No external services, no cloud dependencies beyond Copilot.

The user adds source files to a Knowledge Base, processes them into structured markdown with rich metadata using **type-aware extraction prompts**, then generates code using a **delimiter-based output format** that avoids JSON escaping failures. The system dynamically retrieves only the relevant KB documents for each generation — not a naive dump of everything.

**Naming:** The user-facing display name is "SDLC" but the internal configuration namespace (`figmaCode.*`), command IDs, and folder defaults (`.figma-code/*`) are preserved for backward compatibility with existing workspaces.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension (display name: SDLC)                 │
│                                                          │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────┐ │
│  │ Sidebar   │   │ Editor Panel │   │ Extension Host   │ │
│  │ Tree View │   │ (Webview)    │   │                  │ │
│  │           │   │              │   │  extension.ts    │ │
│  │ KB files  │   │ Model picker │   │  ├─ ui/          │ │
│  │ browser   │   │ Image attach │   │  ├─ kb/          │ │
│  │           │   │ Prompt input │   │  ├─ generate/    │ │
│  │           │   │ Status bar   │   │  └─ prompts/     │ │
│  └──────────┘   └──────────────┘   └──────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Two Lifecycles

### Knowledge Base Lifecycle

Runs when users add files. Independent of generation. Files go through:

1. **File added to inbox** → raw source (PDF, DOCX, image, text, code)
2. **Hash cache check** → SHA-256 of source, skip if matching `source_hash` exists in KB
3. **Library extraction** → `extract.ts` pulls raw text/image data (no LLM)
4. **Type-aware prompt routing** → design/code/spec prompt selected by file extension
5. **KB Processor** → 1 LLM call per NEW file, produces ONE `.md` per source with rich frontmatter
6. **Quality heuristics** → flag poor/warn/ok based on local checks
7. Runs in **parallel** with concurrency limit 3

### Generation Lifecycle

Runs when user clicks Generate:

1. **Dynamic budget** → `computeBudget(model)` reads model's context window
2. **Smart retrieval** → tag matching + LLM routing selects relevant KB docs
3. **Prompt compilation** → Handlebars template with KB context + user prompt
4. **Generation** → 1 LLM call, produces **delimiter-formatted** output (not JSON)
5. **Delimiter parsing** → extracts framework + file list, no JSON escaping issues
6. **File writing** → files written to output directory

---

## File Structure

```
src/
├── extension.ts              # Entry point: commands, tree view, file watcher
├── kb/
│   ├── extract.ts            # File extraction: PDF, DOCX, images, text
│   ├── processor.ts          # Type routing, hash caching, quality checks, LLM helpers
│   ├── index.ts              # listKbFiles() — only remaining helper
│   └── retrieval.ts          # Smart retrieval: tag matching + LLM routing + dynamic budget
├── generate/
│   └── generate.ts           # Project generation pipeline + parseDelimitedOutput
├── ui/
│   ├── webview.ts            # Full editor-tab panel with parallel inbox processing
│   └── tree.ts               # Sidebar KB tree view
├── webview/
│   └── main.ts               # Client-side webview script
└── prompts/
    ├── kb-processor-design.md    # Exhaustive visual extraction
    ├── kb-processor-code.md      # API surface + conventions
    ├── kb-processor-spec.md      # Rule extraction with MUST/SHOULD/MAY
    └── generate.md               # Delimiter-format project generation
```

**Removed in v0.2:**
- `src/prompts/kb-processor.md` — replaced by three type-specific prompts
- `rebuildIndex()` function and `_index.md` generation (dead code)
- `buildKbContext()` function (dead code)
- `hasKbContent()` function (dead code)

---

## The Knowledge Base

### Philosophy: llm.txt (Karpathy)

Each source file becomes ONE comprehensive `.md` document — not fragmented into dozens of chunks. Dense, structured, human-readable, git-versionable. When the full KB fits in the model's available context, send everything. When it doesn't, use smart retrieval.

### Type-Aware Processing (v0.2)

The previous single `kb-processor.md` prompt treated every file type identically, producing shallow results for non-image sources. v0.2 routes by file extension to one of three type-specific prompts:

| Extensions | Prompt | Extracts |
|-----------|--------|----------|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf` | `kb-processor-design.md` | Exact hex colors, all five typography axes, spacing in px, component states, spatial relationships |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.css`, `.html`, `.json`, `.yaml`, `.yml` | `kb-processor-code.md` | Exported symbols, prop interfaces, naming conventions, import patterns, styling approach |
| `.md`, `.txt`, `.docx` | `kb-processor-spec.md` | Rules as bullets with MUST/SHOULD/MAY, exact thresholds, prohibitions alongside prescriptions |

Routing happens in `selectPromptName(ext)` in `processor.ts`.

### Frontmatter Schema (v0.2)

Every KB `.md` file has this YAML frontmatter:

```yaml
---
source: original-filename.pdf
source_hash: a1b2c3d4e5f67890      # NEW in v0.2 — cache key
title: "Descriptive title extracted by LLM"
app: dashboard                     # or "shared" for design systems
tags: [colors, spacing, tokens, dashboard, sidebar, navigation]
component_types: [navigation, sidebar, data-table]
summary: "Admin dashboard design tokens — primary #1A73E8, spacing 4-32px scale, dark sidebar"
quality: ok                        # NEW in v0.2 — ok/warn/poor
---
```

**Fields:**

| Field | Purpose | Used by |
|-------|---------|---------|
| `source` | Original filename for traceability | Display only |
| `source_hash` | SHA-256 prefix of source bytes | Cache lookup to skip unchanged files |
| `title` | Human-readable title | Retrieval scoring, display |
| `app` | Which app/project this belongs to | Retrieval: app grouping, scoring (+5) |
| `tags` | 10-25 keywords for matching | Retrieval: keyword scoring (+3) |
| `component_types` | UI component types covered | Retrieval: type scoring (+4) |
| `summary` | Dense 1-2 sentence description | Retrieval: keyword scoring, LLM routing |
| `quality` | Heuristic quality flag | UI warnings |

### Hash-Based Caching (v0.2)

Before any LLM call, `processKbFile()` computes `sha256(fileBuffer).slice(0, 16)` and scans existing KB docs for a matching `source_hash`. If found, processing is skipped entirely — no LLM call. This makes re-running "Process Inbox" free for unchanged files.

Cache key is content-based, not filename-based. Renaming a source file does not bypass the cache.

### Quality Heuristics (v0.2)

`assessQuality()` runs local checks after processing:

| Check | Flag |
|-------|------|
| Body length < 200 chars | `poor` |
| Body contains "placeholder" / "vision processing failed" | `poor` |
| Fewer than 3 tags | `warn` |
| Design file has no hex colors AND no px values | `warn` |
| Body length < 500 chars | `warn` |
| Everything passes | `ok` |

`poor` results produce UI error messages. `warn` results produce yellow status notes. Users are alerted when KB docs may be incomplete before they generate from them.

### Parallel Processing (v0.2)

`_processInbox()` runs a bounded concurrency pool with 3 workers. Files enter a shared queue; workers pull and process until the queue empties. 20 files now take ~6.7× the time of one file instead of 20×.

### Supported Input Formats

| Format | Extraction | Library |
|--------|-----------|---------|
| PDF | Text extraction | `pdfjs-dist` |
| DOCX | Text extraction | `mammoth` |
| PNG/JPG/GIF/WEBP | Vision pass (LLM) or fallback placeholder | VS Code LM API |
| MD/TXT/TS/JS/JSON/CSS/HTML/YAML | Direct read | Node fs |

### Image Handling

When an image is added to KB:
1. Try vision model with the design-aware prompt
2. If model rejects image (400 "media type not supported") → fallback placeholder
3. Placeholder is detected by quality heuristics and flagged as `poor`

---

## Smart Retrieval System

`retrieval.ts` — the core retrieval engine. No hardcoded rules. Adapts dynamically.

### Dynamic Budget (v0.2)

`computeBudget(model)` reads `model.maxInputTokens` at retrieval time:
- Reserves 16,000 tokens for generation prompt + output
- Uses the remainder as `maxRetrieval`
- Uses 60% of the remainder as the "send everything" threshold

Replaces the previous hardcoded `30_000` / `40_000` constants that wasted context on larger models.

| Model | Window | "Send all" threshold | Max retrieval |
|-------|-------:|---------------------:|--------------:|
| gpt-4o | 128k | 67,200 | 112,000 |
| claude-3.5-sonnet | 200k | 110,400 | 184,000 |
| Fallback | 64k | 28,800 | 48,000 |

### Flow

```
All KB docs loaded with frontmatter
         │
         ├── Total under fullContextLimit?
         │   └── YES → send everything (0 LLM calls)
         │
         ├── Tag pre-filter: score each doc against prompt keywords
         │   │
         │   ├── ≤ 3 clear winners with score gap?
         │   │   └── Expand related + shared → done (0 LLM calls)
         │   │
         │   └── Ambiguous (4+ candidates or 0 matches)?
         │       └── LLM routing call (1 cheap call, summaries only)
         │
         ├── Expand related docs (same app + Jaccard tag overlap ≥ 0.25)
         │
         ├── Always include "shared" app docs
         │
         └── Trim to maxRetrieval token budget
```

### Scoring Weights

| Match type | Score | Example |
|-----------|-------|---------|
| App name exact match | +5 | prompt: "dashboard" → app: "dashboard" |
| Component type match | +4 | prompt: "form" → component_types: ["form"] |
| Exact tag match | +3 | prompt: "navigation" → tags: ["navigation"] |
| Title contains keyword | +2 | prompt: "tokens" → title: "Dashboard Design Tokens" |
| Summary contains keyword | +1 | |
| Any metadata contains keyword | +0.5 | |

### Relationship Expansion

After primary selection, `expandRelated()` discovers related docs:

1. **Same app grouping** — if `dashboard-tokens.md` is selected, all other `app: dashboard` docs are pulled in
2. **Tag overlap (Jaccard ≥ 0.25)** — docs sharing 25%+ of tags are included
3. **Shared docs** — all `app: shared` docs always included

### LLM Routing (when tag matching is ambiguous)

Sends ONLY frontmatter summaries (~50 tokens/doc) + user prompt to the model. Returns JSON with a filename array. Index is reconstructed in memory from loaded `KbDoc` objects every time. No `_index.md` consulted.

---

## Generation Pipeline

### Inputs

1. **KB context** — selected by smart retrieval
2. **User prompt** — free text describing what to build
3. **Design image** (optional) — attached via UI, sent as `LanguageModelDataPart.image()`

### Delimiter Output Format (v0.2)

v0.1 asked the model to return a single JSON object with all file contents embedded as strings. JSON escaping of TypeScript, JSX, and regex-heavy code frequently corrupted long outputs.

v0.2 uses a file-delimiter format:

```
FRAMEWORK: react

=== FILE: package.json ===
<raw file content>

=== FILE: src/App.tsx ===
<raw file content>
```

Raw content between delimiters. No escaping required. The model's cognitive load drops and the parser cannot be defeated by escape errors.

### Parser: `parseDelimitedOutput()`

Implemented in `generate.ts`. Lenient:
1. Strips outer markdown fence if model wrapped the whole response
2. Finds first `FRAMEWORK: <name>` line
3. Tokenizes on `=== FILE: <path> ===` delimiters
4. Captures content between delimiters, trims delimiter newlines
5. Strips inner fences if individual file bodies were fence-wrapped

### Generate Prompt (rewritten in v0.2)

`generate.md` now includes:
- Explicit evaluation rubric (pixel fidelity + runnable correctness)
- Silent chain-of-thought planning steps before file emission
- Seven non-negotiable accuracy rules
- Four non-negotiable completeness rules
- Strict delimiter format specification with positive and negative examples

### Vision Fallback

If the selected model doesn't support vision, logs warning and retries text-only. Generation still works.

---

## UI

### Editor Panel (`PipelinePanel`)

Full editor-tab webview. Singleton via `PipelinePanel.createOrShow()`. Title: **SDLC**.

**Header:** Brand mark (`S`) + SDLC name + v0.2 tag + model picker dropdown

**Sidebar:** KB file list, inbox list, Add Files button, Process → KB button

**Main:** Image attachment zone, prompt textarea, Generate Project button, generated files chip grid

**Status bar:** Progress, errors, completion messages, quality warnings

### Sidebar Tree View (`KbTreeProvider`)

Activity bar icon ("SDLC") → tree view of KB folder. Click any `.md` to open it. Auto-refreshes via `FileSystemWatcher`.

### Model Picker

Dropdown populated from `vscode.lm.selectChatModels({ vendor: 'copilot' })`. Defaults to `gpt-4o`.

---

## Workspace Folders

Folder paths kept as-is from v0.1 for backward compatibility:

```
.figma-code/
├── kb-inbox/           # Raw sources dropped by user (deleted after processing)
├── knowledge-base/     # Processed .md files with frontmatter
│   ├── dashboard-tokens.md
│   └── ...
└── generated/          # Output from generation
    ├── package.json
    └── src/
```

Configurable via VS Code settings:
- `figmaCode.knowledgeBaseFolder` (default: `.figma-code/knowledge-base`)
- `figmaCode.kbInboxFolder` (default: `.figma-code/kb-inbox`)
- `figmaCode.outputFolder` (default: `.figma-code/generated`)

`_index.md` is no longer generated. Old instances are harmless.

---

## LLM Calls Summary

| Operation | When | Calls | Cost |
|-----------|------|-------|------|
| KB Processing | Per NEW file (cached files skip) | 1 per new file | Medium |
| Smart Retrieval | Per generation, only if ambiguous | 0 or 1 | Cheap (summaries only) |
| Code Generation | Per generation | 1 | Heavy |

**Typical generation:** 1-2 LLM calls total.

---

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `gray-matter` | Parse YAML frontmatter |
| `handlebars` | Prompt template engine |
| `pdfjs-dist` | PDF text extraction |
| `mammoth` | DOCX text extraction |

Node built-in `crypto` is used for SHA-256 hashing (v0.2) — no new dependency.

### Dev

| Package | Purpose |
|---------|---------|
| `typescript` | Language |
| `webpack` + `webpack-cli` + `ts-loader` | Bundling (two configs: extension + webview) |
| `copy-webpack-plugin` | Copy prompt `.md` files and assets to dist |
| `@types/vscode` + `@types/node` | Type definitions |
| `eslint` + `@typescript-eslint/*` | Linting |

### Intentionally Not Included

| Package | Why |
|---------|-----|
| `langchain` | Overkill — pipeline is simple, custom-built |
| `chromadb` / `pinecone` / any vector DB | Frontmatter tags + LLM routing replace similarity search |
| `openai` SDK | VS Code LM API handles all LLM communication |
| `axios` / `node-fetch` | VS Code LM API handles HTTP |
| `zod` | JSON try/catch + delimiter parser is sufficient |
| `js-tiktoken` | `chars / 4` approximation is good enough |

---

## Build

```bash
npm run compile      # Development build
npm run watch        # Watch mode
npm run package      # Production build
npm run lint         # ESLint
```

Webpack produces two bundles:
1. **Extension** (`dist/extension.js`) — Node.js target, copies `prompts/*.md` and `media/`
2. **Webview** (`dist/webview.js`) — Browser target

---

## Design Decisions

### Why type-aware KB prompts

v0.1 used one generic prompt for every file type. A design image and a TypeScript file and a policy document went through identical instructions to "extract exact hex colors and pixel values." Non-image sources produced shallow output. v0.2 splits into three type-specific prompts because extraction style must match source type.

### Why delimiter output instead of JSON

Modern models escape long embedded code strings unreliably. JSON-encoded file contents are a fundamentally fragile output format for large code generations. Delimiter format eliminates escaping entirely — raw file bodies pass through unchanged.

### Why hash-based caching

Re-processing unchanged files wasted LLM calls. Content hash (not filename) is the right cache key because renames should not bypass the cache.

### Why dynamic token budget

Hardcoded 30k/40k constants wasted 60-75% of GPT-4o (128k) and Claude (200k) context windows. `model.maxInputTokens` gives the real available window at retrieval time.

### Why one LLM call for generation

Modern 128k+ context models handle full page generation in a single call. Splitting into Analyze → Generate → Validate adds latency and loses the model's internal consistency.

### Why tag-based retrieval, not vector embeddings

VS Code LM API has no embedding endpoint. Frontmatter tags are explicit, auditable, human-editable, and work offline. LLM routing handles the cases tag matching can't.

### Why llm.txt philosophy, not RAG chunking

Chunking destroys document coherence. One dense `.md` per source keeps context intact.

### Why Handlebars, not template literals

Keeps prompts in `.md` files, git-diffable and non-engineer-editable.

### Why the SDLC rename preserved `figmaCode.*`

Changing the configuration namespace would silently break every existing user workspace. The rename is display-only.
# currentDate
Today's date is 2026-04-12.
