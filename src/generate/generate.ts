import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { retrieveContext, type RetrievalResult } from '../kb/retrieval';
import { loadPrompt, callLLM } from '../kb/processor';

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerationResult {
  framework: string;
  files: GeneratedFile[];
}

/**
 * Generate a complete project from KB context + user prompt.
 * Writes all files to outputDir and returns the result.
 */
export async function generateProject(params: {
  model: vscode.LanguageModelChat;
  kbDir: string;
  outputDir: string;
  prompt: string;
  imageBase64?: string;
  imageMime?: string;
  token: vscode.CancellationToken;
  onProgress?: (msg: string) => void;
  onStream?: (chunk: string) => void;
  onRetrieval?: (result: RetrievalResult) => void;
}): Promise<GenerationResult> {
  const { model, kbDir, outputDir, prompt, imageBase64, imageMime, token, onProgress, onStream, onRetrieval } = params;

  onProgress?.('Retrieving relevant knowledge base context...');
  const retrieval = await retrieveContext({
    kbDir,
    prompt,
    imageName: imageBase64 ? 'attached-design-image' : undefined,
    model,
    token,
  });
  const context = retrieval.context;

  if (!context && !imageBase64) {
    throw new Error('Nothing to generate from. Add files to the KB first, or attach a design image.');
  }

  // Fire the structured retrieval callback before starting generation
  onRetrieval?.(retrieval);

  if (retrieval.matched.length > 0) {
    onProgress?.(`Using ${retrieval.matched.length} KB docs (${retrieval.strategy}) — ${retrieval.matched.join(', ')}`);
  }

  onProgress?.('Compiling prompt...');
  const tpl = await loadPrompt('generate');
  const compiled = tpl({
    context: context || '(No KB files — use the attached image as the sole design reference.)',
    prompt,
  });

  onProgress?.('Generating project — this may take a minute...');
  const textPart = new vscode.LanguageModelTextPart(compiled);
  let raw: string;

  if (imageBase64 && imageMime) {
    const imgPart = vscode.LanguageModelDataPart.image(
      new Uint8Array(Buffer.from(imageBase64, 'base64')),
      imageMime,
    );
    try {
      raw = await callLLM(model, [imgPart, textPart], token, onStream);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('media type') || errMsg.includes('image') || errMsg.includes('400')) {
        onProgress?.('Selected model does not support images. Generating from KB + prompt only...');
        raw = await callLLM(model, [textPart], token, onStream);
      } else {
        throw err;
      }
    }
  } else {
    raw = await callLLM(model, [textPart], token, onStream);
  }

  onProgress?.('Parsing output...');
  const result = parseDelimitedOutput(raw);

  if (!result.files.length) {
    const preview = raw.slice(0, 400).replace(/\n/g, ' ');
    throw new Error(`No files found in model output. Preview:\n${preview}`);
  }

  onProgress?.(`Writing ${result.files.length} files...`);
  await fs.mkdir(outputDir, { recursive: true });

  for (const file of result.files) {
    const normalized = path.normalize(file.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const outPath = path.join(outputDir, normalized);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, file.content ?? '', 'utf-8');
  }

  onProgress?.(`Done — ${result.files.length} files (${result.framework})`);
  return result;
}

/**
 * Parse the delimiter-based output format emitted by the generate prompt.
 *
 * Format:
 *   FRAMEWORK: <name>
 *
 *   === FILE: <path> ===
 *   <content>
 *
 *   === FILE: <path> ===
 *   <content>
 *
 * This format avoids JSON escaping failures for code containing backslashes,
 * quotes, template literals, and regex patterns.
 *
 * The parser is deliberately lenient: it will recover files even if the model
 * wraps the whole response in a markdown fence, prepends prose, or forgets the
 * FRAMEWORK line.
 */
export function parseDelimitedOutput(raw: string): GenerationResult {
  let text = raw.trim();

  // Strip an outer markdown fence if the model wrapped the whole response
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) { text = fenceMatch[1].trim(); }

  // Extract framework (first FRAMEWORK: line anywhere in the output)
  let framework = 'unknown';
  const fwMatch = text.match(/^\s*FRAMEWORK:\s*([a-zA-Z0-9_.+-]+)/m);
  if (fwMatch) { framework = fwMatch[1].toLowerCase(); }

  // Split on file delimiters. Pattern tolerates extra whitespace and
  // optional surrounding fences on the delimiter line itself.
  const delimiter = /(?:^|\n)[ \t]*=+[ \t]*FILE:[ \t]*([^\n=]+?)[ \t]*=+[ \t]*(?=\n|$)/g;

  const files: GeneratedFile[] = [];
  const matches: Array<{ path: string; start: number; end: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = delimiter.exec(text)) !== null) {
    matches.push({ path: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const { path: filePath, end } = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : text.length;
    let content = text.slice(end, nextStart);

    // Strip leading/trailing single blank line introduced by the delimiter
    content = content.replace(/^\n/, '').replace(/\n$/, '');

    // If the whole file body is wrapped in a ``` fence, strip it
    const innerFence = content.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
    if (innerFence) { content = innerFence[1]; }

    if (filePath) {
      files.push({ path: filePath, content });
    }
  }

  return { framework, files };
}
