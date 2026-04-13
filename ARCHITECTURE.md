# SDLC — Architecture & System Documentation

_Last updated: April 2026 — v0.2_

---

## What Is This?

SDLC is a **VS Code extension** that converts design files — images, PDFs, Word documents, style guides, and code files — into complete, production-ready frontend projects. The user describes what they want built, provides their design sources, and the system generates a working codebase.

The engine is **GitHub Copilot via the VS Code Language Model API**. There are no external API keys, no cloud pipelines, no proprietary backends. Everything runs inside the VS Code extension host.

The configuration namespace, command IDs, and workspace folder defaults remain `figmaCode.*` and `.figma-code/` internally for backward compatibility with existing user workspaces. Only the user-facing display name was rebranded to SDLC.

---

## High-Level Architecture

The system is built around two independent pipelines that operate in sequence:

```
[Design Sources] → [Knowledge Base Pipeline] → [Structured KB Docs]
                                                        ↓
[User Prompt + Optional Image] → [Generation Pipeline] → [Project Files]
```

**Knowledge Base Pipeline** — runs ahead of time. Converts raw sources into rich structured documents using file-type-aware extraction. Independent of generation.

**Generation Pipeline** — runs on demand. Retrieves the relevant parts of the KB, compiles a prompt, and asks Copilot to write the project using a delimiter-based output format.

---

## Module Map

| Module | File | Role |
|--------|------|------|
| Extension entry point | `src/extension.ts` | Registers commands, tree view, file watchers, ensures workspace folders exist |
| File extraction | `src/kb/extract.ts` | Reads raw source files — no LLM involved here |
| KB processor | `src/kb/processor.ts` | Type-aware LLM processing, hash caching, quality heuristics |
| KB context builder | `src/kb/index.ts` | Single-function file listing utility for the tree view |
| Smart retrieval | `src/kb/retrieval.ts` | Selects the right KB docs for a given prompt with dynamic budgeting |
| Generation pipeline | `src/generate/generate.ts` | Retrieval → prompt compilation → LLM call → delimiter parsing → file writing |
| Webview panel | `src/ui/webview.ts` | Editor tab UI with parallel inbox processing |
| Sidebar tree | `src/ui/tree.ts` | Activity bar tree view of KB files |
| Webview client | `src/webview/main.ts` | Runs in the browser-like webview context; handles all UI interactions |
| Design prompt | `src/prompts/kb-processor-design.md` | Exhaustive visual spec extraction |
| Code prompt | `src/prompts/kb-processor-code.md` | API surface + conventions extraction |
| Spec prompt | `src/prompts/kb-processor-spec.md` | Rule-based extraction with MUST/SHOULD/MAY |
| Generate prompt | `src/prompts/generate.md` | Delimiter-format project generation |

---

## Lifecycle 1 — Knowledge Base Processing

### Purpose

Before generation can happen, source materials are transformed into a form the LLM can use efficiently. The KB pipeline converts raw sources into rich markdown documents with YAML frontmatter — one document per source.

### Flow

```
User adds files → kb-inbox/
         ↓
Parallel worker pool (concurrency 3)
         ↓
For each file:
  1. Read source buffer, compute SHA-256 hash
  2. Check KB for matching source_hash → skip if cached
  3. Route by file extension to the right prompt:
       .png/.jpg/.pdf → kb-processor-design
       .ts/.js/.css/.json → kb-processor-code
       .md/.txt/.docx → kb-processor-spec
  4. Extract file content (no LLM)
  5. LLM call with type-specific prompt
  6. Parse JSON response, validate quality heuristics
  7. Write .md with frontmatter including source_hash and quality
```

### Extraction (no LLM)

`extract.ts` handles every file format before an LLM ever sees them:

- **PDF** — `pdfjs-dist` walks each page and concatenates all text items
- **DOCX** — `mammoth` extracts raw text from Word document XML structure
- **Images (PNG/JPG/GIF/WEBP)** — loaded into a `Uint8Array` buffer and passed as base64
- **Text files (MD/TS/JS/JSON/CSS/HTML/YAML)** — read as UTF-8 string directly

