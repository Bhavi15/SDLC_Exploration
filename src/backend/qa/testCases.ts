import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import Handlebars from 'handlebars';
import * as XLSX from 'xlsx';

export interface TestCase {
  id: string;
  suite: string;
  storyRef: string;
  title: string;
  type: string;
  priority: 'High' | 'Medium' | 'Low';
  preconditions: string[];
  steps: string[];
  expectedResult: string;
  passCriteria: string;
}

export interface TestCasesResult {
  testCases: TestCase[];
  summary: { total: number; suites: string[]; highCount: number; negativeCount: number };
  markdownPath: string;
  excelPath: string;
  csvPath: string;
  excelBase64: string;
}

async function loadPrompt(name: string, vars: Record<string, string>): Promise<string> {
  const promptPath = path.join(__dirname, 'prompts', `${name}.md`);
  const src = await fs.readFile(promptPath, 'utf8');
  return Handlebars.compile(src)(vars);
}

function parseTestCasesOutput(raw: string): { testCases: TestCase[]; summary: TestCasesResult['summary'] } {
  const testCases: TestCase[] = [];
  const blocks = [...raw.matchAll(/={3,}\s*TEST CASE:\s*(TC-\d+)\s*={3,}([\s\S]*?)={3,}\s*END TEST CASE\s*={3,}/gi)];

  for (const [, id, body] of blocks) {
    const get = (field: string) => body.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
    const listLines = (field: string) =>
      [...body.matchAll(new RegExp(`^-\\s+(.+)$`, 'gm'), )].map(m => m[1].trim())
        .filter(l => l.length > 0);
    const stepLines = [...body.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim());

    // Extract preconditions (lines after "Preconditions:" label up to "Test Steps:")
    const preSection = body.match(/Preconditions:\s*\n([\s\S]*?)(?=Test Steps:|$)/i)?.[1] ?? '';
    const preconditions = [...preSection.matchAll(/^-\s+(.+)$/gm)].map(m => m[1].trim()).filter(Boolean);

    testCases.push({
      id: id.trim(),
      suite: get('Suite'),
      storyRef: get('Story'),
      title: get('Title'),
      type: get('Type') || 'Functional',
      priority: (get('Priority') as TestCase['priority']) || 'Medium',
      preconditions: preconditions.length ? preconditions : ['None'],
      steps: stepLines,
      expectedResult: get('Expected Result'),
      passCriteria: get('Pass Criteria'),
    });
  }

  const sumM = raw.match(/={3,}\s*SUMMARY\s*={3,}([\s\S]*?)={3,}\s*END SUMMARY\s*={3,}/i);
  const suitesM = sumM?.[1]?.match(/^Suites:\s*(.+)$/m);
  const highM = sumM?.[1]?.match(/^High Priority:\s*(\d+)/m);
  const negM = sumM?.[1]?.match(/^Negative Tests:\s*(\d+)/m);

  return {
    testCases,
    summary: {
      total: testCases.length,
      suites: suitesM?.[1]?.split(',').map(s => s.trim()).filter(Boolean) ?? [...new Set(testCases.map(t => t.suite))],
      highCount: parseInt(highM?.[1] ?? '0') || testCases.filter(t => t.priority === 'High').length,
      negativeCount: parseInt(negM?.[1] ?? '0') || testCases.filter(t => t.type === 'Negative').length,
    },
  };
}

