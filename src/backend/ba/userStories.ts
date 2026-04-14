import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import Handlebars from 'handlebars';
import * as XLSX from 'xlsx';
import { extractContent } from '../kb/extract';

export interface UserStory {
  id: string;
  epic: string;
  title: string;
  story: string;
  acceptanceCriteria: string[];
  priority: 'High' | 'Medium' | 'Low';
  points: number;
  tags: string[];
}

export interface UserStoriesResult {
  stories: UserStory[];
  summary: { total: number; epics: string[]; highCount: number };
  markdownPath: string;
  excelPath: string;
  csvPath: string;
  excelBase64: string;
}

/** Load and compile a Handlebars prompt template from dist/prompts/. */
async function loadPrompt(name: string, vars: Record<string, string>): Promise<string> {
  const promptPath = path.join(__dirname, 'prompts', `${name}.md`);
  const src = await fs.readFile(promptPath, 'utf8');
  return Handlebars.compile(src)(vars);
}

/** Extract text from any supported file type. */
async function extractText(filePath: string): Promise<string> {
  const extracted = await extractContent(filePath);
  if (extracted.kind === 'text') { return extracted.text; }
  return `[Image file: ${path.basename(filePath)} — cannot extract text]`;
}

/** Parse the delimiter-formatted LLM output into structured UserStory objects. */
function parseStoriesOutput(raw: string): { stories: UserStory[]; summary: UserStoriesResult['summary'] } {
  const stories: UserStory[] = [];
  const storyBlocks = [...raw.matchAll(/={3,}\s*STORY:\s*(US-\d+)\s*={3,}([\s\S]*?)={3,}\s*END STORY\s*={3,}/gi)];

  for (const [, id, body] of storyBlocks) {
    const epicM = body.match(/^Epic:\s*(.+)$/m);
    const titleM = body.match(/^Title:\s*(.+)$/m);
    const storyM = body.match(/^Story:\s*(.+)$/m);
    const priorityM = body.match(/^Priority:\s*(High|Medium|Low)/im);
    const pointsM = body.match(/^Points:\s*(\d+)/im);
    const tagsM = body.match(/^Tags:\s*(.+)$/m);

    // Acceptance Criteria — lines that start with "- GIVEN"
    const acLines = [...body.matchAll(/^-\s+(GIVEN.+)$/gm)].map(m => m[1].trim());

    stories.push({
      id: id.trim(),
      epic: epicM?.[1]?.trim() ?? 'General',
      title: titleM?.[1]?.trim() ?? id.trim(),
      story: storyM?.[1]?.trim() ?? '',
      acceptanceCriteria: acLines,
      priority: (priorityM?.[1]?.trim() ?? 'Medium') as UserStory['priority'],
      points: parseInt(pointsM?.[1] ?? '3', 10) || 3,
      tags: tagsM?.[1]?.split(',').map(t => t.trim()).filter(Boolean) ?? [],
    });
  }

  // Summary block
  const sumM = raw.match(/={3,}\s*SUMMARY\s*={3,}([\s\S]*?)={3,}\s*END SUMMARY\s*={3,}/i);
  const epicsM = sumM?.[1]?.match(/^Epics:\s*(.+)$/m);
  const highM = sumM?.[1]?.match(/^High Priority Count:\s*(\d+)/m);

  return {
    stories,
    summary: {
      total: stories.length,
      epics: epicsM?.[1]?.split(',').map(e => e.trim()).filter(Boolean) ?? [...new Set(stories.map(s => s.epic))],
      highCount: parseInt(highM?.[1] ?? '0', 10) || stories.filter(s => s.priority === 'High').length,
    },
  };
}

