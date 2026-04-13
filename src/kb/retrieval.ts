import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { callLLM, extractJson } from './processor';

// ── Types ───────────────────────────────────────────────────

interface KbDoc {
  file: string;
  /** Original source filename (from frontmatter `source:` field) */
  source: string;
  title: string;
  app: string;
  tags: string[];
  componentTypes: string[];
  summary: string;
  content: string;
  /** Rough token count (chars / 4) */
  tokens: number;
}

export interface MatchedDoc {
  /** KB markdown filename */
  file: string;
  /** Original uploaded source filename */
  source: string;
  title: string;
  app: string;
}

export interface RetrievalResult {
  context: string;
  matched: string[];
  matchedDocs: MatchedDoc[];
  strategy: 'all' | 'tag-prefilter' | 'llm-routed';
}

// ── Constants ───────────────────────────────────────────────

/** Reserved headroom for the generation prompt + output (tokens). */
const OUTPUT_RESERVE_TOKENS = 16_000;

/** Conservative fallback when model does not report its context window. */
const FALLBACK_CONTEXT_WINDOW = 64_000;

/** If tag pre-filter narrows to this many or fewer, skip LLM routing. */
const CLEAR_MATCH_THRESHOLD = 3;

/**
 * Compute the retrieval token budget from the model's reported context window,
 * reserving headroom for the generation prompt + output.
 *
 * Split:
 *   - "full context" threshold = budget × 0.6 (send everything if KB fits here)
 *   - "max retrieval" cap      = budget × 1.0 (absolute ceiling on selected context)
 *
 * This replaces the previous hardcoded 30k/40k values that assumed a 64k-ish
 * model and wasted the larger windows of GPT-4o (128k) and Claude (200k).
 */
function computeBudget(model: vscode.LanguageModelChat): { fullContextLimit: number; maxRetrieval: number } {
  const window = (model.maxInputTokens && model.maxInputTokens > 0)
    ? model.maxInputTokens
    : FALLBACK_CONTEXT_WINDOW;
  const usable = Math.max(8_000, window - OUTPUT_RESERVE_TOKENS);
  return {
    fullContextLimit: Math.floor(usable * 0.6),
    maxRetrieval: usable,
  };
}

// ── Main entry point ────────────────────────────────────────

/**
 * Dynamic retrieval — adapts strategy based on KB size and match clarity.
 *
 * Flow:
 * 1. Total KB under budget      → send everything, zero cost
 * 2. Tag pre-filter narrows well → check if clear winner exists
 *    a. ≤ 3 candidates with score gap   → use them directly (0 LLM calls)
 *    b. Multiple candidates, ambiguous   → LLM disambiguates from candidates only
 * 3. No tag matches at all       → LLM sees full index, picks from scratch
 * 4. Token budget trim as final safety net on every path
 */