### Type-Aware LLM Processing

`selectPromptName(ext)` in `processor.ts` routes every file to the correct prompt:

| Extension set | Prompt | What it extracts |
|---------------|--------|------------------|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf` | `kb-processor-design.md` | Exact hex colors, all five typography axes, spacing in px, component states, spatial relationships, UI component inventory |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.css`, `.html`, `.json`, `.yaml`, `.yml` | `kb-processor-code.md` | Exported symbols with signatures, prop interfaces, naming conventions, import patterns, styling approach, side effects |
| `.md`, `.txt`, `.docx` | `kb-processor-spec.md` | Rules as actionable bullets with MUST/SHOULD/MAY polarity, exact thresholds, prohibitions alongside prescriptions |

Each prompt applies tighter, type-appropriate rules. A design prompt asks for hex values; a code prompt asks for API surfaces; a spec prompt asks for rule extraction. The previous single generic prompt produced inconsistent quality across file types because one extraction style does not fit all sources.

For images, the flow still attempts vision first, catches the `400 media type` error on non-vision models, and falls back to a placeholder KB entry. The placeholder entry is now detected by the quality heuristic and flagged as `poor` so the user is warned.

### Hash-Based Caching

Before any LLM call, `processKbFile()`:

1. Reads the source file into a buffer
2. Computes `sha256(buf).slice(0, 16)` as the cache key
3. Calls `findCachedKbDoc(kbDir, hash)` which scans existing KB docs' frontmatter for a matching `source_hash`
4. If found, returns immediately with `cached: true` — no LLM call is made

This makes re-running "Process Inbox" free for unchanged files. It also protects against accidental double-processing and lets users safely re-process after a cancelled run.

The cache key is content-based, not filename-based. Renaming a source file does not bypass the cache.

### Quality Heuristics

After processing, `assessQuality()` runs local heuristic checks:

| Check | Flag |
|-------|------|
| Body length < 200 chars | `poor` |
| Body contains "placeholder" / "vision processing failed" | `poor` |
| Fewer than 3 tags | `warn` |
| Design file has no hex colors AND no px values | `warn` |
| Body length < 500 chars | `warn` |
| Everything passes | `ok` |

The flag is embedded in the KB doc's frontmatter and returned from `processKbFile()`. The UI shows `poor` items as errors and `warn` items as progress notes, so users know to review questionable docs before generating from them.

### YAML Frontmatter Schema

Every KB document now has this header:

```yaml
---
source: dashboard.png
source_hash: a1b2c3d4e5f67890
title: "Admin Dashboard Design Tokens"
app: dashboard
tags: [dashboard, tokens, colors, typography, spacing]
component_types: [navigation, sidebar, data-table]
summary: "..."
quality: ok
---
```

New fields vs. v0.1: `source_hash` (for caching) and `quality` (for warnings).

### Parallel Processing

`_processInbox()` in `webview.ts` uses a bounded concurrency pool with 3 workers. All files enter a shared queue; workers pull and process until the queue empties. 20 files finish in roughly 6.7× the time of one file instead of 20×.

### Removed in v0.2: `_index.md`

Previous versions wrote a `_index.md` table of contents after every processing run via `rebuildIndex()`. Retrieval code explicitly filtered this file out; the LLM router reconstructed its own index from in-memory `KbDoc` objects. The file was dead code — written, never read.

Removed in v0.2:
- `rebuildIndex()` function
- `buildKbContext()` function (also unused)
- `hasKbContent()` function (also unused)

---

## The `llm.txt` Philosophy (Karpathy Reference)

This system is directly inspired by Andrej Karpathy's `llm.txt` idea: **one comprehensive document per source, not dozens of fragments**.

