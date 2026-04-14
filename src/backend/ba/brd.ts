import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import Handlebars from 'handlebars';
import { extractContent } from '../kb/extract';

export interface BrdResult {
  markdownPath: string;
  markdownContent: string;
  requirementCount: number;
}

async function loadPrompt(name: string, vars: Record<string, string>): Promise<string> {
  const promptPath = path.join(__dirname, 'prompts', `${name}.md`);
  const src = await fs.readFile(promptPath, 'utf8');
  return Handlebars.compile(src)(vars);
}

async function extractText(filePath: string): Promise<string> {
  const extracted = await extractContent(filePath);
  if (extracted.kind === 'text') { return extracted.text; }
  return `[Image file: ${path.basename(filePath)} — describe the visuals in your own words for BRD input]`;
}

/** Count BR-NNN entries to give a quick summary stat. */
function countRequirements(md: string): number {
  return (md.match(/###\s+BR-\d+/g) ?? []).length;
}

export interface GenerateBrdOptions {
  model: vscode.LanguageModelChat;
  sourceFiles: string[];
  outputDir: string;
  token: vscode.CancellationToken;
  onProgress?: (msg: string) => void;
  onStream?: (chunk: string) => void;
}

export async function generateBrd(opts: GenerateBrdOptions): Promise<BrdResult> {
  const { model, sourceFiles, outputDir, token, onProgress, onStream } = opts;

  onProgress?.('Reading source documents…');
  const contents: string[] = [];
  for (const fp of sourceFiles) {
    onProgress?.(`Extracting ${path.basename(fp)}…`);
    try {
      const text = await extractText(fp);
      contents.push(`--- Source: ${path.basename(fp)} ---\n${text}`);
    } catch (e: unknown) {
      contents.push(`--- Source: ${path.basename(fp)} --- [extraction failed]`);
    }
  }

  const combinedContent = contents.join('\n\n');

  onProgress?.('Generating BRD with Copilot…');
  const promptText = await loadPrompt('ba-brd', { content: combinedContent });

  let markdownContent = '';
  const messages = [vscode.LanguageModelChatMessage.User(promptText)];
  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    markdownContent += chunk;
    onStream?.(chunk);
  }

  await fs.mkdir(outputDir, { recursive: true });

  const now = new Date().toISOString().slice(0, 10);
  const markdownPath = path.join(outputDir, `brd-${now}.md`);
  await fs.writeFile(markdownPath, markdownContent, 'utf8');

  const requirementCount = countRequirements(markdownContent);
  onProgress?.(`BRD written — ${requirementCount} requirements captured`);

  return { markdownPath, markdownContent, requirementCount };
}
