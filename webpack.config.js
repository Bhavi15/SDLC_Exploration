// @ts-check
'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const nodeConfig = {
  name: 'extension',
  target: 'node',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    clean: { keep: /^webview/ },
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      handlebars: path.resolve(__dirname, 'node_modules/handlebars/dist/cjs/handlebars.js'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }],
      },
    ],
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'src/prompts',
          to: 'prompts',
          filter: async (p) => p.endsWith('.md'),
        },
        { from: 'media', to: 'media' },
      ],
    }),
  ],
  devtool: 'source-map',
};

const webviewConfig = {
  name: 'webview',
  target: 'web',
  entry: './src/webview/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'webview.js',
    clean: false,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: path.resolve(__dirname, 'src/webview'),
        use: [
          {
            loader: 'ts-loader',
            options: { configFile: 'tsconfig.webview.json', transpileOnly: true },
          },
        ],
      },
    ],
  },
  devtool: 'source-map',
};

module.exports = [nodeConfig, webviewConfig];
