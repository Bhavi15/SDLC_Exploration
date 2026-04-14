import * as vscode from 'vscode';
import * as path from 'path';
import { listKbFiles } from '../backend/kb/index';

class KbFileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly filePath: string,
    public readonly isDir: boolean,
  ) {
    super(label, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    if (!isDir) {
      this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] };
      this.contextValue = 'kbFile';
    }
  }
}

export class KbTreeProvider implements vscode.TreeDataProvider<KbFileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<KbFileItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private kbDir: string;

  constructor(workspaceRoot: string) {
    const cfg = vscode.workspace.getConfiguration('figmaCode');
    this.kbDir = path.join(workspaceRoot, cfg.get<string>('knowledgeBaseFolder', '.figma-code/knowledge-base'));
  }

  refresh() { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(el: KbFileItem): vscode.TreeItem { return el; }

  async getChildren(el?: KbFileItem): Promise<KbFileItem[]> {
    const dir = el ? el.filePath : this.kbDir;
    const entries = await listKbFiles(dir);
    return entries.map(e => {
      const clean = e.name.replace(/\/$/, '');
      return new KbFileItem(clean, path.join(dir, clean), e.kind === 'dir');
    });
  }
}
