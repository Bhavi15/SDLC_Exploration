import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import Handlebars from 'handlebars';
import matter from 'gray-matter';
import { extractFile, type ExtractedContent } from './extract';

// ── Prompt loading ──────────────────────────────────────────

const promptCache = new Map<string, Handlebars.TemplateDelegate>();

export async function loadPrompt(name: string): Promise<Handlebars.TemplateDelegate> {
  const cached = promptCache.get(name);
  if (cached) { return cached; }
  const file = path.join(__dirname, 'prompts', `${name}.md`);
  const src = await fs.readFile(file, 'utf-8');
  const tpl = Handlebars.compile(src);
  promptCache.set(name, tpl);
  return tpl;
}

// ── LLM helpers ─────────────────────────────────────────────

export async function callLLM(
  model: vscode.LanguageModelChat,
  parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart>,
  token: vscode.CancellationToken,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const msg = vscode.LanguageModelChatMessage.User(parts);
  const response = await model.sendRequest([msg], {}, token);
  let out = '';
  for await (const chunk of response.text) {
    out += chunk;
    onChunk?.(chunk);
  }
  return out.trim();
}

export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced?.[1]) { return fenced[1]; }
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { if (depth === 0) { start = i; } depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { return text.slice(start, i + 1); } }
  }
  return text;
}

// ── File type routing ──────────────────────────────────────

const DESIGN_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json', '.yaml', '.yml']);
const SPEC_EXTS = new Set(['.md', '.txt', '.docx']);

function selectPromptName(ext: string): 'kb-processor-design' | 'kb-processor-code' | 'kb-processor-spec' {
  const e = ext.toLowerCase();
  if (DESIGN_EXTS.has(e)) { return 'kb-processor-design'; }
  if (CODE_EXTS.has(e)) { return 'kb-processor-code'; }
  if (SPEC_EXTS.has(e)) { return 'kb-processor-spec'; }
  return 'kb-processor-spec';
}

// ── Hash helpers ────────────────────────────────────────────

function hashBuffer(buf: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

async function findCachedKbDoc(kbDir: string, sourceHash: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = (await fs.readdir(kbDir)).filter(f => f.endsWith('.md'));
  } catch {
    return null;
  }
  for (const file of entries) {
    try {
      const raw = await fs.readFile(path.join(kbDir, file), 'utf-8');
      const { data } = matter(raw);
      if ((data as Record<string, unknown>).source_hash === sourceHash) {
        return file;
      }
    } catch { /* skip */ }
  }
  return null;
}

// ── Quality checks ──────────────────────────────────────────

export type KbQuality = 'ok' | 'warn' | 'poor';

export interface ProcessResult {
  outPath: string;
  quality: KbQuality;
  reason?: string;
  cached: boolean;
}

function assessQuality(params: {
  body: string;
  summary: string;
  tags: string[];
  promptType: 'design' | 'code' | 'spec';
}): { quality: KbQuality; reason?: string } {
  const { body, summary, tags, promptType } = params;

  if (body.length < 200) {
    return { quality: 'poor', reason: 'extracted content is very short (<200 chars)' };
  }
  if (/placeholder|vision processing failed|re-process with a vision/i.test(body) ||
      /placeholder|failed/i.test(summary)) {
    return { quality: 'poor', reason: 'placeholder content — re-process with a vision-capable model' };
  }
  if (tags.length < 3) {
    return { quality: 'warn', reason: 'fewer than 3 tags — retrieval may miss this doc' };
  }

  if (promptType === 'design') {
    const hasHex = /#[0-9a-fA-F]{3,8}\b/.test(body);
    const hasPx = /\b\d+\s*(px|rem|em)\b/.test(body);
    if (!hasHex && !hasPx) {
      return { quality: 'warn', reason: 'no hex colors or pixel values found — extraction may be incomplete' };
    }
  }

  if (body.length < 500) {
    return { quality: 'warn', reason: 'content is short (<500 chars)' };
  }

  return { quality: 'ok' };
}

// ── KB Processor ────────────────────────────────────────────
// Inspired by llm.txt: produce ONE comprehensive knowledge file per source.

