import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { callLLM, extractJson } from './processor';

// ── Types ───────────────────────────────────────────────────

interface KbDoc {
  file: string;
  source: string;
  title: string;
  app: string;
  tags: string[];
  componentTypes: string[];
  summary: string;
  content: string;
  tokens: number;
}

export interface MatchedDoc {
  file: string;
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

const OUTPUT_RESERVE_TOKENS = 16_000;
const FALLBACK_CONTEXT_WINDOW = 64_000;
const CLEAR_MATCH_THRESHOLD = 3;

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

  if (totalTokens <= fullContextLimit) {
    return {
      context: formatDocs(docs),
      matched: docs.map(d => d.file),
      matchedDocs: docs.map(d => ({ file: d.file, source: d.source, title: d.title, app: d.app })),
      strategy: 'all',
    };
  }

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

function scoreDoc(doc: KbDoc, keywords: string[]): number {
  let score = 0;
  for (const kw of keywords) {
    if (doc.tags.includes(kw)) { score += 3; }
    if (doc.app.toLowerCase() === kw) { score += 5; }
    if (doc.componentTypes.some(ct => ct.toLowerCase() === kw)) { score += 4; }
    if (doc.title.toLowerCase().includes(kw)) { score += 2; }
    if (doc.summary.toLowerCase().includes(kw)) { score += 1; }
  }
  return score;
}

function expandRelated(selected: KbDoc[], allDocs: KbDoc[]): KbDoc[] {
  const selectedFiles = new Set(selected.map(d => d.file));
  const result = [...selected];
  const selectedApps = new Set(selected.filter(d => d.app !== 'shared').map(d => d.app));
  for (const doc of allDocs) {
    if (selectedFiles.has(doc.file)) { continue; }
    if (doc.app !== 'shared' && selectedApps.has(doc.app)) {
      result.push(doc); selectedFiles.add(doc.file); continue;
    }
    for (const sel of selected) {
      if (jaccard(sel.tags, doc.tags) >= 0.25) {
        result.push(doc); selectedFiles.add(doc.file); break;
      }
    }
  }
  for (const doc of allDocs) {
    if (!selectedFiles.has(doc.file) && doc.app === 'shared') {
      result.push(doc); selectedFiles.add(doc.file);
    }
  }
  return result;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) { return 0; }
  const setA = new Set(a); const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) { intersection++; } }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function llmRoute(
  candidates: KbDoc[], prompt: string, imageName: string | undefined,
  model: vscode.LanguageModelChat, token: vscode.CancellationToken,
): Promise<KbDoc[]> {
  const index = candidates.map(d =>
    `- **${d.file}** | App: ${d.app} | Components: ${d.componentTypes.join(', ')} | Tags: ${d.tags.join(', ')} | ${d.summary}`
  ).join('\n');
  const routingPrompt = `You are a knowledge base router. Select documents needed to fulfill the user's code generation request.\n\nUser Request: ${prompt}${imageName ? `\n(Design image: ${imageName})` : ''}\n\nAvailable Documents:\n${index}\n\nReturn ONLY JSON: {"files": ["file1.md",...], "reasoning": "..."}`;
  try {
    const raw = await callLLM(model, [new vscode.LanguageModelTextPart(routingPrompt)], token);
    const parsed = JSON.parse(extractJson(raw));
    const files: string[] = Array.isArray(parsed.files) ? parsed.files.map(String) : [];
    if (files.length > 0) {
      const fileSet = new Set(files);
      const matched = candidates.filter(d => fileSet.has(d.file));
      if (matched.length > 0) { return matched; }
    }
  } catch { /* fallback to all candidates */ }
  return candidates;
}

function trimToBudget(docs: KbDoc[], maxTokens: number): KbDoc[] {
  const result: KbDoc[] = []; let used = 0;
  for (const doc of docs) {
    if (used + doc.tokens <= maxTokens) { result.push(doc); used += doc.tokens; }
  }
  return result;
}

function formatDocs(docs: KbDoc[]): string {
  return docs.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n---\n\n');
}
