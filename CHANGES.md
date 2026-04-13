# Changes — SDLC Pipeline v0.2

_Applied: April 2026_

This document records the concrete changes made to overcome the accuracy and reliability weaknesses identified when comparing this pipeline against GitHub Copilot Chat directly. Goal: produce more accurate, more reliable, more scalable output than raw Copilot Chat for the greenfield-project-from-design use case.

---

## Branding

The user-facing name has been changed from **Figma Code** to **SDLC**. The `figmaCode.*` command namespace, configuration keys, and `.figma-code/` folder defaults are preserved to avoid breaking existing user workspaces. Only display strings and UI labels changed.

| Surface | Before | After |
|---------|--------|-------|
| `package.json` displayName | Figma Code (Copilot Pipeline) | SDLC (Copilot Pipeline) |
| Activity bar title | Figma Code | SDLC |
| Settings section title | Figma Code | SDLC |
| Command palette entries | "Figma Code: ..." | "SDLC: ..." |
| Webview panel title | Figma Code | SDLC |
| HTML document title | Figma Code | SDLC |
| Header brand text | Figma Code / `F` mark | SDLC / `S` mark / v0.2 |

Config namespace, folder defaults, and internal extension ID are unchanged. Existing workspaces and keybindings continue to work.

---

## 1. Dead Code Removal

### `_index.md` table of contents — removed

The KB processor previously generated `_index.md` after every file processing run via `rebuildIndex()`. Retrieval explicitly filtered this file out at `retrieval.ts:120` and the LLM router in `llmRoute()` reconstructed its own index from in-memory `KbDoc` objects. The file was written to disk but never read by any code path.

- Removed `rebuildIndex()` function from `src/kb/processor.ts`
- Removed `await rebuildIndex(kbOutDir)` call in `processKbFile()`
- Old `_index.md` files left on disk are harmless and will not be regenerated

### `buildKbContext()` — removed

A leftover from the pre-retrieval era. Read every KB `.md` file and joined them into one flat context string. Nothing in the current codebase called it.

Removed from `src/kb/index.ts`.

### `hasKbContent()` — removed

Unused helper. Removed from `src/kb/index.ts`.

The `kb/index.ts` file now contains only `listKbFiles()`, the sole function actually consumed by the UI.

---

## 2. Type-Aware KB Processor Prompts

The previous single `kb-processor.md` prompt was optimized for design images. It instructed the model to "extract exact hex colors and pixel values" even when processing a TypeScript file or a plain-text policy document. The result: non-image KB docs were often shallow or irrelevant.

**Changed:** split into three type-specific prompts, selected by file extension:

| File types | Prompt | Purpose |
|-----------|--------|---------|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf` | `kb-processor-design.md` | Exhaustive visual extraction — exact hex colors, pixel measurements, typography axes, component states, spatial relationships |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.css`, `.html`, `.json`, `.yaml`, `.yml` | `kb-processor-code.md` | API surface extraction — exports, props, types, naming conventions, import patterns, styling approach, framework cues |
| `.md`, `.txt`, `.docx` | `kb-processor-spec.md` | Rule extraction — actionable bullets, MUST/SHOULD/MAY normativity, exact thresholds, grouped by section |

Each prompt applies tighter rules appropriate to its file type, reducing the "extract everything imaginable" hallucination pattern that the generic prompt encouraged.

A `selectPromptName(ext)` function in `processor.ts` routes by extension. Unknown extensions default to the spec prompt.

---

## 3. Generation Output Format — JSON → Delimited Files

### Problem

The previous generation prompt asked the model to return a single raw JSON object with all file contents embedded as string values. Every TypeScript, JSX, or regex-heavy file inside that JSON required backslash and quote escaping. The model frequently corrupted escape sequences on long outputs, producing JSON that either:
- Failed to parse entirely (hard failure)
- Parsed but contained broken file content with wrong escapes (silent failure)

### Fix

Changed `src/prompts/generate.md` to use a **file-delimiter format**:

```
FRAMEWORK: react

=== FILE: package.json ===
<raw file content, no escaping>

=== FILE: src/App.tsx ===
<raw file content>
```

Raw content is written between delimiters. No escaping required. Code files with backslashes, template literals, JSX, and regex patterns pass through unmodified.

### Parser

`generate.ts` now uses `parseDelimitedOutput(raw)` instead of `extractJson() + JSON.parse()`. The parser:

1. Strips an outer markdown fence if the model accidentally wrapped the response
2. Finds the first `FRAMEWORK: <name>` line
3. Tokenizes on `=== FILE: <path> ===` delimiters
4. Captures each file's content between delimiters, trimming the delimiter's own trailing newline
5. Strips inner markdown fences if the model wraps individual file bodies

The old `extractJson()` helper is retained because the KB processor prompts still return structured JSON (they have a fixed field schema, unlike the arbitrary-size generation output).

