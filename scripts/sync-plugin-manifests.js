#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const codexPluginPath = path.join(rootDir, '.codex-plugin', 'plugin.json');
const bundledCodexPluginPath = path.join(rootDir, 'plugin', '.codex-plugin', 'plugin.json');
const claudePluginPath = path.join(rootDir, '.claude-plugin', 'plugin.json');
const bundledClaudePluginPath = path.join(rootDir, 'plugin', '.claude-plugin', 'plugin.json');
const cursorPluginPaths = [
  path.join(rootDir, 'claude-mem-cursor', '.cursor-plugin', 'plugin.json'),
  path.join(rootDir, 'claude-mem-grok-bot', '.cursor-plugin', 'plugin.json'),
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function syncCodexPlugin(plugin, pkg) {
  const author =
    typeof plugin.author === 'object' && plugin.author ? plugin.author : {};

  return {
    ...plugin,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    homepage: pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    keywords: pkg.keywords,
    author: {
      ...author,
      name: normalizeAuthorName(pkg.author),
    },
    interface: {
      ...plugin.interface,
      developerName: normalizeAuthorName(pkg.author),
      websiteURL: normalizeRepositoryUrl(pkg.repository),
    },
  };
}

// claude-mem-codex fork: the bundled Codex manifest also takes its presentation
// fields (author URL, display name, short and long description) from the root
// .codex-plugin/plugin.json, so the root file is their single source and a
// rebuild cannot leave upstream's values in plugin/.codex-plugin/plugin.json.
function syncBundledCodexPlugin(plugin, rootPlugin, pkg) {
  const synced = syncCodexPlugin(plugin, pkg);
  const rootAuthor =
    typeof rootPlugin.author === 'object' && rootPlugin.author ? rootPlugin.author : {};
  const rootInterface =
    typeof rootPlugin.interface === 'object' && rootPlugin.interface ? rootPlugin.interface : {};
  const presentation = {};
  for (const key of ['displayName', 'shortDescription', 'longDescription']) {
    if (typeof rootInterface[key] === 'string') presentation[key] = rootInterface[key];
  }

  return {
    ...synced,
    author: {
      ...synced.author,
      ...(typeof rootAuthor.url === 'string' ? { url: rootAuthor.url } : {}),
    },
    interface: {
      ...synced.interface,
      ...presentation,
    },
  };
}

function syncClaudePlugin(plugin, pkg) {
  return {
    ...plugin,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    homepage: pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    keywords: pkg.keywords,
    author: {
      ...(typeof plugin.author === 'object' && plugin.author ? plugin.author : {}),
      name: normalizeAuthorName(pkg.author),
    },
  };
}

function normalizeAuthorName(author) {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && typeof author.name === 'string') return author.name;
  return '';
}

function syncCursorPlugin(plugin, pkg) {
  return {
    ...plugin,
    version: pkg.version,
    description: plugin.description ?? pkg.description,
    homepage: plugin.homepage ?? pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    author: {
      ...(typeof plugin.author === 'object' && plugin.author ? plugin.author : {}),
      name: normalizeAuthorName(pkg.author),
    },
  };
}

function normalizeRepositoryUrl(repository) {
  if (typeof repository === 'string') return repository.replace(/\.git$/, '');
  if (repository && typeof repository === 'object' && typeof repository.url === 'string')
    return repository.url.replace(/\.git$/, '');
  return '';
}

function main() {
  for (const filePath of [packageJsonPath, codexPluginPath, bundledCodexPluginPath, claudePluginPath, bundledClaudePluginPath, ...cursorPluginPaths]) {
    if (!fs.existsSync(filePath)) {
      console.error(`Missing required file: ${filePath}`);
      process.exit(1);
    }
  }

  const pkg = readJson(packageJsonPath);
  const codexPlugin = readJson(codexPluginPath);
  const bundledCodexPlugin = readJson(bundledCodexPluginPath);
  const claudePlugin = readJson(claudePluginPath);
  const bundledClaudePlugin = readJson(bundledClaudePluginPath);
  const cursorPlugins = cursorPluginPaths.map(readJson);

  writeJson(codexPluginPath, syncCodexPlugin(codexPlugin, pkg));
  writeJson(bundledCodexPluginPath, syncBundledCodexPlugin(bundledCodexPlugin, codexPlugin, pkg));
  writeJson(claudePluginPath, syncClaudePlugin(claudePlugin, pkg));
  writeJson(bundledClaudePluginPath, syncClaudePlugin(bundledClaudePlugin, pkg));
  cursorPluginPaths.forEach((filePath, index) => writeJson(filePath, syncCursorPlugin(cursorPlugins[index], pkg)));

  console.log('✓ Synced plugin manifests from package.json');
}

main();