export async function retrieveContext(params: {
  kbDir: string;
  prompt: string;
  imageName?: string;
  model: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
}): Promise<RetrievalResult> {
  const { kbDir, prompt, imageName, model, token } = params;

  const docs = await loadKbDocs(kbDir);
  if (docs.length === 0) {
    return { context: '', matched: [], matchedDocs: [], strategy: 'all' };
  }

  const { fullContextLimit, maxRetrieval } = computeBudget(model);
  const totalTokens = docs.reduce((sum, d) => sum + d.tokens, 0);

  // ── Path 1: small KB, send everything ──
  if (totalTokens <= fullContextLimit) {
    return {
      context: formatDocs(docs),
      matched: docs.map(d => d.file),
      matchedDocs: docs.map(d => ({ file: d.file, source: d.source, title: d.title, app: d.app })),
      strategy: 'all',
    };
  }

  // ── Path 2: tag pre-filter ──
  const keywords = extractKeywords(prompt, imageName);
  const scored = docs
    .map(doc => ({ doc, score: scoreDoc(doc, keywords) }))
    .sort((a, b) => b.score - a.score);

  const shared = docs.filter(d => d.app === 'shared');
  const candidates = scored.filter(s => s.score > 0 && s.doc.app !== 'shared');

  if (candidates.length > 0 && candidates.length <= CLEAR_MATCH_THRESHOLD) {
    const selected = expandRelated([...candidates.map(c => c.doc), ...shared], docs);
    const trimmed = trimToBudget(selected, maxRetrieval);
    return {
      context: formatDocs(trimmed),
      matched: trimmed.map(d => d.file),
      matchedDocs: trimmed.map(d => ({ file: d.file, source: d.source, title: d.title, app: d.app })),
      strategy: 'tag-prefilter',
    };
  }

  // ── Path 3: LLM disambiguation ──
  const pool = candidates.length > 0
    ? [...candidates.map(c => c.doc), ...shared]
    : docs;

  const routed = await llmRoute(pool, prompt, imageName, model, token);

  const expanded = expandRelated(routed, docs);
  const trimmed = trimToBudget(expanded, maxRetrieval);

  return {
    context: formatDocs(trimmed),
    matched: trimmed.map(d => d.file),
    matchedDocs: trimmed.map(d => ({ file: d.file, source: d.source, title: d.title, app: d.app })),
    strategy: 'llm-routed',
  };
}

// ── Load KB docs ────────────────────────────────────────────

async function loadKbDocs(kbDir: string): Promise<KbDoc[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(kbDir)).filter(f => f.endsWith('.md') && f !== '_index.md').sort();
  } catch {
    return [];
  }

  const docs: KbDoc[] = [];
  for (const file of entries) {
    try {
      const raw = await fs.readFile(path.join(kbDir, file), 'utf-8');
      const { data, content } = matter(raw);
      const d = data as Record<string, unknown>;
      docs.push({
        file,
        source: String(d.source || file.replace('.md', '')),
        title: String(d.title || file.replace('.md', '')),
        app: String(d.app || 'shared'),
        tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
        componentTypes: Array.isArray(d.component_types) ? d.component_types.map(String) : [],
        summary: String(d.summary || ''),
        content: content.trim(),
        tokens: Math.ceil(content.length / 4),
      });
    } catch { /* skip */ }
  }
  return docs;
}

// ── Keyword extraction ──────────────────────────────────────

function extractKeywords(prompt: string, imageName?: string): string[] {
  const text = (prompt + ' ' + (imageName || '')).toLowerCase();
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'up', 'about', 'into',
    'this', 'that', 'it', 'its', 'my', 'your', 'can', 'will', 'do', 'does', 'did',
    'has', 'have', 'had', 'not', 'no', 'just', 'get', 'got', 'make', 'use', 'using',
    'generate', 'create', 'build', 'code', 'write', 'please', 'want', 'need', 'like',
    'should', 'would', 'could', 'also', 'very', 'all', 'each', 'every', 'some', 'any',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'file', 'image',
  ]);
  return [...new Set(
    text.split(/[^a-z0-9]+/)
      .filter(w => w.length >= 2 && !stopWords.has(w))
  )];
}

// ── Scoring ─────────────────────────────────────────────────

function scoreDoc(doc: KbDoc, keywords: string[]): number {
  let score = 0;
  const docText = [doc.title, doc.app, doc.tags.join(' '), doc.componentTypes.join(' '), doc.summary]
    .join(' ').toLowerCase();

  for (const kw of keywords) {
    if (doc.tags.includes(kw)) { score += 3; }
    if (doc.app.toLowerCase() === kw) { score += 5; }
    if (doc.componentTypes.some(ct => ct.toLowerCase() === kw)) { score += 4; }
    if (doc.title.toLowerCase().includes(kw)) { score += 2; }
    if (doc.summary.toLowerCase().includes(kw)) { score += 1; }
    if (docText.includes(kw) && !doc.tags.includes(kw)) { score += 0.5; }
  }
  return score;
}

// ── Relationship expansion ──────────────────────────────────