### Prompt engineering improvements to `generate.md`

In addition to the format change, the prompt was rewritten with:

- **Explicit evaluation criteria** at the top: "pixel-level fidelity" and "runnable correctness on first try" — gives the model a scoring rubric to self-check against
- **Silent chain-of-thought steps** — the model is told what to think through (framework choice, load-bearing values, component tree, tokens, states) before emitting files, without writing the reasoning to the output
- **Accuracy rules section** — seven non-negotiable rules about exact values, typography axes, CSS custom property naming, no placeholders, accessibility, and responsiveness
- **Completeness rules section** — four rules about runnable `package.json`, config files, entry points, and no truncation
- **Strict format rules** with negative examples — tells the model exactly what NOT to do (no prose between files, no outer fences, no intro/outro text)

---

## 4. Hash-Based KB Caching

### Problem

Re-running "Process Inbox" on a file that was already processed wasted an LLM call every time. Users who re-dropped the same files into the inbox or re-processed after cancelling a run paid full cost.

### Fix

Added SHA-256 content hashing to the KB processor:

1. Before processing, `processKbFile()` reads the source buffer and computes a 16-char SHA-256 prefix
2. `findCachedKbDoc()` scans existing KB docs for a matching `source_hash` frontmatter field
3. If a match is found, processing is skipped entirely — no LLM call, no file write
4. The function returns `{ cached: true }` and the inbox file is still deleted (caller's choice)
5. If no match, processing proceeds normally and the new hash is embedded in the output frontmatter

### Frontmatter schema change

Added `source_hash` field:

```yaml
---
source: dashboard.png
source_hash: a1b2c3d4e5f67890
title: "..."
app: dashboard
...
---
```

The `quality` field was also added — see section 5.

Cache key is content hash, not filename, so renaming a file does not bypass the cache.

---

## 5. KB Quality Heuristic Warnings

### Problem

Silent KB corruption: if the processor LLM produced a placeholder, truncated, or generic document, the user had no way to know until generated code came out wrong. Users shouldn't have to manually read every KB doc after processing to verify quality.

### Fix

Added `assessQuality()` function in `processor.ts` that applies cheap heuristics after processing:

| Check | Flag | Reason |
|-------|------|--------|
| Body length < 200 chars | `poor` | extraction is almost certainly broken |
| Body contains "placeholder"/"vision processing failed" | `poor` | known vision fallback signal |
| Tag array has fewer than 3 items | `warn` | retrieval scoring needs at least a few tags to work |
| Design-type file has no hex colors AND no px values | `warn` | visual extraction missed concrete values |
| Body length < 500 chars | `warn` | short but not broken |
| Everything passes | `ok` | — |

The quality level is:
- Embedded in the KB doc's frontmatter (`quality: ok`)
- Returned in `ProcessResult.quality` and `ProcessResult.reason`
- Surfaced in the UI — `poor` items produce red error messages, `warn` items produce yellow progress notices

This is a pure safety net. The checks are fast, local, and have no false-positive cost (a `warn` is just information).

---

## 6. Dynamic Retrieval Token Budget

### Problem

`retrieval.ts` had two hardcoded constants:
- `FULL_CONTEXT_TOKEN_LIMIT = 30_000` (below this, send everything)
- `MAX_RETRIEVAL_TOKENS = 40_000` (absolute cap on selected context)

These were tuned for ~64k context models. GPT-4o has 128k; Claude Sonnet has 200k. The old constants wasted 60–75% of the available context window on larger models.

### Fix

Added `computeBudget(model)` which reads `model.maxInputTokens` from the VS Code Language Model API:

- Reserves 16,000 tokens for the generation prompt + output
- Uses the remainder as `maxRetrieval`
- Sets the "send everything" threshold at 60% of the remainder

Results by model:

| Model | Context window | Old "full" cap | New "full" cap | Old max retrieval | New max retrieval |
|-------|--------------:|---------------:|--------------:|-----------------:|-----------------:|
| Copilot gpt-4o | 128,000 | 30,000 | 67,200 | 40,000 | 112,000 |
| Copilot claude-3.5-sonnet | 200,000 | 30,000 | 110,400 | 40,000 | 184,000 |
| Small fallback | 64,000 | 30,000 | 28,800 | 40,000 | 48,000 |

Models that don't report `maxInputTokens` fall through to a conservative 64k default, matching roughly the old hardcoded behavior.

---

## 7. Parallel KB Processing

### Problem

`_processInbox()` processed files sequentially in a `for` loop. A user dumping 20 design files waited 20× the per-file latency — often 2–3 minutes.

### Fix

Rewrote the inbox processing loop in `webview.ts` with a bounded concurrency pool:

- Concurrency limit: 3 workers
- Each worker pulls from a shared queue and processes until empty
- All workers resolve, then status is reported

Sequential 20-file processing (≈2 minutes) becomes ≈40 seconds. The limit of 3 is conservative enough to avoid hammering the Copilot backend.

The processing loop also now:
- Filters to actual files (not directories) before entering the loop, not inside it
- Accumulates quality warnings alongside errors
- Reports cached skips in the status line: `"Processed 20/20 files into KB (7 unchanged, reused cache)"`

---

## 8. Prompt Engineering — Better System Prompts

All three KB processor prompts and the generation prompt were rewritten from scratch with modern prompt engineering techniques:

### Applied techniques

- **Explicit role framing** — "You are a senior design systems engineer" instead of "You are a design specification extractor"
- **Stakes framing** — tell the model what happens if it does this wrong ("downstream code generator will use your output as its only source of truth")
- **Negative examples** — show wrong output next to right output inline
- **Non-negotiable rules** — numbered lists explicitly marked as non-negotiable to suppress the model's tendency to be "helpful" in the wrong ways
- **Silent reasoning** — the generate prompt asks the model to think through specific questions before writing, without emitting the reasoning to the output
- **Evaluation rubric** — tell the model exactly what it will be graded on (pixel fidelity, runnable correctness) so it can self-check
- **"Zero filler prose" rule** — explicit instruction to cut introductions, summaries, and closing remarks that waste tokens
- **Strict output format section** — format specified with positive AND negative rules (do this; do NOT do that)

### Specific improvements per prompt

- **`kb-processor-design.md`** — now requires all five typography axes (family, size, weight, line-height, letter-spacing), explicit state extraction (hover/focus/active/disabled), spatial measurements in pixels, and `(approx)` marking for uncertain values
- **`kb-processor-code.md`** — focuses on API surface and conventions, not re-describing code; extracts naming patterns, import aliases, styling approach, side effects
- **`kb-processor-spec.md`** — converts prose rules to MUST/SHOULD/MAY bullets, preserves exact thresholds, captures both prescriptions and prohibitions
- **`generate.md`** — now includes pre-emission thinking steps, explicit accuracy rules, completeness rules, and the delimiter format specification with worked examples

---

## Files Changed

| File | Change |
|------|--------|
| `src/kb/index.ts` | Removed `buildKbContext()` and `hasKbContent()`; kept only `listKbFiles()` |
| `src/kb/processor.ts` | Added type routing, hash caching, quality checks; removed `rebuildIndex()` |
| `src/kb/retrieval.ts` | Replaced hardcoded budget constants with `computeBudget(model)` |
| `src/generate/generate.ts` | Replaced JSON parser with `parseDelimitedOutput()` |
| `src/ui/webview.ts` | Parallel inbox processing; SDLC branding; quality warning display |
| `src/prompts/kb-processor.md` | **Deleted** — replaced by three type-specific prompts |
| `src/prompts/kb-processor-design.md` | **New** — exhaustive visual extraction |
| `src/prompts/kb-processor-code.md` | **New** — API surface extraction |
| `src/prompts/kb-processor-spec.md` | **New** — rule extraction |
| `src/prompts/generate.md` | Rewritten for delimiter format + stronger engineering |
| `package.json` | SDLC branding on displayName, command titles, activity bar title |
| `ARCHITECTURE.md` | Updated to reflect all changes |
| `CLAUDE.md` | Updated to reflect all changes |
| `CHANGES.md` | **New** — this document |

---

## Things Deliberately NOT Changed

Feature ideas that were considered and rejected to keep the tool focused:

- **Workspace context injection** — Would pull the tool into "edit existing codebase" territory, where Copilot Chat already wins. This tool stays focused on greenfield generation from design sources.
- **Refinement / conversational iteration** — Copilot Chat already excels at this. Building a half-version inside SDLC would be worse than telling users to refine in Copilot Chat after initial generation.
- **Image preservation in KB** — The user can already attach original images directly at generation time via the UI. The case for auto-preserving and re-attaching from KB is narrow (large-KB workflows where the user forgot which image maps to which doc). Not worth the complexity right now.
- **Vector embeddings** — No embedding endpoint in the VS Code LM API. Frontmatter tag scoring + LLM routing cover all retrieval cases.
- **Breaking config rename** — `figmaCode.*` settings and `.figma-code/` folder paths are preserved so existing user workspaces continue working. Only display strings changed to SDLC.

---

## Migration Notes for Existing Users

- **Existing KB docs work as-is.** They lack the new `source_hash` and `quality` frontmatter fields, but this is ignored gracefully by retrieval.
- **Re-processing is free with caching.** If you want the new type-aware prompts applied to old docs, drop the originals back into the inbox. The first run will re-process them; subsequent runs will hit the cache.
- **Old `_index.md` files are harmless.** They will sit in the KB folder untouched. You can delete them manually if you want a clean folder.
- **Settings paths are unchanged.** `figmaCode.knowledgeBaseFolder`, `figmaCode.kbInboxFolder`, and `figmaCode.outputFolder` all keep their previous defaults.