The traditional RAG approach chunks documents, embeds chunks as vectors, and retrieves the closest ones by cosine similarity. This system explicitly rejects that approach.

### Why not RAG / vector embeddings?

- **Context destruction** — A design token's color, its name, its usage context, and its responsive variant may be 500 tokens apart in a document. Chunking splits them apart and they may never be retrieved together.
- **No embedding endpoint** — The VS Code Language Model API does not expose an embedding endpoint. Adding a local ONNX model would add ~5MB to the bundle and startup latency.
- **Vectors are opaque** — You cannot inspect why a chunk was retrieved. Tag-based scoring is auditable and human-editable.
- **Overhead without benefit** — For a KB under the full-context threshold, sending everything is correct and costs nothing extra.

Each source file becomes ONE `.md` document. Dense, structured, containing every value that was in the original. When the total KB fits in the model's available context, everything is sent.

---

## Lifecycle 2 — Smart Retrieval

### Purpose

When the total KB exceeds the model's available context, retrieval selects only the relevant documents. It adapts dynamically based on KB size and how clearly the prompt matches documents.

### Dynamic Budget (v0.2)

In v0.1, retrieval had hardcoded `FULL_CONTEXT_TOKEN_LIMIT = 30_000` and `MAX_RETRIEVAL_TOKENS = 40_000`. These were tuned for ~64k models and wasted 60-75% of larger model context windows.

In v0.2, `computeBudget(model)` reads `model.maxInputTokens` at retrieval time:
- Reserves 16,000 tokens for the generation prompt + output
- Uses the remainder as `maxRetrieval` (absolute cap on retrieved context)
- Uses 60% of the remainder as the "send everything" threshold

| Model | Window | "Send all" threshold | Max retrieval |
|-------|-------:|---------------------:|--------------:|
| gpt-4o | 128k | 67,200 | 112,000 |
| claude-3.5-sonnet | 200k | 110,400 | 184,000 |
| Fallback (unknown) | 64k | 28,800 | 48,000 |

### Decision Tree

```
All KB docs loaded
        │
        ├── computeBudget(model) → fullContextLimit, maxRetrieval
        │
        ├── Total tokens ≤ fullContextLimit?
        │   └── YES → send everything (strategy: "all", 0 LLM calls)
        │
        ├── Tag pre-filter → score every doc against prompt keywords
        │   │
        │   ├── 1-3 candidates with positive score?
        │   │   └── Use them + expand related + shared (strategy: "tag-prefilter", 0 LLM calls)
        │   │
        │   └── 4+ candidates OR 0 matches?
        │       └── LLM routing call (strategy: "llm-routed", 1 cheap call)
        │
        └── Expand related + trim to maxRetrieval
```

### Scoring Weights

| Match type | Points | Example |
|-----------|--------|---------|
| `app` field exact match | +5 | prompt keyword "dashboard" → `app: dashboard` |
| `component_types` exact match | +4 | prompt keyword "form" → `component_types: ["form"]` |
| `tags` exact match | +3 | prompt keyword "navigation" → `tags: ["navigation"]` |
| `title` contains keyword | +2 | prompt keyword "tokens" → title has "Design Tokens" |
| `summary` contains keyword | +1 | |
| Any metadata contains keyword | +0.5 | |

Keyword extraction strips stop words and deduplicates.

### Relationship Expansion

After primary selection, `expandRelated()` discovers related documents dynamically:

1. **App grouping** — if any selected document has `app: dashboard`, all other documents with the same app are pulled in
2. **Jaccard tag overlap ≥ 0.25** — if two documents share 25% or more of their tags, they are considered related
3. **Shared docs always included** — documents with `app: shared` are unconditionally included

### LLM Routing

When tag pre-filter returns 4+ candidates or no candidates, `llmRoute()` sends ONLY frontmatter summaries (~50 tokens per document) to the model and asks for a JSON array of filenames. This call is cheap — ~1-2% of a generation call's cost — and disambiguates when keyword scoring cannot.

