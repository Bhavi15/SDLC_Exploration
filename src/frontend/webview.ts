import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { processKbFile } from '../backend/kb/processor';
import { generateProject } from '../backend/generate/generate';
import { listKbFiles } from '../backend/kb/index';
import { generateUserStories } from '../backend/ba/userStories';
import { generateBrd } from '../backend/ba/brd';
import { generateTestCases } from '../backend/qa/testCases';
import { generateTestScripts } from '../backend/qa/testScripts';
import { runPlaywrightTests } from '../backend/qa/runTests';

export class PipelinePanel {
  static readonly viewType = 'figmaCode.pipeline';
  private static _instance: PipelinePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _availableModels: vscode.LanguageModelChat[] = [];
  private _selectedModelId: string | undefined;
  private _baDocFiles: string[] = [];           // Paths of uploaded BA source docs
  private _lastStoriesContent: string = '';      // Markdown output of last user stories run
  private _lastTestCasesContent: string = '';    // Markdown output of last test cases run
  private _lastScriptDir: string = '';           // Dir where Playwright scripts were written
  private _testRunCts: vscode.CancellationTokenSource | undefined;

  static createOrShow(extensionUri: vscode.Uri) {
    if (PipelinePanel._instance) {
      PipelinePanel._instance._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PipelinePanel.viewType, 'SDLC', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] },
    );
    PipelinePanel._instance = new PipelinePanel(panel, extensionUri);
  }

  static refresh() { PipelinePanel._instance?.refreshTree(); }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    panel.webview.html = this._getHtml();
    panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    panel.onDidDispose(() => { PipelinePanel._instance = undefined; });
    setTimeout(() => this._init(), 400);
  }

  private async _init() {
    await Promise.all([this._loadModels(), this.refreshTree()]);
  }

  private async _loadModels() {
    try {
      this._availableModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (!this._selectedModelId && this._availableModels.length > 0) {
        const pref = this._availableModels.find(m => m.id.includes('gpt-4o') || m.family?.includes('gpt-4o'));
        this._selectedModelId = (pref ?? this._availableModels[0]).id;
      }
      const list = this._availableModels.map(m => ({ id: m.id, name: m.name ?? m.id, family: m.family ?? '' }));
      this._post({ type: 'models', models: list, selectedId: this._selectedModelId });
    } catch {
      this._post({ type: 'error', message: 'Could not load Copilot models. Is GitHub Copilot signed in?' });
    }
  }

  private async _getModel(): Promise<vscode.LanguageModelChat | undefined> {
    if (this._availableModels.length === 0) {
      this._availableModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    }
    const m = this._availableModels.find(x => x.id === this._selectedModelId) ?? this._availableModels[0];
    if (!m) { this._post({ type: 'error', message: 'No Copilot model available. Is GitHub Copilot signed in?' }); }
    return m;
  }

  async refreshTree() {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { return; }
    const cfg = vscode.workspace.getConfiguration('figmaCode');
    const kbDir = path.join(ws, cfg.get<string>('knowledgeBaseFolder', '.figma-code/knowledge-base'));
    const inboxDir = path.join(ws, cfg.get<string>('kbInboxFolder', '.figma-code/kb-inbox'));
    const genDir = path.join(ws, cfg.get<string>('outputFolder', '.figma-code/generated'));
    const rawDir = path.join(ws, cfg.get<string>('rawSourcesFolder', '.figma-code/raw-sources'));
    const baDir = path.join(ws, cfg.get<string>('baOutputFolder', '.figma-code/ba-output'));
    const qaDir = path.join(ws, cfg.get<string>('qaOutputFolder', '.figma-code/qa-output'));
    const [kb, inbox, gen, rawSources, baOutput, qaOutput] = await Promise.all([
      listKbFiles(kbDir), listKbFiles(inboxDir), listKbFiles(genDir), listKbFiles(rawDir),
      listKbFiles(baDir), listKbFiles(qaDir),
    ]);
    this._post({ type: 'tree', kb, inbox, generated: gen, rawSources, baOutput, qaOutput });
  }

  private async _handleMessage(msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case 'selectModel': this._selectedModelId = msg.modelId as string; return;
      case 'addFiles': return this._addFiles();
      case 'attachImage': return this._attachImage();
      case 'processInbox': return this._processInbox();
      case 'generate': return this._onGenerate(
        msg.prompt as string, msg.imageBase64 as string | undefined, msg.imageMime as string | undefined);
      case 'refresh': return this.refreshTree();
      case 'deleteKbFile': return this._deleteKbFile(msg.name as string);
      // BA
      case 'ba:addDocs': return this._baAddDocs();
      case 'ba:generateStories': return this._baGenerateStories();
      case 'ba:generateBrd': return this._baGenerateBrd(msg.sourceType as string);
      case 'ba:openOutput': return this._openFile(msg.filePath as string);
      // QA
      case 'qa:generateTestCases': return this._qaGenerateTestCases(msg.sourceType as string);
      case 'qa:generateScripts': return this._qaGenerateScripts(msg.baseUrl as string, msg.sourceType as string);
      case 'qa:runTests': return this._qaRunTests(msg.scriptDir as string | undefined);
      case 'qa:stopTests': return this._testRunCts?.cancel();
      case 'qa:openOutput': return this._openFile(msg.filePath as string);
    }
  }

  // ─── Dev helpers ──────────────────────────────────────────────

  private async _deleteKbFile(name: string) {
    if (!name) { return; }
    const safeName = path.basename(name);
    const choice = await vscode.window.showWarningMessage(
      `Delete "${safeName}" from the knowledge base?`, { modal: true }, 'Delete');
    if (choice !== 'Delete') { return; }
    const kbDir = this._dir('knowledgeBaseFolder', '.figma-code/knowledge-base');
    try {
      await fs.unlink(path.join(kbDir, safeName));
      this._post({ type: 'status', message: 'Deleted ' + safeName });
    } catch (e: unknown) {
      this._post({ type: 'error', message: 'Failed to delete: ' + (e instanceof Error ? e.message : String(e)) });
    }
    this.refreshTree();
  }

  private async _addFiles() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: 'Add to KB Inbox',
      filters: { 'Design Sources': ['png','jpg','jpeg','gif','webp','pdf','docx'],
                 'Code & Text': ['txt','md','ts','tsx','js','jsx','json','css','html','yaml','yml'] },
    });
    if (!files?.length) { return; }
    const inbox = this._dir('kbInboxFolder', '.figma-code/kb-inbox');
    await fs.mkdir(inbox, { recursive: true });
    for (const f of files) { await fs.copyFile(f.fsPath, path.join(inbox, path.basename(f.fsPath))); }
    this._post({ type: 'status', message: 'Added ' + files.length + ' file(s) to inbox' });
    this.refreshTree();
  }

  private async _attachImage() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: 'Attach Design Image',
      filters: { 'Images': ['png','jpg','jpeg','gif','webp'] },
    });
    if (!files?.[0]) { return; }
    const buf = await fs.readFile(files[0].fsPath);
    const ext = path.extname(files[0].fsPath).toLowerCase();
    const mimes: Record<string,string> = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
    this._post({ type: 'imageAttached', base64: buf.toString('base64'), mime: mimes[ext] ?? 'image/png', name: path.basename(files[0].fsPath) });
  }

  private async _processInbox() {
    const inboxDir = this._dir('kbInboxFolder', '.figma-code/kb-inbox');
    const kbDir = this._dir('knowledgeBaseFolder', '.figma-code/knowledge-base');
    const rawDir = this._dir('rawSourcesFolder', '.figma-code/raw-sources');
    let entries: string[];
    try { entries = (await fs.readdir(inboxDir)).filter(f => !f.startsWith('.')); }
    catch { this._post({ type: 'error', message: 'Inbox folder not found. Click Add Files first.' }); return; }
    if (!entries.length) { this._post({ type: 'error', message: 'Inbox is empty. Click Add Files first.' }); return; }
    const model = await this._getModel();
    if (!model) { return; }
    const cts = new vscode.CancellationTokenSource();
    const files: string[] = [];
    for (const name of entries) {
      const fp = path.join(inboxDir, name);
      const stat = await fs.stat(fp).catch(() => null);
      if (stat?.isFile()) { files.push(name); }
    }
    if (!files.length) { this._post({ type: 'error', message: 'No processable files in inbox.' }); return; }
    const CONCURRENCY = 3;
    const queue = [...files];
    const errors: string[] = [];
    const warnings: string[] = [];
    let done = 0; let cached = 0;
    const activeFiles = new Set<string>();
    const postKbProgress = () => {
      const active = [...activeFiles];
      if (active.length > 0) {
        const activeStr = active.length === 1 ? active[0] : `${active[0]} +${active.length - 1} more`;
        this._post({ type: 'progress', message: `Processing KB: ${done}/${files.length} done — ${activeStr}` });
      }
    };
    const worker = async () => {
      while (queue.length > 0) {
        const file = queue.shift();
        if (file === undefined) { break; }
        const fp = path.join(inboxDir, file);
        activeFiles.add(file);
        postKbProgress();
        try {
          const result = await processKbFile({ model, filePath: fp, kbOutDir: kbDir, token: cts.token });
          try {
            await fs.mkdir(rawDir, { recursive: true });
            const destRaw = path.join(rawDir, file);
            await fs.access(destRaw).catch(async () => fs.copyFile(fp, destRaw));
          } catch { /* non-fatal */ }
          await fs.unlink(fp);
          activeFiles.delete(file);
          done++;
          if (result.cached) { cached++; }
          if (result.quality === 'poor') {
            errors.push(`${file}: ${result.reason ?? 'poor quality'} — review the KB doc before generating`);
          } else if (result.quality === 'warn') {
            warnings.push(`${file}: ${result.reason ?? 'quality warning'}`);
          }
          postKbProgress();
        } catch (e: unknown) {
          activeFiles.delete(file);
          errors.push(file + ': ' + (e instanceof Error ? e.message : String(e)));
          postKbProgress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
    const cachedNote = cached > 0 ? ` (${cached} unchanged, reused cache)` : '';
    this._post({ type: 'status', message: `Processed ${done}/${files.length} files into KB${cachedNote}` });
    if (warnings.length) { this._post({ type: 'progress', message: `Quality warnings: ${warnings.join(' | ')}` }); }
    if (errors.length) { this._post({ type: 'errors', errors }); }
    this.refreshTree();
  }

  private async _onGenerate(prompt: string, imageBase64?: string, imageMime?: string) {
    if (!prompt?.trim()) { this._post({ type: 'error', message: 'Enter a prompt first.' }); return; }
    const model = await this._getModel();
    if (!model) { return; }
    const kbDir = this._dir('knowledgeBaseFolder', '.figma-code/knowledge-base');
    const outputDir = this._dir('outputFolder', '.figma-code/generated');
    const cts = new vscode.CancellationTokenSource();
    try {
      this._post({ type: 'streamStart' });
      const result = await generateProject({
        model, kbDir, outputDir, prompt: prompt.trim(), imageBase64, imageMime, token: cts.token,
        onProgress: msg => this._post({ type: 'progress', message: msg }),
        onStream: chunk => this._post({ type: 'stream', chunk }),
        onRetrieval: r => this._post({
          type: 'kbContext', strategy: r.strategy, docs: r.matchedDocs,
          totalDocs: r.matchedDocs.length, hasImage: !!imageBase64,
        }),
      });
      this._post({ type: 'generated', framework: result.framework, fileCount: result.files.length,
                   files: result.files.map((f: { path: string }) => f.path) });
      this.refreshTree();
    } catch (e: unknown) {
      this._post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ─── BA handlers ──────────────────────────────────────────────

  private async _baAddDocs() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: 'Add BA Source Documents',
      filters: {
        'Documents': ['pdf','docx','txt','md'],
        'Spreadsheets': ['xlsx','xls','csv'],
        'All Files': ['*'],
      },
    });
    if (!files?.length) { return; }
    const baInbox = this._dir('baOutputFolder', '.figma-code/ba-output') + '-inbox';
    await fs.mkdir(baInbox, { recursive: true });
    this._baDocFiles = [];
    for (const f of files) {
      const dest = path.join(baInbox, path.basename(f.fsPath));
      await fs.copyFile(f.fsPath, dest);
      this._baDocFiles.push(dest);
    }
    this._post({ type: 'ba:docsAdded', files: this._baDocFiles.map(f => path.basename(f)), count: this._baDocFiles.length });
    this._post({ type: 'status', message: `Added ${files.length} document(s) for BA processing` });
  }

  private async _baGenerateStories() {
    if (!this._baDocFiles.length) {
      this._post({ type: 'error', message: 'Add source documents first (click "Add Documents").' });
      return;
    }
    const model = await this._getModel();
    if (!model) { return; }
    const outputDir = this._dir('baOutputFolder', '.figma-code/ba-output');
    const cts = new vscode.CancellationTokenSource();
    try {
      this._post({ type: 'ba:streamStart', label: 'Generating user stories…' });
      const result = await generateUserStories({
        model,
        sourceFiles: this._baDocFiles,
        outputDir,
        token: cts.token,
        onProgress: msg => this._post({ type: 'progress', message: msg }),
        onStream: chunk => this._post({ type: 'ba:stream', chunk }),
      });
      this._lastStoriesContent = await fs.readFile(result.markdownPath, 'utf8');
      this._post({
        type: 'ba:storiesDone',
        stories: result.stories,
        summary: result.summary,
        markdownPath: result.markdownPath,
        excelPath: result.excelPath,
        csvPath: result.csvPath,
        excelBase64: result.excelBase64,
        excelFileName: path.basename(result.excelPath),
        csvFileName: path.basename(result.csvPath),
      });
      this._post({ type: 'status', message: `User stories generated — ${result.stories.length} stories written to ${path.basename(outputDir)}` });
      this.refreshTree();
    } catch (e: unknown) {
      this._post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async _baGenerateBrd(sourceType: string) {
    const model = await this._getModel();
    if (!model) { return; }
    const outputDir = this._dir('baOutputFolder', '.figma-code/ba-output');
    let sourceFiles: string[] = [];

    if (sourceType === 'docs' && this._baDocFiles.length) {
      sourceFiles = this._baDocFiles;
    } else if (sourceType === 'stories' && this._lastStoriesContent) {
      // Write stories content to a temp file
      const tmpPath = path.join(outputDir, '_stories-for-brd.md');
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(tmpPath, this._lastStoriesContent, 'utf8');
      sourceFiles = [tmpPath];
    } else {
      this._post({ type: 'error', message: 'No source available. Generate user stories first or add documents.' });
      return;
    }

    const cts = new vscode.CancellationTokenSource();
    try {
      this._post({ type: 'ba:brdStreamStart', label: 'Generating BRD…' });
      const result = await generateBrd({
        model, sourceFiles, outputDir, token: cts.token,
        onProgress: msg => this._post({ type: 'progress', message: msg }),
        onStream: chunk => this._post({ type: 'ba:brdStream', chunk }),
      });
      this._post({
        type: 'ba:brdDone',
        markdownPath: result.markdownPath,
        requirementCount: result.requirementCount,
        preview: result.markdownContent.slice(0, 3000),
      });
      this._post({ type: 'status', message: `BRD generated — ${result.requirementCount} requirements` });
      this.refreshTree();
    } catch (e: unknown) {
      this._post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ─── QA handlers ──────────────────────────────────────────────

  private async _qaGenerateTestCases(sourceType: string) {
    const model = await this._getModel();
    if (!model) { return; }
    const outputDir = this._dir('qaOutputFolder', '.figma-code/qa-output');
    let sourceContent = '';
    if (sourceType === 'stories' && this._lastStoriesContent) {
      sourceContent = this._lastStoriesContent;
    } else {
      // Try to load from BA output directory
      const baDir = this._dir('baOutputFolder', '.figma-code/ba-output');
      try {
        const files = (await fs.readdir(baDir)).filter(f => f.endsWith('.md') && f.startsWith('user-stories'));
        if (files.length > 0) {
          files.sort();
          sourceContent = await fs.readFile(path.join(baDir, files[files.length - 1]), 'utf8');
        }
      } catch { /* no files */ }
    }
    if (!sourceContent) {
      this._post({ type: 'error', message: 'No user stories found. Generate user stories in the BA module first.' });
      return;
    }
    const cts = new vscode.CancellationTokenSource();
    try {
      this._post({ type: 'qa:streamStart', label: 'Generating test cases…' });
      const result = await generateTestCases({
        model, sourceContent, outputDir, token: cts.token,
        onProgress: msg => this._post({ type: 'progress', message: msg }),
        onStream: chunk => this._post({ type: 'qa:stream', chunk }),
      });
      this._lastTestCasesContent = await fs.readFile(result.markdownPath, 'utf8');
      this._post({
        type: 'qa:testCasesDone',
        testCases: result.testCases,
        summary: result.summary,
        markdownPath: result.markdownPath,
        excelPath: result.excelPath,
        csvPath: result.csvPath,
        excelBase64: result.excelBase64,
        excelFileName: path.basename(result.excelPath),
        csvFileName: path.basename(result.csvPath),
      });
      this._post({ type: 'status', message: `Test cases generated — ${result.testCases.length} cases in ${result.summary.suites.length} suite(s)` });
      this.refreshTree();
    } catch (e: unknown) {
      this._post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async _qaGenerateScripts(baseUrl: string, sourceType: string) {
    const model = await this._getModel();
    if (!model) { return; }
    const qaDir = this._dir('qaOutputFolder', '.figma-code/qa-output');
    const scriptOutputDir = path.join(qaDir, 'playwright-tests');
    let sourceContent = '';
    if (sourceType === 'testcases' && this._lastTestCasesContent) {
      sourceContent = this._lastTestCasesContent;
    } else if (this._lastStoriesContent) {
      sourceContent = this._lastStoriesContent;
    } else {
      this._post({ type: 'error', message: 'No test cases or user stories found. Run test case generation first.' });
      return;
    }
    const cts = new vscode.CancellationTokenSource();
    try {
      this._post({ type: 'qa:streamStart', label: 'Generating Playwright scripts…' });
      const result = await generateTestScripts({
        model, sourceContent,
        baseUrl: baseUrl || 'http://localhost:3000',
        outputDir: scriptOutputDir, token: cts.token,
        onProgress: msg => this._post({ type: 'progress', message: msg }),
        onStream: chunk => this._post({ type: 'qa:stream', chunk }),
      });
      this._lastScriptDir = scriptOutputDir;
      this._post({
        type: 'qa:scriptsDone',
        files: result.files.map(f => f.filePath),
        outputDir: scriptOutputDir,
        framework: result.framework,
      });
      this._post({ type: 'status', message: `Scripts generated — ${result.files.length} files in ${path.basename(scriptOutputDir)}` });
      this.refreshTree();
    } catch (e: unknown) {
      this._post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async _qaRunTests(scriptDirOverride?: string) {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { this._post({ type: 'error', message: 'No workspace open.' }); return; }
    const scriptDir = scriptDirOverride || this._lastScriptDir;
    if (!scriptDir) {
      this._post({ type: 'error', message: 'No test scripts found. Generate scripts first.' });
      return;
    }
    if (this._testRunCts) { this._testRunCts.cancel(); }
    this._testRunCts = new vscode.CancellationTokenSource();
    this._post({ type: 'qa:testRunStart' });
    try {
      const result = await runPlaywrightTests({
        scriptDir, workspaceRoot: ws,
        token: this._testRunCts.token,
        onOutput: (line, kind) => this._post({ type: 'qa:testOutput', line, kind }),
        onDone: r => this._post({ type: 'qa:testDone', ...r }),
      });
      if (result.reportPath) {
        this._post({ type: 'qa:reportReady', reportPath: result.reportPath });
      }
    } catch (e: unknown) {
      this._post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async _openFile(filePath: string) {
    if (!filePath) { return; }
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } catch (e: unknown) {
      this._post({ type: 'error', message: 'Cannot open file: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  private _dir(key: string, def: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return path.join(ws, vscode.workspace.getConfiguration('figmaCode').get<string>(key, def));
  }

  private _post(msg: Record<string, unknown>) { this._panel.webview.postMessage(msg); }

  // ─── HTML ──────────────────────────────────────────────────────

  private _getHtml(): string {
    const scriptUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const nonce = Array.from({length:32},()=>chars[Math.floor(Math.random()*62)]).join('');
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:;`;
    return `<!DOCTYPE html><html lang="en" data-theme="dark"><head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SDLC</title>
<style>
:root{color-scheme:dark light}
:root[data-theme="dark"]{
  --bg:#17171B;--side:#121215;--panel:#1C1C21;--card:#23232A;--card-h:#2B2B33;
  --fg:#E6E6EA;--dim:#8B8B94;--border:#2C2C35;
  --acc:#818CF8;--acc-soft:rgba(129,140,248,.14);
  --btn:#4F46E5;--btn-fg:#FFFFFF;--btn-h:#6366F1;
  --inp:#1A1A20;--inp-fg:#E6E6EA;--inp-b:#2C2C35;
  --shadow:0 1px 3px rgba(0,0,0,.4);
  --error:#F48771;--ok:#73C991;--info:#818CF8;
}
:root[data-theme="light"]{
  --bg:#F4F5F7;--side:#FAFBFC;--panel:#FFFFFF;--card:#FFFFFF;--card-h:#F1F3F5;
  --fg:#0F1419;--dim:#5B6472;--border:#E4E7EB;
  --acc:#4338CA;--acc-soft:rgba(67,56,202,.08);
  --btn:#0F1419;--btn-fg:#FFFFFF;--btn-h:#1F2937;
  --inp:#FFFFFF;--inp-fg:#0F1419;--inp-b:#D4D8DD;
  --shadow:0 1px 2px rgba(15,20,25,.06),0 1px 3px rgba(15,20,25,.04);
  --error:#B42318;--ok:#067647;--info:#175CD3;
}
[data-theme="dark"] .i-kb{background:rgba(129,140,248,.16);color:#A5B4FC}
[data-theme="dark"] .i-ba{background:rgba(34,211,238,.14);color:#67E8F9}
[data-theme="dark"] .i-dev{background:rgba(245,158,11,.16);color:#FBBF24}
[data-theme="dark"] .i-qa{background:rgba(74,222,128,.16);color:#86EFAC}
[data-theme="light"] .i-kb{background:#EEF2FF;color:#4338CA}
[data-theme="light"] .i-ba{background:#ECFEFF;color:#0E7490}
[data-theme="light"] .i-dev{background:#FEF3C7;color:#B45309}
[data-theme="light"] .i-qa{background:#DCFCE7;color:#15803D}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100vh;overflow:hidden}
body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);display:grid;grid-template-rows:54px 1fr 34px;transition:background .2s,color .2s}

header{display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:var(--side);border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;letter-spacing:-.1px}
.brand-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--acc) 0%,var(--acc) 40%,rgba(255,255,255,.25) 100%);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:800;box-shadow:var(--shadow)}
.version{font-size:10px;color:var(--dim);padding:2px 7px;border:1px solid var(--border);border-radius:10px;font-weight:500}
.header-right{display:flex;align-items:center;gap:14px}
.theme-toggle{background:var(--card);border:1px solid var(--border);color:var(--fg);padding:5px 12px;border-radius:20px;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:7px;font-weight:500;transition:background .15s}
.theme-toggle:hover{background:var(--card-h)}
.theme-toggle .dot{width:7px;height:7px;border-radius:50%;background:var(--acc)}
.model-row{display:flex;align-items:center;gap:8px}
.model-row label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.6px;font-weight:600}
select{background:var(--inp);color:var(--inp-fg);border:1px solid var(--inp-b);padding:5px 10px;border-radius:5px;font-size:12px;min-width:160px;cursor:pointer}
select:focus{outline:1px solid var(--acc)}

main{display:grid;grid-template-columns:264px 1fr;overflow:hidden}
.nav{background:var(--side);border-right:1px solid var(--border);padding:18px 14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
.nav-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--dim);padding:4px 4px 10px}
.module-card{display:flex;align-items:flex-start;gap:12px;padding:12px 13px;background:var(--card);border:1px solid var(--border);border-radius:11px;cursor:pointer;text-align:left;color:var(--fg);font:inherit;width:100%;transition:background .15s,border-color .15s,transform .1s}
.module-card:hover{background:var(--card-h);transform:translateY(-1px)}
.module-card.active{border-color:var(--acc);background:var(--acc-soft);box-shadow:var(--shadow)}
.mod-icon{flex:none;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;letter-spacing:.5px}
.mod-body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.mod-name{font-size:13px;font-weight:600;line-height:1.2}
.mod-desc{font-size:11px;color:var(--dim);line-height:1.4;white-space:normal}
.nav-footer{margin-top:auto;font-size:11px;color:var(--dim);line-height:1.55;padding:14px 6px 4px;border-top:1px solid var(--border)}
.nav-footer strong{color:var(--fg);font-weight:600;display:block;font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}

.content{overflow-y:auto;padding:28px 34px}
.view{display:flex;flex-direction:column;gap:16px;max-width:880px;animation:fade .22s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.view-head{display:flex;flex-direction:column;gap:4px;margin-bottom:4px}
.view-head h2{font-size:19px;font-weight:600;letter-spacing:-.3px}
.view-head .subtitle{font-size:12.5px;color:var(--dim);line-height:1.55}

/* Sub-tabs within a view */
.sub-tabs{display:flex;gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--card)}
.sub-tab{flex:1;padding:8px 14px;background:transparent;border:none;border-right:1px solid var(--border);color:var(--dim);font:inherit;font-size:12px;font-weight:500;cursor:pointer;text-align:center;transition:background .15s,color .15s}
.sub-tab:last-child{border-right:none}
.sub-tab:hover{background:var(--card-h);color:var(--fg)}
.sub-tab.active{background:var(--acc-soft);color:var(--acc);font-weight:600}

.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.panel-head{display:flex;align-items:center;justify-content:space-between}
.sec-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--dim)}
.count{font-size:11px;color:var(--dim);font-weight:500}

.file-list{list-style:none;max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.file-list li{padding:7px 10px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:9px}
.file-list li:hover{background:var(--card-h)}
.file-list .file-ico{color:var(--acc);font-size:10px;line-height:1;flex:none;width:10px;text-align:center}
.file-list .file-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-del{background:transparent;border:1px solid transparent;color:var(--dim);padding:2px 8px;font-size:14px;border-radius:5px;line-height:1;cursor:pointer;opacity:0;transition:opacity .15s,color .15s,background .15s,border-color .15s}
.file-list li:hover .file-del{opacity:1}
.file-del:hover{background:rgba(180,35,24,.1);color:var(--error);border-color:rgba(180,35,24,.3)}
.empty{color:var(--dim);font-style:italic}

.btn-row{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;border:none;padding:7px 16px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:background .15s,transform .05s}
button:active{transform:translateY(1px)}
.primary{background:var(--btn);color:var(--btn-fg)}.primary:hover{background:var(--btn-h)}
.secondary{background:transparent;border:1px solid var(--border);color:var(--fg)}.secondary:hover{background:var(--card-h)}
.danger{background:rgba(244,71,63,.12);border:1px solid rgba(244,71,63,.35);color:var(--fg);font-size:11px;padding:4px 10px}.danger:hover{background:rgba(244,71,63,.22)}
.success-btn{background:rgba(115,201,145,.14);border:1px solid rgba(115,201,145,.35);color:var(--ok)}.success-btn:hover{background:rgba(115,201,145,.24)}

.field-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.7px;font-weight:700}
.field-label .hint{text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px;color:var(--dim)}
.img-zone{border:1.5px dashed var(--border);border-radius:8px;padding:22px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:10px;background:var(--card);transition:border-color .15s,background .15s}
.img-zone:hover{border-color:var(--acc);background:var(--card-h)}
.img-zone.has-img{border-style:solid;border-color:var(--acc)}
#img-preview{max-width:100%;max-height:180px;border-radius:6px;display:none;object-fit:contain}
#img-hint{font-size:12.5px;color:var(--dim)}
#img-name{font-size:11px;color:var(--dim);display:none}
textarea{width:100%;background:var(--inp);color:var(--inp-fg);border:1px solid var(--inp-b);border-radius:7px;padding:12px 14px;font:inherit;resize:vertical;min-height:130px;line-height:1.55}
textarea:focus{outline:1px solid var(--acc);border-color:var(--acc)}
textarea::placeholder{color:var(--dim)}
input[type="text"],input[type="url"]{width:100%;background:var(--inp);color:var(--inp-fg);border:1px solid var(--inp-b);border-radius:7px;padding:8px 12px;font:inherit;font-size:12px}
input[type="text"]:focus,input[type="url"]:focus{outline:1px solid var(--acc);border-color:var(--acc)}
.chip-grid{display:flex;flex-wrap:wrap;gap:5px;max-height:130px;overflow-y:auto}
.chip{font-size:11px;padding:4px 10px;background:var(--card);border:1px solid var(--border);border-radius:5px;color:var(--fg);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.raw-desc{font-size:11px;color:var(--dim);line-height:1.5;padding:0 2px 6px}

/* Stream panel (shared for dev/BA/QA) */
.stream-panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.stream-header{display:flex;align-items:center;gap:9px;padding:9px 14px;background:var(--side);border-bottom:1px solid var(--border)}
.stream-pulse{width:8px;height:8px;border-radius:50%;background:var(--acc);flex:none}
.stream-pulse.active{animation:spulse 1.1s ease-in-out infinite}
.stream-pulse.done{background:var(--ok);animation:none}
.stream-pulse.fail{background:var(--error);animation:none}
@keyframes spulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}
.stream-label{font-size:11px;font-weight:600;color:var(--fg)}
.stream-chars{margin-left:auto;font-size:10px;color:var(--dim)}
.stream-body{padding:10px 14px 12px;max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;font-size:11.5px}
.sl-scanning{color:var(--dim);display:flex;align-items:center;gap:7px}
.sl-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--acc);animation:spulse 1.1s ease-in-out infinite}
.sl-fw{font-size:11px;color:var(--dim);padding:2px 0 6px;border-bottom:1px solid var(--border);margin-bottom:4px}
.sl-fw strong{color:var(--fg);text-transform:capitalize}
.sl-file{font-size:12px;display:flex;align-items:center;gap:8px;padding:1px 0;line-height:1.5}
.sl-file .sl-ic{width:14px;text-align:center;flex:none;font-size:11px}
.sl-file.done{color:var(--ok)}.sl-file.done .sl-ic{color:var(--ok)}
.sl-file.active{color:var(--fg);font-weight:500}.sl-file.active .sl-ic{color:var(--acc);animation:sblink .8s step-end infinite}
.sl-summary{font-size:11px;color:var(--dim);padding:8px 0 2px;margin-top:6px;border-top:1px solid var(--border);line-height:1.5}
.sl-summary code{font-family:monospace;background:var(--card);padding:1px 5px;border-radius:3px;font-size:10px;color:var(--fg)}
.sl-ctx-header{display:flex;align-items:center;gap:7px;padding:2px 0 5px;font-size:11px}
.sl-ctx-badge{background:var(--acc-soft);color:var(--acc);border:1px solid rgba(129,140,248,.25);border-radius:4px;padding:1px 7px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.sl-ctx-count{color:var(--dim);font-size:11px}
.sl-ctx-doc{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;line-height:1.4;min-width:0}
.sl-ctx-src{color:var(--fg);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
.sl-ctx-arrow{color:var(--dim);flex:none;font-size:10px}
.sl-ctx-kb{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sl-ctx-tag{background:var(--card);border:1px solid var(--border);border-radius:3px;font-size:9px;color:var(--dim);padding:0 5px;flex:none}
.sl-ctx-divider{border-top:1px dashed var(--border);margin:7px 0 5px}
@keyframes sblink{0%,100%{opacity:1}50%{opacity:0}}

/* Preview table */
.preview-table-wrap{overflow-x:auto;max-height:300px;overflow-y:auto;border-radius:7px;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:11.5px}
th{background:var(--card);padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);border-bottom:1px solid var(--border);position:sticky;top:0}
td{padding:7px 12px;border-bottom:1px solid var(--border);color:var(--fg);vertical-align:top;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--card-h)}
.badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:.3px}
.badge-high{background:rgba(244,135,113,.18);color:var(--error)}
.badge-medium{background:rgba(129,140,248,.16);color:var(--info)}
.badge-low{background:rgba(115,201,145,.16);color:var(--ok)}

/* Terminal output panel for Playwright */
.terminal-panel{background:#0D0D0F;border:1px solid var(--border);border-radius:8px;overflow:hidden;font-family:monospace;font-size:11.5px}
.terminal-header{display:flex;align-items:center;gap:9px;padding:7px 12px;background:#161618;border-bottom:1px solid #222}
.terminal-dot{width:7px;height:7px;border-radius:50%}
.terminal-body{padding:10px 12px;max-height:260px;overflow-y:auto;color:#CFD8E3;line-height:1.6;white-space:pre-wrap;word-break:break-all}
.t-ok{color:#73C991}.t-fail{color:#F48771}.t-warn{color:#FBBF24}.t-dim{color:#5B6472}.t-info{color:#818CF8}

/* Result summary cards */
.result-cards{display:flex;gap:10px;flex-wrap:wrap}
.result-card{flex:1;min-width:100px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;display:flex;flex-direction:column;gap:3px}
.result-card .rc-num{font-size:24px;font-weight:700;line-height:1;letter-spacing:-1px}
.result-card .rc-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.rc-pass .rc-num{color:var(--ok)}.rc-fail .rc-num{color:var(--error)}.rc-skip .rc-num{color:var(--dim)}.rc-total .rc-num{color:var(--acc)}

/* Drop zone for BA docs */
.drop-zone{border:2px dashed var(--border);border-radius:10px;padding:32px 24px;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;transition:border-color .15s,background .15s;background:var(--card);text-align:center}
.drop-zone:hover,.drop-zone.drag-over{border-color:var(--acc);background:var(--acc-soft)}
.drop-zone-icon{font-size:28px;line-height:1}
.drop-zone-label{font-size:13px;font-weight:500;color:var(--fg)}
.drop-zone-hint{font-size:11px;color:var(--dim)}

/* Output file link */
.output-link{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:6px;font-size:11.5px;cursor:pointer;transition:background .15s}
.output-link:hover{background:var(--card-h);border-color:var(--acc)}
.output-link .ol-icon{color:var(--acc);flex:none}
.output-link .ol-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
.output-link .ol-badge{font-size:9px;color:var(--dim);background:var(--card);border:1px solid var(--border);border-radius:3px;padding:1px 5px}

/* BRD preview */
.brd-preview{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;max-height:300px;overflow-y:auto;font-size:12px;line-height:1.7;color:var(--dim);white-space:pre-wrap;font-family:monospace}

/* Info note */
.info-note{background:var(--acc-soft);border:1px solid rgba(129,140,248,.25);border-radius:7px;padding:10px 14px;font-size:11.5px;color:var(--acc);line-height:1.5;display:flex;align-items:flex-start;gap:8px}

#status{padding:0 22px;font-size:11.5px;display:flex;align-items:center;border-top:1px solid var(--border);background:var(--side)}
.s-info{color:var(--info)}.s-error{color:var(--error)}.s-ok{color:var(--ok)}.s-dim{color:var(--dim)}
::-webkit-scrollbar{width:7px;height:7px}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:var(--dim)}
::-webkit-scrollbar-track{background:transparent}
[hidden]{display:none!important}

/* ==== Companion mascot ==== */
.nav-spacer{flex:1 1 auto;min-height:8px}
.mascot-dock{display:flex;flex-direction:row;align-items:center;gap:8px;padding:10px 8px 6px;border-top:1px solid var(--border);margin-top:2px}
.mascot{width:42px;height:46px;position:relative;flex:none}
.mascot svg{width:100%;height:100%;overflow:visible}
.mascot-mood{font-size:10px;color:var(--dim);line-height:1.35;flex:1}
[data-theme="dark"]{--mc-kb:#A5B4FC;--mc-ba:#67E8F9;--mc-dev:#FBBF24;--mc-qa:#86EFAC}
[data-theme="light"]{--mc-kb:#4338CA;--mc-ba:#0E7490;--mc-dev:#B45309;--mc-qa:#15803D}
[data-theme="dark"] .mascot{--m-body:#262631;--m-stroke:#4A4A58;--m-face:#F1F5F9;--m-shadow:rgba(0,0,0,.55);--m-inner:#1C1C22}
[data-theme="light"] .mascot{--m-body:#FFFFFF;--m-stroke:#CBD0D8;--m-face:#0F1419;--m-shadow:rgba(15,20,25,.18);--m-inner:#F1F3F5}
.mascot.mod-kb{--m-accent:var(--mc-kb)}.mascot.mod-ba{--m-accent:var(--mc-ba)}.mascot.mod-dev{--m-accent:var(--mc-dev)}.mascot.mod-qa{--m-accent:var(--mc-qa)}
.m-shadow{fill:var(--m-shadow)}.m-ear{fill:var(--m-body);stroke:var(--m-accent);stroke-width:1.8;stroke-linejoin:round;transition:stroke .35s}
.m-ear-inner{fill:var(--m-accent);opacity:.35;transition:fill .35s}.m-body{fill:var(--m-body);stroke:var(--m-accent);stroke-width:1.8;transition:stroke .35s}
.m-belly{fill:var(--m-inner);opacity:.6}.m-antenna-line{stroke:var(--m-accent);stroke-width:2;stroke-linecap:round;transition:stroke .35s}
.m-antenna-tip{fill:var(--m-accent);transition:fill .35s;animation:m-glow 2.2s ease-in-out infinite}
@keyframes m-glow{0%,100%{opacity:.85;r:3}50%{opacity:1;r:3.6}}
.m-eyes circle,.m-eyes path{fill:var(--m-face);stroke:var(--m-face)}.m-eyes path{fill:none;stroke-width:2.4;stroke-linecap:round}
.m-mouth{fill:none;stroke:var(--m-face);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.m-mouth-grin{fill:var(--m-face)}.m-mouth-o{fill:var(--m-face);stroke:none}.m-nose{fill:var(--m-accent);opacity:.7}.m-cheek{fill:var(--m-accent);opacity:.28}
.m-eyes,.m-mouth,.m-acc,.m-thought,.m-sparkles{display:none}
.mascot.idle .m-eyes-idle,.mascot.idle .m-mouth-smile{display:block}
.mascot.idle .m-eyes-idle circle{animation:m-blink 5s ease-in-out infinite}
.mascot.thinking .m-eyes-focus,.mascot.thinking .m-mouth-flat,.mascot.thinking .m-thought{display:block}
.mascot.celebrating .m-eyes-happy,.mascot.celebrating .m-mouth-grin,.mascot.celebrating .m-sparkles{display:block}
.mascot.sad .m-eyes-sad,.mascot.sad .m-mouth-frown{display:block}
.mascot.idle.mod-kb .m-acc-kb,.mascot.idle.mod-ba .m-acc-ba,.mascot.idle.mod-dev .m-acc-dev,.mascot.idle.mod-qa .m-acc-qa{display:block}
.m-acc path,.m-acc circle,.m-acc line{stroke:var(--m-accent);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.m-acc-ba .m-bulb-glow{fill:var(--m-accent);opacity:.2;stroke:none}.m-acc-kb .m-lens{fill:var(--m-body);opacity:.85}
.m-thought circle{fill:var(--m-accent);opacity:.75}
.m-thought circle:nth-child(1){animation:m-bubble 1.6s ease-in-out .0s infinite}
.m-thought circle:nth-child(2){animation:m-bubble 1.6s ease-in-out .25s infinite}
.m-thought circle:nth-child(3){animation:m-bubble 1.6s ease-in-out .5s infinite}
.m-sparkles path{fill:var(--m-accent)}
.m-sparkles path:nth-child(1){animation:m-spark 1.1s ease-in-out .0s infinite}
.m-sparkles path:nth-child(2){animation:m-spark 1.1s ease-in-out .3s infinite}
.m-sparkles path:nth-child(3){animation:m-spark 1.1s ease-in-out .6s infinite}
.mascot .m-float{transform-origin:60px 110px;transition:transform .35s}
.mascot.idle .m-float{animation:m-bob 3.8s ease-in-out infinite}
.mascot.thinking .m-float{animation:m-think 1.7s ease-in-out infinite}
.mascot.celebrating .m-float{animation:m-bounce 0.7s ease-in-out infinite}
.mascot.sad .m-float{animation:m-droop 2.6s ease-in-out infinite}
@keyframes m-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes m-think{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-2px) rotate(-2.5deg)}75%{transform:translateY(-2px) rotate(2.5deg)}}
@keyframes m-bounce{0%,100%{transform:translateY(0) scale(1,1)}30%{transform:translateY(-9px) scale(1.03,.97)}60%{transform:translateY(0) scale(.97,1.03)}}
@keyframes m-droop{0%,100%{transform:translateY(2px) scale(1,.98)}50%{transform:translateY(4px) scale(1,.96)}}
@keyframes m-blink{0%,94%,100%{opacity:1}96%,98%{opacity:0}}
@keyframes m-bubble{0%,100%{opacity:0;transform:translateY(3px)}40%,70%{opacity:1;transform:translateY(0)}}
@keyframes m-spark{0%,100%{opacity:.3;transform:scale(.6)}50%{opacity:1;transform:scale(1)}}
</style></head><body>
<header>
  <div class="brand"><span class="brand-mark">S</span>SDLC</div>
  <div class="header-right">
    <button class="theme-toggle" id="theme-toggle" type="button"><span class="dot"></span><span id="theme-label">Light</span></button>
    <div class="model-row">
      <label for="model-picker">Copilot Model</label>
      <select id="model-picker"><option value="">Loading models...</option></select>
    </div>
  </div>
</header>
<main>
  <aside class="nav">
    <div class="nav-title">Workspace Modules</div>
    <button class="module-card" data-module="kb" type="button">
      <span class="mod-icon i-kb">KB</span>
      <div class="mod-body"><div class="mod-name">Knowledge Base</div><div class="mod-desc">Upload specs, mockups, and compile context.</div></div>
    </button>
    <button class="module-card" data-module="ba" type="button">
      <span class="mod-icon i-ba">BA</span>
      <div class="mod-body"><div class="mod-name">Business Analysis</div><div class="mod-desc">User stories, BRDs &amp; acceptance criteria.</div></div>
    </button>
    <button class="module-card active" data-module="dev" type="button">
      <span class="mod-icon i-dev">DEV</span>
      <div class="mod-body"><div class="mod-name">Developer</div><div class="mod-desc">Design-to-code generation &amp; scaffolding.</div></div>
    </button>
    <button class="module-card" data-module="qa" type="button">
      <span class="mod-icon i-qa">QA</span>
      <div class="mod-body"><div class="mod-name">Quality Assurance</div><div class="mod-desc">Test cases, Playwright scripts &amp; live runs.</div></div>
    </button>
    <div class="nav-spacer"></div>
    <div class="mascot-dock">
      <div class="mascot idle mod-dev" id="mascot" aria-hidden="true">
        <svg viewBox="0 0 64 70">
          <ellipse class="m-shadow" cx="30" cy="67" rx="13" ry="2"/>
          <g class="m-float">
            <g class="m-thought"><circle cx="52" cy="18" r="1.6"/><circle cx="57" cy="11" r="2.2"/><circle cx="63" cy="5" r="3.1"/></g>
            <g class="m-sparkles"><path d="M4,11 L5.5,15 L9,16.5 L5.5,18 L4,22 L2.5,18 L-1,16.5 L2.5,15 Z"/><path d="M52,26 L53,29 L56,30 L53,31 L52,34 L51,31 L48,30 L51,29 Z"/></g>
            <polygon class="m-ear" points="8,27 13,12 21,27"/><polygon class="m-ear-inner" points="10,25 13,16 19,25"/>
            <polygon class="m-ear" points="39,27 47,12 52,27"/><polygon class="m-ear-inner" points="41,25 47,16 50,25"/>
            <ellipse class="m-body" cx="30" cy="42" rx="22" ry="19"/>
            <g class="m-eyes m-eyes-idle"><circle cx="22" cy="38" r="3"/><circle cx="38" cy="38" r="3"/></g>
            <g class="m-eyes m-eyes-happy"><path d="M16,40 Q22,33 28,40"/><path d="M32,40 Q38,33 44,40"/></g>
            <g class="m-eyes m-eyes-focus"><path d="M16,38 L28,38"/><path d="M32,38 L44,38"/></g>
            <g class="m-eyes m-eyes-sad"><circle cx="22" cy="40" r="2.6"/><circle cx="38" cy="40" r="2.6"/><path d="M16,31 L27,35"/><path d="M33,35 L44,31"/></g>
            <circle class="m-nose" cx="30" cy="44" r="1.6"/>
            <circle class="m-cheek" cx="14" cy="46" r="3"/><circle class="m-cheek" cx="46" cy="46" r="3"/>
            <path class="m-mouth m-mouth-smile" d="M23,52 Q30,57 37,52"/>
            <path class="m-mouth m-mouth-grin" d="M21,50 Q30,61 39,50 Q30,57 21,50 Z"/>
            <path class="m-mouth m-mouth-flat" d="M25,53 L35,53"/>
            <path class="m-mouth m-mouth-frown" d="M23,57 Q30,50 37,57"/>
            <g class="m-acc m-acc-kb"><circle class="m-lens" cx="22" cy="38" r="6"/><circle cx="22" cy="38" r="6"/><circle class="m-lens" cx="38" cy="38" r="6"/><circle cx="38" cy="38" r="6"/><line x1="28" y1="38" x2="32" y2="38"/></g>
            <g class="m-acc m-acc-ba"><circle class="m-bulb-glow" cx="54" cy="16" r="7"/><path d="M49,17 Q49,11 54,11 Q59,11 59,17 Q59,21 57,23 L57,26 L51,26 L51,23 Q49,21 49,17 Z"/><line x1="52" y1="28" x2="56" y2="28"/></g>
            <g class="m-acc m-acc-dev"><path d="M50,36 L46,42 L50,48"/><path d="M58,36 L62,42 L58,48"/></g>
            <g class="m-acc m-acc-qa"><circle cx="52" cy="38" r="5.5"/><line x1="56" y1="42" x2="61" y2="47"/></g>
          </g>
        </svg>
      </div>
      <span class="mascot-mood" id="mascot-mood">Ready to code</span>
    </div>
    <div class="nav-footer"><strong>Flow</strong>KB &rarr; BA &rarr; DEV &rarr; QA</div>
  </aside>
  <section class="content">

    <!-- ══════════════ DEV VIEW ══════════════ -->
    <div class="view" id="view-dev">
      <div class="view-head">
        <h2>Developer &mdash; Generate Project</h2>
        <div class="subtitle">Convert design intent into a production-ready codebase using the knowledge base.</div>
      </div>
      <div class="panel">
        <div class="field-label">Design Image <span class="hint">(optional &mdash; supplements KB)</span></div>
        <div class="img-zone" id="img-zone">
          <span id="img-hint">Click to attach a design screenshot or mockup</span>
          <img id="img-preview" alt="Design preview"/>
          <span id="img-name"></span>
          <button class="danger" id="btn-remove-img" style="display:none" type="button">&#10005; Remove</button>
        </div>
      </div>
      <div class="panel">
        <div class="field-label">Prompt</div>
        <textarea id="prompt" placeholder="Describe what to build. Example: Create a React landing page matching the attached design. Use exact colors and spacing from the KB."></textarea>
      </div>
      <div class="btn-row">
        <button class="primary" id="btn-generate" type="button">&#9654; Generate Project</button>
        <button class="secondary" id="btn-refresh" type="button">&#8635; Refresh</button>
      </div>
      <div class="stream-panel" id="stream-panel" style="display:none">
        <div class="stream-header"><span class="stream-pulse" id="stream-pulse"></span><span class="stream-label" id="stream-label">Copilot is generating&hellip;</span><span class="stream-chars" id="stream-chars">0 chars</span></div>
        <div class="stream-body" id="stream-body"></div>
      </div>
      <div class="panel" id="gen-files" style="display:none">
        <div class="panel-head"><span class="sec-title">Generated Files</span><span class="count" id="gen-count"></span></div>
        <div class="chip-grid" id="gen-list"></div>
      </div>
    </div>

    <!-- ══════════════ KB VIEW ══════════════ -->
    <div class="view" id="view-kb" hidden>
      <div class="view-head">
        <h2>Knowledge Base</h2>
        <div class="subtitle">Upload design specs, style guides, or mockups. Each processed file becomes a rich markdown document used as context during generation.</div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="sec-title">Processed Documents</span><span class="count" id="kb-count"></span></div>
        <ul class="file-list" id="kb-list"><li class="empty">No processed files</li></ul>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="sec-title">Inbox</span><span class="count" id="inbox-count"></span></div>
        <ul class="file-list" id="inbox-list"><li class="empty">No files</li></ul>
        <div class="btn-row">
          <button class="secondary" id="btn-add" type="button">+ Add Files</button>
          <button class="primary" id="btn-process" type="button">Process &#8594; KB</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="sec-title">Raw Sources</span><span class="count" id="raw-count"></span></div>
        <div class="raw-desc">Original files preserved after processing.</div>
        <ul class="file-list" id="raw-list"><li class="empty">No raw sources yet</li></ul>
      </div>
    </div>

    <!-- ══════════════ BA VIEW ══════════════ -->
    <div class="view" id="view-ba" hidden>
      <div class="view-head">
        <h2>Business Analysis</h2>
        <div class="subtitle">Convert documents into structured user stories &amp; BRDs using Copilot.</div>
      </div>
      <div class="sub-tabs">
        <button class="sub-tab active" data-ba-tab="stories" type="button">&#128221; Doc &rarr; User Stories</button>
        <button class="sub-tab" data-ba-tab="brd" type="button">&#128196; Stories &rarr; BRD</button>
        <button class="sub-tab" data-ba-tab="bafiles" type="button">&#128194; BA Output Files</button>
      </div>

      <!-- BA TAB: User Stories -->
      <div id="ba-tab-stories">
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:2px">
          <div class="panel">
            <div class="panel-head"><span class="sec-title">Source Documents</span><span class="count" id="ba-docs-count"></span></div>
            <div class="drop-zone" id="ba-drop-zone">
              <span class="drop-zone-icon">&#128462;</span>
              <span class="drop-zone-label">Drop documents here or click to browse</span>
              <span class="drop-zone-hint">PDF, DOCX, TXT, MD, XLSX, XLS, CSV &mdash; any requirement document</span>
            </div>
            <ul class="file-list" id="ba-docs-list"><li class="empty">No documents added</li></ul>
            <div class="btn-row">
              <button class="secondary" id="btn-ba-add-docs" type="button">+ Add Documents</button>
              <button class="primary" id="btn-ba-gen-stories" type="button">&#9889; Generate User Stories</button>
            </div>
          </div>
          <div class="stream-panel" id="ba-stream-panel" style="display:none">
            <div class="stream-header"><span class="stream-pulse" id="ba-stream-pulse"></span><span class="stream-label" id="ba-stream-label">Generating&hellip;</span><span class="stream-chars" id="ba-stream-chars"></span></div>
            <div class="stream-body" id="ba-stream-body"></div>
          </div>
          <div id="ba-stories-result" style="display:none">
            <div class="panel">
              <div class="panel-head">
                <span class="sec-title">User Stories Preview</span>
                <span class="count" id="ba-stories-count"></span>
              </div>
              <div class="preview-table-wrap">
                <table id="ba-stories-table">
                  <thead><tr><th>ID</th><th>Epic</th><th>Title</th><th>Story</th><th>Priority</th><th>Points</th></tr></thead>
                  <tbody id="ba-stories-tbody"></tbody>
                </table>
              </div>
              <div class="btn-row" style="margin-top:6px">
                <button class="success-btn" id="btn-ba-dl-excel" type="button">&#11015; Download Excel</button>
                <button class="secondary" id="btn-ba-dl-csv" type="button">&#11015; Download CSV</button>
                <button class="secondary" id="btn-ba-open-md" type="button">&#128196; Open in Editor</button>
              </div>
              <div id="ba-output-links" style="display:flex;flex-direction:column;gap:6px;margin-top:4px"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- BA TAB: BRD -->
      <div id="ba-tab-brd" hidden>
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:2px">
          <div class="panel">
            <div class="panel-head"><span class="sec-title">BRD Source</span></div>
            <div class="info-note">&#9432; Generate user stories first, or add documents directly. The BRD will be produced from whichever source you choose.</div>
            <div class="btn-row" style="margin-top:4px">
              <button class="primary" id="btn-ba-brd-from-stories" type="button">&#9889; Generate BRD from Stories</button>
              <button class="secondary" id="btn-ba-brd-from-docs" type="button">Generate from Documents</button>
            </div>
          </div>
          <div class="stream-panel" id="brd-stream-panel" style="display:none">
            <div class="stream-header"><span class="stream-pulse" id="brd-stream-pulse"></span><span class="stream-label" id="brd-stream-label">Generating BRD&hellip;</span><span class="stream-chars" id="brd-stream-chars"></span></div>
            <div class="stream-body" id="brd-stream-body"></div>
          </div>
          <div id="ba-brd-result" style="display:none">
            <div class="panel">
              <div class="panel-head"><span class="sec-title">BRD Preview</span><span class="count" id="brd-req-count"></span></div>
              <pre class="brd-preview" id="brd-preview-text"></pre>
              <div class="btn-row" style="margin-top:6px">
                <button class="primary" id="btn-ba-open-brd" type="button">&#128196; Open BRD in Editor</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- BA TAB: Output Files -->
      <div id="ba-tab-bafiles" hidden>
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:2px">
          <div class="panel">
            <div class="panel-head"><span class="sec-title">BA Output Files</span><span class="count" id="ba-output-count"></span></div>
            <ul class="file-list" id="ba-output-list"><li class="empty">No BA output files yet</li></ul>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════════ QA VIEW ══════════════ -->
    <div class="view" id="view-qa" hidden>
      <div class="view-head">
        <h2>Quality Assurance</h2>
        <div class="subtitle">Generate test cases, Playwright automation scripts, and run live browser tests.</div>
      </div>
      <div class="sub-tabs">
        <button class="sub-tab active" data-qa-tab="testcases" type="button">&#9745; Test Cases</button>
        <button class="sub-tab" data-qa-tab="scripts" type="button">&#128196; Automation Scripts</button>
        <button class="sub-tab" data-qa-tab="run" type="button">&#9654; Run Tests</button>
        <button class="sub-tab" data-qa-tab="qafiles" type="button">&#128194; QA Files</button>
      </div>

      <!-- QA TAB: Test Cases -->
      <div id="qa-tab-testcases">
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:2px">
          <div class="panel">
            <div class="panel-head"><span class="sec-title">Source</span></div>
            <div class="info-note">&#9432; Test cases will be generated from the latest user stories created in the BA module. Run BA &rarr; User Stories first.</div>
            <div class="btn-row" style="margin-top:6px">
              <button class="primary" id="btn-qa-gen-tc" type="button">&#9889; Generate Test Cases</button>
            </div>
          </div>
          <div class="stream-panel" id="qa-tc-stream-panel" style="display:none">
            <div class="stream-header"><span class="stream-pulse" id="qa-tc-pulse"></span><span class="stream-label" id="qa-tc-label">Generating test cases&hellip;</span><span class="stream-chars" id="qa-tc-chars"></span></div>
            <div class="stream-body" id="qa-tc-body"></div>
          </div>
          <div id="qa-tc-result" style="display:none">
            <div class="panel">
              <div class="panel-head"><span class="sec-title">Test Cases Preview</span><span class="count" id="qa-tc-count"></span></div>
              <div class="preview-table-wrap">
                <table id="qa-tc-table">
                  <thead><tr><th>TC ID</th><th>Suite</th><th>Title</th><th>Type</th><th>Priority</th><th>Steps</th></tr></thead>
                  <tbody id="qa-tc-tbody"></tbody>
                </table>
              </div>
              <div class="btn-row" style="margin-top:6px">
                <button class="success-btn" id="btn-qa-dl-excel" type="button">&#11015; Download Excel</button>
                <button class="secondary" id="btn-qa-dl-csv" type="button">&#11015; Download CSV</button>
                <button class="secondary" id="btn-qa-open-md" type="button">&#128196; Open in Editor</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- QA TAB: Automation Scripts -->
      <div id="qa-tab-scripts" hidden>
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:2px">
          <div class="panel">
            <div class="panel-head"><span class="sec-title">Target Application</span></div>
            <div class="field-label" style="margin-bottom:4px">Base URL <span class="hint">(where the generated app runs)</span></div>
            <input type="url" id="qa-base-url" placeholder="http://localhost:3000" value="http://localhost:3000"/>
            <div class="info-note" style="margin-top:8px">&#9432; Scripts are generated from the latest test cases. Run Test Case generation first for best results.</div>
            <div class="btn-row" style="margin-top:6px">
              <button class="primary" id="btn-qa-gen-scripts" type="button">&#9889; Generate Playwright Scripts</button>
            </div>
          </div>
          <div class="stream-panel" id="qa-sc-stream-panel" style="display:none">
            <div class="stream-header"><span class="stream-pulse" id="qa-sc-pulse"></span><span class="stream-label" id="qa-sc-label">Generating scripts&hellip;</span><span class="stream-chars" id="qa-sc-chars"></span></div>
            <div class="stream-body" id="qa-sc-body"></div>
          </div>
          <div id="qa-scripts-result" style="display:none">
            <div class="panel">
              <div class="panel-head"><span class="sec-title">Generated Script Files</span><span class="count" id="qa-scripts-count"></span></div>
              <ul class="file-list" id="qa-scripts-list"></ul>
              <div class="info-note" style="margin-top:4px">&#9432; Script files are saved in <code>.figma-code/qa-output/playwright-tests/</code> in your workspace.</div>
            </div>
          </div>
        </div>
      </div>

      <!-- QA TAB: Run Tests -->
      <div id="qa-tab-run" hidden>
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:2px">
          <div class="panel">
            <div class="panel-head"><span class="sec-title">Playwright Test Runner</span></div>
            <div class="info-note">&#9432; Runs the generated Playwright scripts against your application. Make sure the app is running before clicking Run.<br><br><strong>Requires:</strong> <code>npm install -D @playwright/test &amp;&amp; npx playwright install</code> in your workspace.</div>
            <div class="btn-row" style="margin-top:10px">
              <button class="primary" id="btn-qa-run" type="button">&#9654; Run Tests</button>
              <button class="danger" id="btn-qa-stop" style="display:none" type="button">&#9632; Stop</button>
            </div>
          </div>
          <div id="qa-run-result-cards" style="display:none" class="result-cards">
            <div class="result-card rc-pass"><span class="rc-num" id="qa-rc-pass">0</span><span class="rc-label">Passed</span></div>
            <div class="result-card rc-fail"><span class="rc-num" id="qa-rc-fail">0</span><span class="rc-label">Failed</span></div>
            <div class="result-card rc-skip"><span class="rc-num" id="qa-rc-skip">0</span><span class="rc-label">Skipped</span></div>
            <div class="result-card rc-total"><span class="rc-num" id="qa-rc-dur">—</span><span class="rc-label">Duration</span></div>
          </div>
          <div class="terminal-panel" id="qa-terminal" style="display:none">
            <div class="terminal-header">
              <span class="terminal-dot" style="background:#FF5F57"></span>
              <span class="terminal-dot" style="background:#FFBD2E;margin:0 4px"></span>
              <span class="terminal-dot" style="background:#28CA41"></span>
              <span style="margin-left:8px;font-size:11px;color:#666;font-family:monospace">Playwright</span>
              <span id="qa-terminal-status" style="margin-left:auto;font-size:10px;color:#666"></span>
            </div>
            <div class="terminal-body" id="qa-terminal-body"></div>
          </div>
        </div>
      </div>

      <!-- QA TAB: QA Files -->
      <div id="qa-tab-qafiles" hidden>
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:2px">
          <div class="panel">
            <div class="panel-head"><span class="sec-title">QA Output Files</span><span class="count" id="qa-output-count"></span></div>
            <ul class="file-list" id="qa-output-list"><li class="empty">No QA output files yet</li></ul>
          </div>
        </div>
      </div>
    </div>

  </section>
</main>
<div id="status"><span class="s-dim">Ready</span></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
}