/**
 * Given a set of selected docs, expand to include related docs from the full set.
 * Relationships are dynamic — computed via app grouping + tag overlap (Jaccard).
 */
function expandRelated(selected: KbDoc[], allDocs: KbDoc[]): KbDoc[] {
  const selectedFiles = new Set(selected.map(d => d.file));
  const result = [...selected];

  // Collect all apps from selected non-shared docs
  const selectedApps = new Set(
    selected.filter(d => d.app !== 'shared').map(d => d.app)
  );

  for (const doc of allDocs) {
    if (selectedFiles.has(doc.file)) { continue; }

    // Rule 1: same app → include (if a specific app was identified)
    if (doc.app !== 'shared' && selectedApps.has(doc.app)) {
      result.push(doc);
      selectedFiles.add(doc.file);
      continue;
    }

    // Rule 2: high tag overlap with any selected doc → include
    for (const sel of selected) {
      if (jaccard(sel.tags, doc.tags) >= 0.25) {
        result.push(doc);
        selectedFiles.add(doc.file);
        break;
      }
    }
  }

  // Always include shared docs
  for (const doc of allDocs) {
    if (!selectedFiles.has(doc.file) && doc.app === 'shared') {
      result.push(doc);
      selectedFiles.add(doc.file);
    }
  }

  return result;
}

/** Jaccard similarity between two tag arrays. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) { return 0; }
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) { intersection++; } }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── LLM routing ─────────────────────────────────────────────

/**
 * LLM picks the relevant docs from a candidate pool.
 * Only sends summaries — never full content. Cheap and fast.
 */
async function llmRoute(
  candidates: KbDoc[],
  prompt: string,
  imageName: string | undefined,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<KbDoc[]> {
  const index = candidates.map(d =>
    `- **${d.file}** | App: ${d.app} | Components: ${d.componentTypes.join(', ')} | Tags: ${d.tags.join(', ')} | ${d.summary}`
  ).join('\n');

  const routingPrompt = `You are a knowledge base router. The user wants to generate code. Decide which documents from the knowledge base are needed to fulfill their request.

## User Request
${prompt}${imageName ? `\n(User attached a design image: ${imageName})` : ''}

## Available Documents (${candidates.length} total)
${index}

## Instructions
1. Read the user's request carefully — identify which app/page/project they are referring to.
2. Select ALL documents that would be needed to generate accurate code:
   - Design tokens, colors, spacing for that specific app
   - Component specs, layout definitions
   - Shared/global docs (design systems, global tokens) that apply everywhere
3. Do NOT select documents about unrelated apps or pages.
4. If the request is ambiguous (could refer to multiple apps), prefer the one that best matches the overall context.

## Response Format
Return ONLY a JSON object:
{"files": ["file1.md", "file2.md"], "reasoning": "brief explanation of why these were selected"}`;

  try {
    const raw = await callLLM(model, [new vscode.LanguageModelTextPart(routingPrompt)], token);
    const json = extractJson(raw);
    const parsed = JSON.parse(json);
    const files: string[] = Array.isArray(parsed.files) ? parsed.files.map(String)
      : Array.isArray(parsed) ? parsed.map(String) : [];

    if (files.length > 0) {
      const fileSet = new Set(files);
      const matched = candidates.filter(d => fileSet.has(d.file));
      if (matched.length > 0) { return matched; }
    }
  } catch {
    // LLM routing failed — return all candidates, let budget trimming handle it
  }

  return candidates;
}

// ── Helpers ─────────────────────────────────────────────────

function trimToBudget(docs: KbDoc[], maxTokens: number): KbDoc[] {
  const result: KbDoc[] = [];
  let used = 0;
  for (const doc of docs) {
    if (used + doc.tokens <= maxTokens) {
      result.push(doc);
      used += doc.tokens;
    }
  }
  return result;
}

function formatDocs(docs: KbDoc[]): string {
  return docs.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n---\n\n');
}
