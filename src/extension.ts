import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PipelinePanel } from './ui/webview';
import { KbTreeProvider } from './ui/tree';

export function activate(context: vscode.ExtensionContext) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) { return; }

  // Ensure workspace folders exist
  const cfg = vscode.workspace.getConfiguration('figmaCode');
  const kbDir = path.join(ws, cfg.get<string>('knowledgeBaseFolder', '.figma-code/knowledge-base'));
  const inboxDir = path.join(ws, cfg.get<string>('kbInboxFolder', '.figma-code/kb-inbox'));
  const outDir = path.join(ws, cfg.get<string>('outputFolder', '.figma-code/generated'));
  ensureDirs(kbDir, inboxDir, outDir);

  // Tree view for sidebar
  const treeProvider = new KbTreeProvider(ws);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('figmaCode.knowledgeBase', treeProvider),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('figmaCode.openPanel', () => {
      PipelinePanel.createOrShow(context.extensionUri);
    }),
    vscode.commands.registerCommand('figmaCode.refreshKb', () => {
      treeProvider.refresh();
      PipelinePanel.refresh();
    }),
  );

  // Watch KB folder for changes
  const kbWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(ws, `${cfg.get<string>('knowledgeBaseFolder', '.figma-code/knowledge-base')}/**`),
  );
  kbWatcher.onDidChange(() => treeProvider.refresh());
  kbWatcher.onDidCreate(() => treeProvider.refresh());
  kbWatcher.onDidDelete(() => treeProvider.refresh());
  context.subscriptions.push(kbWatcher);
}

async function ensureDirs(...dirs: string[]) {
  for (const d of dirs) {
    await fs.mkdir(d, { recursive: true }).catch(() => {});
  }
}

export function deactivate() {}
