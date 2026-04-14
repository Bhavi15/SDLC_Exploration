import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';

export interface RunTestsOptions {
  scriptDir: string;            // Directory containing playwright scripts
  workspaceRoot: string;        // VS Code workspace root
  token: vscode.CancellationToken;
  onOutput?: (line: string, kind: 'stdout' | 'stderr') => void;
  onDone?: (result: RunTestsResult) => void;
}

export interface RunTestsResult {
  exitCode: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  reportPath: string | null;
}

/** Check if playwright is installed in the workspace. */
async function isPlaywrightInstalled(workspaceRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(workspaceRoot, 'node_modules', '@playwright', 'test'));
    return true;
  } catch {
    try {
      await fs.access(path.join(workspaceRoot, 'node_modules', 'playwright'));
      return true;
    } catch {
      return false;
    }
  }
}

/** Parse playwright summary line like "3 passed, 1 failed, 2 skipped (8s)" */
function parseSummary(output: string): { passed: number; failed: number; skipped: number } {
  const passedM = output.match(/(\d+)\s+passed/i);
  const failedM = output.match(/(\d+)\s+failed/i);
  const skippedM = output.match(/(\d+)\s+skipped/i);
  return {
    passed: parseInt(passedM?.[1] ?? '0'),
    failed: parseInt(failedM?.[1] ?? '0'),
    skipped: parseInt(skippedM?.[1] ?? '0'),
  };
}

export async function runPlaywrightTests(opts: RunTestsOptions): Promise<RunTestsResult> {
  const { scriptDir, workspaceRoot, token, onOutput, onDone } = opts;
  const startTime = Date.now();

  // Determine config path: prefer playwright.config.ts inside scriptDir, fall back to workspace root
  const configInScriptDir = path.join(scriptDir, 'playwright.config.ts');
  let configPath: string | null = null;
  try {
    await fs.access(configInScriptDir);
    configPath = configInScriptDir;
  } catch {
    const configInRoot = path.join(workspaceRoot, 'playwright.config.ts');
    try {
      await fs.access(configInRoot);
      configPath = configInRoot;
    } catch { /* no config found — playwright will use defaults */ }
  }

  // Check playwright is installed
  const installed = await isPlaywrightInstalled(workspaceRoot);
  if (!installed) {
    const msg = '⚠ Playwright not found in node_modules.\n'
      + 'Run this in your workspace terminal first:\n'
      + '  npm install -D @playwright/test && npx playwright install\n';
    onOutput?.(msg, 'stderr');
    const result: RunTestsResult = { exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 0, reportPath: null };
    onDone?.(result);
    return result;
  }

  // Build command args
  const args = ['playwright', 'test'];
  if (configPath) {
    args.push('--config', configPath);
  } else {
    // Point to the script directory as the test directory
    args.push(scriptDir);
  }
  args.push('--reporter=list');

  onOutput?.(`▶ Running: npx ${args.join(' ')}\n`, 'stdout');
  onOutput?.(`  Working dir: ${workspaceRoot}\n\n`, 'stdout');

  return new Promise(resolve => {
    const proc = spawn('npx', args, {
      cwd: workspaceRoot,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let allOutput = '';

    const handleData = (data: Buffer, kind: 'stdout' | 'stderr') => {
      const text = data.toString();
      allOutput += text;
      // Stream line by line
      text.split('\n').forEach(line => {
        if (line) { onOutput?.(line, kind); }
      });
    };

    proc.stdout.on('data', (d: Buffer) => handleData(d, 'stdout'));
    proc.stderr.on('data', (d: Buffer) => handleData(d, 'stderr'));

    // Handle cancellation
    token.onCancellationRequested(() => {
      proc.kill('SIGTERM');
      onOutput?.('\n⚠ Test run cancelled by user.', 'stderr');
    });

    proc.on('close', code => {
      const durationMs = Date.now() - startTime;
      const { passed, failed, skipped } = parseSummary(allOutput);
      const exitCode = code ?? 1;

      // Playwright generates an HTML report at playwright-report/index.html
      const reportPath = path.join(workspaceRoot, 'playwright-report', 'index.html');

      const result: RunTestsResult = { exitCode, passed, failed, skipped, durationMs, reportPath };

      const statusLine = exitCode === 0
        ? `\n✅ All tests passed — ${passed} passed in ${(durationMs / 1000).toFixed(1)}s`
        : `\n❌ ${failed} failed, ${passed} passed, ${skipped} skipped — exit code ${exitCode}`;
      onOutput?.(statusLine, 'stdout');

      onDone?.(result);
      resolve(result);
    });

    proc.on('error', err => {
      const msg = `\n❌ Failed to start Playwright: ${err.message}`;
      onOutput?.(msg, 'stderr');
      const result: RunTestsResult = { exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: Date.now() - startTime, reportPath: null };
      onDone?.(result);
      resolve(result);
    });
  });
}