The routing index is reconstructed in memory from loaded `KbDoc` objects every time. No `_index.md` file on disk.

---

## Lifecycle 3 — Code Generation

### Inputs

The generation pipeline assembles three inputs:
1. **KB context** — formatted as `### Title\n\ncontent\n\n---\n\n` sections, selected by smart retrieval
2. **User prompt** — free text describing what to build
3. **Design image** (optional) — passed as a `LanguageModelDataPart.image()` if the user attached one

### Prompt Template

`generate.md` injects:
- `{{context}}` — the full KB context string
- `{{prompt}}` — the user's free-text request

The template (rewritten in v0.2) contains:
- An explicit evaluation rubric: pixel fidelity + runnable correctness
- Silent chain-of-thought steps the model should think through before emitting files
- Seven non-negotiable accuracy rules
- Four non-negotiable completeness rules
- The delimiter format specification

### Delimiter Output Format (v0.2 — replaces JSON)

The generation model emits files using a file-delimiter format instead of nested JSON:

```
FRAMEWORK: react

=== FILE: package.json ===
<raw file content, no escaping>

=== FILE: src/App.tsx ===
<raw file content>
```

**Why this is better than JSON:**

The previous version asked the model to emit a single raw JSON object with all file contents as string values. Every TypeScript, JSX, or regex file required backslash and quote escaping. Long outputs frequently corrupted escapes, producing JSON that either failed to parse or silently contained broken file bodies.

The delimiter format eliminates escaping entirely. Raw file content lives between delimiters. Any character is legal. The model's cognitive load drops (no escape tracking) and the parser cannot be defeated by escape errors.

### Parser — `parseDelimitedOutput()`

Implemented in `generate.ts`. Lenient to tolerate common model imperfections:
1. Strips an outer markdown fence if the model wrapped the whole response
2. Finds the first `FRAMEWORK: <name>` line anywhere in the response (multiline)
3. Tokenizes on `=== FILE: <path> ===` delimiters with whitespace tolerance
4. Captures content between delimiters, stripping the delimiter's own trailing newline
5. Strips inner markdown fences if individual file bodies were fence-wrapped

### The LLM Call

One call per generation. If a design image was attached, it's prepended as the first message part. If the model rejects it (400 "media type"), the call is retried text-only with a progress message.

### File Writing

Files are written to the configured output directory. Path traversal characters (`../`) are stripped before writing.

---

## How GitHub Copilot Answers

This system communicates with Copilot exclusively through the **VS Code Language Model API** (`vscode.lm`).

### Model Discovery

On panel open, `vscode.lm.selectChatModels({ vendor: 'copilot' })` returns a list of available models. The default preference is `gpt-4o`. If not found, the first available model is used.

### Sending a Request

All LLM calls use the same `callLLM()` utility:
1. Wraps message parts into a `LanguageModelChatMessage.User(parts)`
2. Calls `model.sendRequest([msg], {}, token)`
3. Streams the response via `for await (const chunk of response.text)`
4. Accumulates chunks and optionally calls `onChunk()` for streaming UI updates

### Multimodal Messages

- `LanguageModelTextPart(string)` — a text segment
- `LanguageModelDataPart.image(Uint8Array, mimeType)` — an image segment

Image + text parts go in the same `User` message array. Models that don't support vision return a 400 error — the calling code catches this and retries text-only.

### No Direct API Key

Authentication is managed by the user's installed Copilot extension. SDLC never handles an API key. The VS Code LM API is the abstraction layer.

---

## VS Code Extension UI

### Two UI Surfaces

**1. Activity Bar Sidebar (`KbTreeProvider`)**
- `vscode.window.registerTreeDataProvider`
- Tree view of the knowledge-base folder
- Clicking a file opens the `.md` in an editor tab
- Auto-refreshes via `FileSystemWatcher`

