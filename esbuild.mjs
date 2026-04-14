import * as esbuild from 'esbuild';
import { cpSync } from 'fs';

const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: isDev ? true : 'linked',
  minify: !isDev,
  alias: {
    handlebars: 'handlebars/dist/cjs/handlebars.js',
  },
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/frontend/client/main.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  sourcemap: isDev ? true : 'linked',
  minify: !isDev,
};

// Copy static assets (replaces CopyWebpackPlugin)
cpSync('src/prompts', 'dist/prompts', { recursive: true });
cpSync('media', 'dist/media', { recursive: true });

if (isWatch) {
  const [extCtx, webCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log('[esbuild] watching...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
  console.log('[esbuild] build complete');
}