/** Generate Excel (.xlsx) from user stories. Returns base64 string. */
function buildExcel(stories: UserStory[]): { buffer: Buffer; base64: string } {
  const wb = XLSX.utils.book_new();

  // Stories sheet
  const storyRows = [
    ['Story ID', 'Epic', 'Title', 'User Story', 'Acceptance Criteria', 'Priority', 'Story Points', 'Tags', 'Status'],
    ...stories.map(s => [
      s.id,
      s.epic,
      s.title,
      s.story,
      s.acceptanceCriteria.join('\n'),
      s.priority,
      s.points,
      s.tags.join(', '),
      'To Do',
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(storyRows);
  // Column widths
  ws['!cols'] = [10, 18, 30, 60, 80, 10, 8, 30, 12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'User Stories');

  // Epic summary sheet
  const epics = [...new Set(stories.map(s => s.epic))];
  const epicRows = [
    ['Epic', 'Story Count', 'Total Points', 'High Priority'],
    ...epics.map(e => {
      const es = stories.filter(s => s.epic === e);
      return [e, es.length, es.reduce((a, s) => a + s.points, 0), es.filter(s => s.priority === 'High').length];
    }),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(epicRows);
  ws2['!cols'] = [25, 14, 14, 14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Epic Summary');

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
  return { buffer, base64: buffer.toString('base64') };
}

/** Generate CSV from user stories. */
function buildCsv(stories: UserStory[]): string {
  const escape = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const header = ['Story ID', 'Epic', 'Title', 'User Story', 'Acceptance Criteria', 'Priority', 'Points', 'Tags', 'Status'];
  const rows = stories.map(s => [
    s.id, s.epic, s.title, s.story,
    s.acceptanceCriteria.join(' | '),
    s.priority, String(s.points),
    s.tags.join('; '),
    'To Do',
  ].map(escape).join(','));
  return [header.map(escape).join(','), ...rows].join('\n');
}

/** Build markdown representation of all user stories. */
function buildMarkdown(stories: UserStory[], summary: UserStoriesResult['summary'], sourceFile: string): string {
  const now = new Date().toISOString().slice(0, 10);
  let md = `---\nsource: ${path.basename(sourceFile)}\ngenerated: ${now}\ntotal_stories: ${summary.total}\nepics: [${summary.epics.map(e => `"${e}"`).join(', ')}]\n---\n\n`;
  md += `# User Stories — ${path.basename(sourceFile, path.extname(sourceFile))}\n\n`;
  md += `> Generated ${now} | ${summary.total} stories across ${summary.epics.length} epic(s)\n\n`;

  const byEpic = new Map<string, UserStory[]>();
  for (const s of stories) {
    if (!byEpic.has(s.epic)) { byEpic.set(s.epic, []); }
    byEpic.get(s.epic)!.push(s);
  }

  for (const [epic, es] of byEpic) {
    md += `## Epic: ${epic}\n\n`;
    for (const s of es) {
      md += `### ${s.id} — ${s.title}\n\n`;
      md += `**Story:** ${s.story}\n\n`;
      md += `**Priority:** ${s.priority}  |  **Points:** ${s.points}  |  **Tags:** ${s.tags.join(', ')}\n\n`;
      md += `**Acceptance Criteria:**\n`;
      s.acceptanceCriteria.forEach(ac => { md += `- ${ac}\n`; });
      md += `\n`;
    }
  }
  return md;
}

export interface GenerateUserStoriesOptions {
  model: vscode.LanguageModelChat;
  sourceFiles: string[];       // Paths to uploaded docs
  outputDir: string;           // Where to write output files
  token: vscode.CancellationToken;
  onProgress?: (msg: string) => void;
  onStream?: (chunk: string) => void;
}

export async function generateUserStories(opts: GenerateUserStoriesOptions): Promise<UserStoriesResult> {
  const { model, sourceFiles, outputDir, token, onProgress, onStream } = opts;

  onProgress?.('Extracting content from source documents…');

  // Extract text from all source files
  const contents: string[] = [];
  for (const fp of sourceFiles) {
    onProgress?.(`Reading ${path.basename(fp)}…`);
    try {
      const text = await extractText(fp);
      contents.push(`--- Source: ${path.basename(fp)} ---\n${text}`);
    } catch (e: unknown) {
      contents.push(`--- Source: ${path.basename(fp)} --- [extraction failed: ${e instanceof Error ? e.message : String(e)}]`);
    }
  }

  const combinedContent = contents.join('\n\n');

  onProgress?.('Generating user stories with Copilot…');

  // Build prompt
  const promptText = await loadPrompt('ba-user-stories', { content: combinedContent });

  // Call LLM
  let rawOutput = '';
  const messages = [vscode.LanguageModelChatMessage.User(promptText)];
  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    rawOutput += chunk;
    onStream?.(chunk);
  }

  onProgress?.('Parsing generated stories…');
  const { stories, summary } = parseStoriesOutput(rawOutput);

  if (stories.length === 0) {
    throw new Error('No user stories could be parsed from the LLM output. Check the source document quality.');
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Hash-based filename to avoid collisions
  const hash = crypto.createHash('sha256').update(combinedContent).digest('hex').slice(0, 8);
  const baseName = `user-stories-${hash}`;

  // Write markdown
  const firstSource = sourceFiles[0] ?? 'document';
  const mdContent = buildMarkdown(stories, summary, firstSource);
  const markdownPath = path.join(outputDir, `${baseName}.md`);
  await fs.writeFile(markdownPath, mdContent, 'utf8');

  // Write Excel
  const { buffer: xlsBuf, base64: excelBase64 } = buildExcel(stories);
  const excelPath = path.join(outputDir, `${baseName}.xlsx`);
  await fs.writeFile(excelPath, xlsBuf);

  // Write CSV
  const csvContent = buildCsv(stories);
  const csvPath = path.join(outputDir, `${baseName}.csv`);
  await fs.writeFile(csvPath, csvContent, 'utf8');

  onProgress?.(`Done — ${stories.length} stories written to ${path.basename(outputDir)}`);

  return { stories, summary, markdownPath, excelPath, csvPath, excelBase64 };
}