**2. Editor Tab Webview (`PipelinePanel`)**
- `vscode.window.createWebviewPanel` in `ViewColumn.One`
- Singleton — `createOrShow()` reveals or creates
- Brand displayed as "SDLC"
- Inline HTML/CSS with a `<script>` pointing to `dist/webview.js`
- `retainContextWhenHidden: true`

### Extension Host ↔ Webview Messaging

Webviews run in an isolated sandbox. Communication is message-passing via `postMessage`.

Message types from webview to extension:

| Type | Action |
|------|--------|
| `selectModel` | Updates selected Copilot model ID |
| `addFiles` | File picker → copies to kb-inbox |
| `attachImage` | Image picker → sends base64 back |
| `processInbox` | Parallel KB processing |
| `generate` | Runs generation pipeline |
| `refresh` | Re-reads directories |
| `deleteKbFile` | Confirmation dialog + delete |

Message types from extension to webview:

| Type | Action |
|------|--------|
| `models` | Populates model dropdown |
| `tree` | Re-renders file lists |
| `imageAttached` | Shows image preview |
| `streamStart` / `stream` | Live streaming UI |
| `progress` / `status` | Status bar updates (includes quality warnings) |
| `error` / `errors` | Red error display |
| `generated` | Renders generated file chips |

### Streaming UI

As the generation LLM streams chunks, they're forwarded to the webview. The webview client parses the accumulating buffer in real time to detect the framework and file paths. The live UI shows a pulse on the currently-streaming file and checkmarks on completed ones.

The streaming parser in `main.ts` still looks for `"framework"` and `"path"` tokens — originally matching the JSON format. Under the new delimiter format, these tokens do not appear (the output is `FRAMEWORK:` and `=== FILE:` instead), so the streaming UI will fall back to a "Scanning output..." placeholder until final completion. This is a known cosmetic regression; the underlying parsing and file writing still work correctly.

### Prompt Template Loading

`loadPrompt()` in `processor.ts`:
- Reads `.md` files from `dist/prompts/` at runtime
- Compiles with Handlebars
- Caches compiled delegates in a `Map`

Webpack's `copy-webpack-plugin` copies `src/prompts/*.md` → `dist/prompts/` during build, so the three new prompts are picked up automatically.

---

## Workspace Folder Layout

```
{workspace}/
└── .figma-code/
    ├── kb-inbox/           Raw source files dropped by user
    │                       Deleted after successful KB processing
    ├── knowledge-base/     Processed .md files with frontmatter
    │   ├── dashboard-tokens.md
    │   └── ...
    └── generated/          Output from generation runs
        ├── package.json
        └── src/
```

The folder path defaults (`.figma-code/*`) were kept as-is despite the SDLC rename, so existing workspaces continue to work. Configurable via:
- `figmaCode.knowledgeBaseFolder` (default: `.figma-code/knowledge-base`)
- `figmaCode.kbInboxFolder` (default: `.figma-code/kb-inbox`)
- `figmaCode.outputFolder` (default: `.figma-code/generated`)

Note: `_index.md` is no longer generated. Old instances left in existing workspaces are harmless.

---

## LLM Call Budget

| Operation | Trigger | Calls | Notes |
|-----------|---------|-------|-------|
| KB Processing | Per NEW file added (cached files skip) | 1 per new file | Runs in parallel batches of 3 |
| Smart Retrieval routing | Per generation, only if KB exceeds fullContextLimit AND prompt is ambiguous | 0 or 1 | Cheap — summaries only |
| Code Generation | Per generation | 1 | Delimiter format, no JSON escaping |

A typical generation: **1 LLM call**. If the KB is large and the prompt is ambiguous: **2 LLM calls**.

---

## Libraries and Why They Were Chosen

### Runtime Dependencies

**`gray-matter`** — YAML frontmatter parser. Used on every KB read (retrieval scoring, cache lookup, display).

**`handlebars`** — Prompt template engine. Prompts live in `.md` files with `{{variable}}` slots. Keeps prompt text editable without TypeScript changes. Compiled templates are cached.

