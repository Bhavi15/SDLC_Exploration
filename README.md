<div align="center">

<br />

```
███████╗██████╗ ██╗      ██████╗
██╔════╝██╔══██╗██║     ██╔════╝
███████╗██║  ██║██║     ██║
╚════██║██║  ██║██║     ██║
███████║██████╔╝███████╗╚██████╗
╚══════╝╚═════╝ ╚══════╝ ╚═════╝
```

### **AI-Powered Design-to-Code · VS Code Extension**

*From design files and requirements to production code, user stories, BRDs, test cases, and Playwright scripts — all inside VS Code, all powered by GitHub Copilot.*

<br />

![VS Code](https://img.shields.io/badge/VS_Code-Extension-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)
![GitHub Copilot](https://img.shields.io/badge/Powered_by-GitHub_Copilot-000000?style=flat-square&logo=github&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)
![No External APIs](https://img.shields.io/badge/No_External_APIs-Zero_Cloud_Dependencies-f97316?style=flat-square)

<br />

</div>

---

## What It Does

SDLC takes your **design files and requirements** and generates a complete software project — no context switching, no copy-pasting between tools, no vendor lock-in beyond Copilot.

<br />

<div align="center">

| Input | Output |
|:---|:---|
| 🖼️ Design images, PDFs, style guides | Production code — React, Next.js, Angular, Vue, Svelte, HTML |
| 📄 Requirements docs, specs | User Stories + BRD — Markdown, Excel, CSV |
| 📋 User stories | QA Test Cases + Playwright E2E scripts |
| 🧪 Playwright scripts | Live test runner with streaming results |

</div>

---

## AI Engineering

These aren't defaults. Each decision was made deliberately.

<br />

### 📄 One Dense Doc Per Source — not RAG chunks
> Inspired by Karpathy's `llm.txt` approach.

Every source file becomes one structured Markdown document with rich YAML frontmatter — `tags`, `app`, component types, summary, and a SHA-256 hash. Document coherence is preserved end-to-end. When the full knowledge base fits in context, everything is sent with **zero retrieval overhead**.

---

### 🔍 Smart Retrieval — no vector embeddings required

The VS Code LM API has no embedding endpoint. Instead, the system uses a **three-tier cascade**:

```
1. Keyword scoring      →  frontmatter metadata match
2. Jaccard tag overlap  →  relationship expansion
3. LLM routing call     →  summaries only (~50 tokens/doc) when ambiguous
```

Typical generation costs **0–1 routing calls**.

---

### ⚖️ Dynamic Token Budget

Reads `model.maxInputTokens` at runtime. Hardcoded context constants waste **60–75%** of GPT-4o (128k) and Claude (200k) windows. Budget is computed per-model, per-generation — automatically.

---

### 📦 Delimiter Output Format — not JSON

JSON-encoding multi-file TypeScript/JSX outputs fails unpredictably. Models escape generics, regex, and angle brackets incorrectly. SDLC uses a `=== FILE: path ===` delimiter format instead:

```
=== FILE: src/components/Button.tsx ===
export const Button = ({ label }: { label: string }) => (
  <button className="btn">{label}</button>
);

=== FILE: src/components/Button.test.ts ===
...
```

Raw file content passes through with **zero escaping**. The same pattern is used for user stories and test case blocks.

---

### 🔒 SHA-256 Content-Hash Caching

Before any LLM call, `sha256(fileBytes).slice(0, 16)` is checked against `source_hash` in existing KB frontmatter.

- **Unchanged files** → zero LLM calls
- **Cache key is content-based** → renaming a file cannot bypass it

---

### 🎯 Type-Aware Extraction Prompts

One generic prompt produces shallow output across file types. SDLC routes to one of **three Handlebars prompt templates**:

| File Type | Extracted Data |
|:---|:---|
| 🎨 Design files | Exact hex colors, spacing, typography |
| 💻 Code files | Exported symbols, prop interfaces |
| 📋 Spec files | MUST / SHOULD / MAY rules with exact thresholds |

---

## Stack

```ts
// Runtime
"vscode-lm-api"    // GitHub Copilot — the only AI dependency
"typescript"       // End to end
"gray-matter"      // YAML frontmatter parsing
"handlebars"       // Prompt templating
"pdfjs-dist"       // PDF extraction
"mammoth"          // .docx extraction
"xlsx"             // Excel output

// Intentionally excluded
"langchain"        // ✗  pipeline is simple enough to build directly
"chromadb"         // ✗  no vector embeddings needed
"pinecone"         // ✗  no vector embeddings needed
"openai"           // ✗  zero external API calls
"zod"              // ✗  no runtime schema validation needed
```

> **Zero vendor lock-in** beyond GitHub Copilot. No external services, no cloud dependencies, no surprise bills.

---

## Project Structure

```
src/
├── backend/
│   ├── kb/          # Extract → hash cache → type-aware prompt → quality check → KB doc
│   ├── generate/    # Smart retrieval → prompt compile → stream → delimiter parse → write files
│   ├── ba/          # User stories + BRD → Markdown / Excel / CSV
│   └── qa/          # Test cases + Playwright scripts + live test runner
│
├── frontend/        # VS Code webview panel + sidebar tree view
│
└── prompts/         # Handlebars prompt templates
                     # (.md — git-diffable, LLM-editable)
```

---

## Requirements

- **VS Code** `1.90+`
- **GitHub Copilot** subscription (Chat participant access)
- **Node.js** `18+`

---

<div align="center">

*RAG. No embeddings. No external APIs. Just Copilot, TypeScript, and well-engineered prompts.*

<br />

![Built with care](https://img.shields.io/badge/Built_with-deliberate_engineering-000000?style=flat-square)

</div>