export async function processKbFile(params: {
  model: vscode.LanguageModelChat;
  filePath: string;
  kbOutDir: string;
  token: vscode.CancellationToken;
}): Promise<ProcessResult> {
  const { model, filePath, kbOutDir, token } = params;
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  const rawBuf = await fs.readFile(filePath);
  const sourceHash = hashBuffer(rawBuf);

  const cachedName = await findCachedKbDoc(kbOutDir, sourceHash);
  if (cachedName) {
    return {
      outPath: path.join(kbOutDir, cachedName),
      quality: 'ok',
      reason: 'unchanged — reused cached KB doc',
      cached: true,
    };
  }

  const content: ExtractedContent = await extractFile(filePath);
  const promptName = selectPromptName(ext);
  const promptType: 'design' | 'code' | 'spec' =
    promptName === 'kb-processor-design' ? 'design'
    : promptName === 'kb-processor-code' ? 'code'
    : 'spec';
  const tpl = await loadPrompt(promptName);

  let raw: string;

  if (content.kind === 'image') {
    const imgPart = vscode.LanguageModelDataPart.image(
      new Uint8Array(Buffer.from(content.base64, 'base64')),
      content.mime,
    );
    const visionText = new vscode.LanguageModelTextPart(tpl({
      fileName,
      fileType: 'image',
      content: '[Attached image — describe every visual detail exhaustively: layout, exact hex colors, typography (size/weight/family), spacing, every UI component, interactive states, and all visible text]',
    }));
    try {
      raw = await callLLM(model, [imgPart, visionText], token);
    } catch (visionErr: unknown) {
      const errMsg = visionErr instanceof Error ? visionErr.message : String(visionErr);
      if (errMsg.includes('media type') || errMsg.includes('image') || errMsg.includes('400')) {
        const fallback = new vscode.LanguageModelTextPart(tpl({
          fileName,
          fileType: 'image',
          content: `[DESIGN IMAGE: ${fileName}]\n\nVision processing failed with the current model. Create a placeholder knowledge document for this image. Note: switch to a vision-capable model (gpt-4o or claude-3.5-sonnet) and re-process for full design extraction.`,
        }));
        raw = await callLLM(model, [fallback], token);
      } else {
        throw visionErr;
      }
    }
  } else {
    raw = await callLLM(model, [new vscode.LanguageModelTextPart(tpl({
      fileName,
      fileType: ext.slice(1),
      content: content.text,
    }))], token);
  }

  let title: string;
  let tags: string[] = [];
  let app = 'shared';
  let componentTypes: string[] = ['general'];
  let summary = '';
  let body: string;
  try {
    const parsed = JSON.parse(extractJson(raw));
    title = (typeof parsed.title === 'string' && parsed.title) ? parsed.title : fileName;
    body = (typeof parsed.content === 'string' && parsed.content) ? parsed.content : raw;
    if (Array.isArray(parsed.tags)) { tags = parsed.tags.map(String); }
    if (typeof parsed.app === 'string' && parsed.app) { app = parsed.app; }
    if (Array.isArray(parsed.component_types)) { componentTypes = parsed.component_types.map(String); }
    if (typeof parsed.summary === 'string' && parsed.summary) { summary = parsed.summary; }
  } catch {
    title = fileName;
    body = raw;
  }

  const assessment = assessQuality({ body, summary, tags, promptType });

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]+$/, '') + '.md';
  const outPath = path.join(kbOutDir, safeName);
  await fs.mkdir(kbOutDir, { recursive: true });
  const tagsLine = tags.length ? `\ntags: [${tags.join(', ')}]` : '';
  const compLine = componentTypes.length ? `\ncomponent_types: [${componentTypes.join(', ')}]` : '';
  const summaryLine = summary ? `\nsummary: "${summary.replace(/"/g, '\\"')}"` : '';
  const md = `---\nsource: ${fileName}\nsource_hash: ${sourceHash}\ntitle: "${title.replace(/"/g, '\\"')}"\napp: ${app}${tagsLine}${compLine}${summaryLine}\nquality: ${assessment.quality}\n---\n\n${body}\n`;
  await fs.writeFile(outPath, md, 'utf-8');

  return {
    outPath,
    quality: assessment.quality,
    reason: assessment.reason,
    cached: false,
  };
}