**`pdfjs-dist`** — Mozilla's PDF text extraction. Legacy build for Node.js target.

**`mammoth`** — DOCX text extraction. Lightweight, purpose-built.

**`crypto` (Node built-in)** — SHA-256 hashing for KB cache keys. No external dependency.

### Dev Dependencies

**`typescript`** / **`ts-loader`** — TypeScript compilation
**`webpack`** / **`copy-webpack-plugin`** — Bundling + copying prompts and media assets
**`eslint`** — Linting

### Intentionally Excluded

| What | Why |
|------|-----|
| LangChain / LlamaIndex | Two well-defined LLM calls; no orchestration layer needed |
| Vector database | No embedding endpoint in VS Code LM API |
| OpenAI / Anthropic SDKs | VS Code LM API handles all LLM communication |
| `axios` / `node-fetch` | No direct HTTP calls |
| `zod` | JSON try/catch + delimiter parser is sufficient |
| `js-tiktoken` | `chars / 4` approximation is good enough |

---

## Key Design Decisions

### One LLM Call for Generation

Modern 128k+ context models handle full single-page generation in one call. Multi-call orchestration adds latency and loses the model's internal consistency.

### Type-Aware KB Extraction

v0.1 used one generic prompt for every file type and produced shallow results for non-image sources. v0.2 splits into three type-specific prompts because a TypeScript file, a design image, and a policy document need different extraction styles.

### Delimiter Output Instead of JSON

JSON with embedded code strings is fundamentally fragile because every code file needs escape management. The delimiter format gives raw file bodies zero-escape pass-through.

### Tag-Based Retrieval Instead of Vectors

Auditable, human-editable, offline, deterministic. LLM routing covers the ambiguous cases. Vectors would add bundle size, startup cost, and retrieval opacity without benefit.

### Prompts as `.md` Files

Git-diffable, non-engineer-editable, decoupled from TypeScript. Webpack copies them at build; `loadPrompt()` reads them at runtime.

### Hash-Based Caching Over Filename Caching

Renaming a file does not invalidate the cache. Content is the canonical identifier.

### Preserving `figmaCode.*` Namespace Despite Rename

Changing the configuration namespace would silently break every existing user workspace. The display rename to SDLC is cosmetic only.

---

## Module Interaction Summary

```
extension.ts
    │
    ├── registers commands → opens PipelinePanel, refreshes KbTreeProvider
    ├── registers FileSystemWatcher → auto-refreshes tree on KB changes
    │
    ▼
ui/webview.ts (PipelinePanel — "SDLC")
    │
    ├── _loadModels() → vscode.lm.selectChatModels({ vendor: 'copilot' })
    ├── _addFiles() → vscode.window.showOpenDialog → copies to kb-inbox/
    ├── _processInbox() → parallel worker pool (concurrency 3):
    │       └── kb/processor.ts → processKbFile()
    │               ├── hash buffer, check cache → skip if match
    │               ├── kb/extract.ts → extractFile() [no LLM]
    │               ├── selectPromptName(ext) → design/code/spec
    │               ├── callLLM() → Copilot model [1 LLM call]
    │               ├── assessQuality() → ok/warn/poor
    │               └── writes .md with source_hash and quality
    │
    └── _onGenerate() → generate/generate.ts → generateProject()
            ├── kb/retrieval.ts → retrieveContext()
            │       ├── computeBudget(model) → dynamic token budget
            │       ├── loads KB docs with gray-matter
            │       ├── strategy: all / tag-prefilter / llm-routed
            │       └── returns formatted context string
            ├── kb/processor.ts → loadPrompt('generate') [Handlebars]
            ├── callLLM() → Copilot model [1 LLM call, streamed]
            ├── parseDelimitedOutput() → framework + files
            └── writes files to generated/

ui/tree.ts (KbTreeProvider)
    └── listKbFiles() → kb/index.ts → reads knowledge-base/ directory
```
