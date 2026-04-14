import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import Handlebars from 'handlebars';

export interface GeneratedScript {
  filePath: string;    // Relative path (e.g., tests/login.spec.ts)
  fullPath: string;    // Absolute disk path
  content: string;
}

export interface TestScriptsResult {
  framework: string;
  files: GeneratedScript[];
  outputDir: string;
}

async function loadPrompt(name: string, vars: Record<string, string>): Promise<string> {
  const promptPath = path.join(__dirname, 'prompts', `${name}.md`);
  const src = await fs.readFile(promptPath, 'utf8');
  return Handlebars.compile(src)(vars);
}

/** Parse the delimiter-formatted script output (same format as generate.ts). */
function parseScriptOutput(raw: string): { framework: string; files: Array<{ path: string; content: string }> } {
  // Strip outer fence if model wrapped everything
  let text = raw.trim();
  const fenceM = text.match(/^```[a-z]*\n([\s\S]*)\n```$/);
  if (fenceM) { text = fenceM[1].trim(); }

  const fwM = text.match(/^FRAMEWORK:\s*([a-zA-Z0-9_.+-]+)/m);
  const framework = fwM?.[1]?.trim() ?? 'playwright';

  const files: Array<{ path: string; content: string }> = [];
  const delimRe = /={3,}\s*FILE:\s*([^\n=]+?)\s*={3,}/g;
  const positions: Array<{ path: string; start: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = delimRe.exec(text)) !== null) {
    positions.push({ path: m[1].trim(), start: m.index + m[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const { path: fp, start } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].path.length - 10 : text.length;
    let content = text.slice(start, end).trim();
    // Strip inner fence if any
    const inner = content.match(/^```[a-z]*\n([\s\S]*)\n```$/);
    if (inner) { content = inner[1].trim(); }
    if (fp && content) { files.push({ path: fp, content }); }
  }

  return { framework, files };
}

export interface GenerateTestScriptsOptions {
  model: vscode.LanguageModelChat;
  sourceContent: string;     // Test cases or user stories
  baseUrl: string;           // Target application URL
  outputDir: string;
  token: vscode.CancellationToken;
  onProgress?: (msg: string) => void;
  onStream?: (chunk: string) => void;
}

export async function generateTestScripts(opts: GenerateTestScriptsOptions): Promise<TestScriptsResult> {
  const { model, sourceContent, baseUrl, outputDir, token, onProgress, onStream } = opts;

  onProgress?.('Generating Playwright test scripts with Copilot…');

  const promptText = await loadPrompt('qa-test-scripts', {
    content: sourceContent,
    baseUrl: baseUrl || 'http://localhost:3000',
  });

  let rawOutput = '';
  const messages = [vscode.LanguageModelChatMessage.User(promptText)];
  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    rawOutput += chunk;
    onStream?.(chunk);
  }

  onProgress?.('Parsing and writing script files…');
  const { framework, files } = parseScriptOutput(rawOutput);

  if (files.length === 0) {
    throw new Error('No script files could be parsed from the LLM output.');
  }

  // Write all script files under outputDir
  const generatedFiles: GeneratedScript[] = [];
  for (const f of files) {
    // Normalise path separators and prevent directory traversal
    const safePath = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(outputDir, safePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, f.content, 'utf8');
    generatedFiles.push({ filePath: safePath, fullPath, content: f.content });
    onProgress?.(`Wrote ${safePath}`);
  }

  return { framework, files: generatedFiles, outputDir };
}
