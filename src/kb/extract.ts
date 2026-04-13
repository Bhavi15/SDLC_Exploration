import * as fs from 'fs/promises';
import * as path from 'path';
import mammoth from 'mammoth';

export type ExtractedContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; base64: string };

const TEXT_EXTS = new Set(['.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.yaml', '.yml']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function guessMime(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
  };
  return map[ext] ?? 'application/octet-stream';
}

export async function extractFile(absPath: string): Promise<ExtractedContent> {
  const ext = path.extname(absPath).toLowerCase();
  const buf = await fs.readFile(absPath);

  if (TEXT_EXTS.has(ext)) {
    return { kind: 'text', text: buf.toString('utf-8') };
  }

  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const getDocument = pdfjs.getDocument as (opts: { data: Uint8Array; useSystemFonts?: boolean }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: { str?: string }[] }>;
        }>;
      }>;
    };
    const pdf = await (getDocument({ data: new Uint8Array(buf), useSystemFonts: true })).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => ('str' in it ? it.str : '')).join(' ') + '\n';
    }
    return { kind: 'text', text: text.trim() };
  }

  if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { kind: 'text', text: value };
  }

  if (IMAGE_EXTS.has(ext)) {
    return { kind: 'image', mime: guessMime(ext), base64: buf.toString('base64') };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}