function buildExcel(testCases: TestCase[]): { buffer: Buffer; base64: string } {
  const wb = XLSX.utils.book_new();

  // Test Cases sheet
  const rows = [
    ['TC ID', 'Suite', 'Story Ref', 'Title', 'Type', 'Priority', 'Preconditions', 'Test Steps', 'Expected Result', 'Pass Criteria', 'Status', 'Executed By', 'Date'],
    ...testCases.map(tc => [
      tc.id,
      tc.suite,
      tc.storyRef,
      tc.title,
      tc.type,
      tc.priority,
      tc.preconditions.join('\n'),
      tc.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      tc.expectedResult,
      tc.passCriteria,
      'Not Run', '', '',
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [8, 18, 10, 40, 14, 10, 40, 60, 50, 50, 12, 16, 12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Test Cases');

  // Suite summary
  const suites = [...new Set(testCases.map(t => t.suite))];
  const suiteRows = [
    ['Suite', 'Total', 'High', 'Medium', 'Low', 'Functional', 'Negative', 'Boundary'],
    ...suites.map(s => {
      const ts = testCases.filter(t => t.suite === s);
      return [s, ts.length,
        ts.filter(t => t.priority === 'High').length,
        ts.filter(t => t.priority === 'Medium').length,
        ts.filter(t => t.priority === 'Low').length,
        ts.filter(t => t.type === 'Functional').length,
        ts.filter(t => t.type === 'Negative').length,
        ts.filter(t => t.type === 'Boundary').length,
      ];
    }),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(suiteRows);
  ws2['!cols'] = [20, 8, 8, 8, 8, 12, 10, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Suite Summary');

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
  return { buffer, base64: buffer.toString('base64') };
}

function buildCsv(testCases: TestCase[]): string {
  const escape = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const header = ['TC ID', 'Suite', 'Story Ref', 'Title', 'Type', 'Priority', 'Preconditions', 'Test Steps', 'Expected Result', 'Pass Criteria', 'Status'];
  const rows = testCases.map(tc => [
    tc.id, tc.suite, tc.storyRef, tc.title, tc.type, tc.priority,
    tc.preconditions.join(' | '),
    tc.steps.map((s, i) => `${i + 1}. ${s}`).join(' | '),
    tc.expectedResult, tc.passCriteria, 'Not Run',
  ].map(escape).join(','));
  return [header.map(escape).join(','), ...rows].join('\n');
}

function buildMarkdown(testCases: TestCase[], summary: TestCasesResult['summary']): string {
  const now = new Date().toISOString().slice(0, 10);
  let md = `---\ngenerated: ${now}\ntotal_cases: ${summary.total}\nsuites: [${summary.suites.map(s => `"${s}"`).join(', ')}]\n---\n\n`;
  md += `# Test Cases\n\n> Generated ${now} | ${summary.total} test cases | ${summary.suites.length} suite(s)\n\n`;

  const bySuite = new Map<string, TestCase[]>();
  for (const tc of testCases) {
    if (!bySuite.has(tc.suite)) { bySuite.set(tc.suite, []); }
    bySuite.get(tc.suite)!.push(tc);
  }

  for (const [suite, cases] of bySuite) {
    md += `## Suite: ${suite}\n\n`;
    for (const tc of cases) {
      md += `### ${tc.id} — ${tc.title}\n\n`;
      md += `**Type:** ${tc.type}  |  **Priority:** ${tc.priority}  |  **Story:** ${tc.storyRef}\n\n`;
      md += `**Preconditions:**\n${tc.preconditions.map(p => `- ${p}`).join('\n')}\n\n`;
      md += `**Steps:**\n${tc.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n`;
      md += `**Expected Result:** ${tc.expectedResult}\n\n`;
      md += `**Pass Criteria:** ${tc.passCriteria}\n\n---\n\n`;
    }
  }
  return md;
}

export interface GenerateTestCasesOptions {
  model: vscode.LanguageModelChat;
  sourceContent: string;       // User stories or requirements text
  outputDir: string;
  token: vscode.CancellationToken;
  onProgress?: (msg: string) => void;
  onStream?: (chunk: string) => void;
}

export async function generateTestCases(opts: GenerateTestCasesOptions): Promise<TestCasesResult> {
  const { model, sourceContent, outputDir, token, onProgress, onStream } = opts;

  onProgress?.('Generating test cases with Copilot…');
  const promptText = await loadPrompt('qa-test-cases', { content: sourceContent });

  let rawOutput = '';
  const messages = [vscode.LanguageModelChatMessage.User(promptText)];
  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    rawOutput += chunk;
    onStream?.(chunk);
  }

  onProgress?.('Parsing test cases…');
  const { testCases, summary } = parseTestCasesOutput(rawOutput);

  if (testCases.length === 0) {
    throw new Error('No test cases could be parsed. Ensure source content includes user stories or requirements.');
  }

  await fs.mkdir(outputDir, { recursive: true });

  const now = new Date().toISOString().slice(0, 10);
  const baseName = `test-cases-${now}`;

  const mdContent = buildMarkdown(testCases, summary);
  const markdownPath = path.join(outputDir, `${baseName}.md`);
  await fs.writeFile(markdownPath, mdContent, 'utf8');

  const { buffer, base64: excelBase64 } = buildExcel(testCases);
  const excelPath = path.join(outputDir, `${baseName}.xlsx`);
  await fs.writeFile(excelPath, buffer);

  const csvContent = buildCsv(testCases);
  const csvPath = path.join(outputDir, `${baseName}.csv`);
  await fs.writeFile(csvPath, csvContent, 'utf8');

  onProgress?.(`Done — ${testCases.length} test cases written`);

  return { testCases, summary, markdownPath, excelPath, csvPath, excelBase64 };
}
