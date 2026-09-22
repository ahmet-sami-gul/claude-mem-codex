#!/usr/bin/env node
/**
 * Spawn-env discipline CI check (plan 06 — worker env isolation).
 *
 * Every subprocess spawn that hands an env block to its child MUST sanitize
 * that env with sanitizeEnv(...) before passing it (and, for SDK/credential
 * paths, buildIsolatedEnv*). Handing raw `process.env` to a child lets host
 * CLI bleed-through (CLAUDE_CODE_EFFORT_LEVEL → #2357) and stray Anthropic
 * credentials (ANTHROPIC_BASE_URL → #2375) leak into the subprocess.
 *
 * Rule: any spawn(...) / spawnSync(...) / spawnHidden(...) call whose argument
 * window passes an `env:` option referencing `process.env` MUST also reference
 * `sanitizeEnv` within the same window. Spawns that omit `env:` (inherit the
 * parent env implicitly — e.g. install-time `git`/`npm`/`bun --version`) are
 * out of scope: they are not the credential-bearing worker/SDK boundary and
 * the parent shell is their trust boundary.
 *
 * Codex observer rules (plan 3.10, CODEX-SAGLAYICI-PLANI.md):
 *   - codex-spawn-env: inside src/services/worker/codex/ EVERY spawn site
 *     (spawn, spawnSync, spawnHidden, spawnSdkProcess, execFile,
 *     execFileSync, fork, and exec/execSync whether bare or as a member call
 *     on a non-regex receiver) must build its env with
 *     buildCodexObserverEnv(sanitizeEnv(...)) within the same window, whether
 *     or not it passes `env:` (an env-less spawn would inherit the worker env,
 *     including CODEX_API_KEY / OPENAI_BASE_URL).
 *   - codex-callee-env: the same requirement, anchored on the CALLEE instead
 *     of the directory, for every other file under src/: a spawn window naming
 *     the codex binary (findCodexExecutable, buildCodexExecArgs,
 *     buildCodexProbeArgs, CLAUDE_MEM_CODEX_PATH, a codex* command variable)
 *     must contain buildCodexObserverEnv. CodexCliInstaller.ts is exempt: it
 *     is claude-mem's Codex HOST integration, not the observer boundary.
 *   - codex-forbidden-arg: the strings --dangerously-bypass-approvals-and-sandbox,
 *     --dangerously-bypass-hook-trust, danger-full-access, '--last' (quoted)
 *     and --add-dir may appear only in src/services/worker/codex/codex-invocation.ts
 *     (where they are listed as forbidden). Checked on raw text (comments
 *     included) across src/ and scripts/ (this file excluded).
 *
 * Pure CJS (no compile step) so it can run before tsc. Exposes findViolations
 * (all rules) plus the codex helpers for the bun test in
 * tests/env-isolation.test.ts; exits non-zero with file:line on any violation
 * when run directly.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

// Repo-relative, forward slashes.
const CODEX_DIR_PREFIX = 'src/services/worker/codex/';
const CODEX_INVOCATION_FILE = 'src/services/worker/codex/codex-invocation.ts';
const SELF_FILE = 'scripts/check-spawn-env-discipline.cjs';

// Every process-starting call in the codex dir, bare or as a member call
// (`cp.execSync(...)`, `require('child_process').exec(...)`).
const CODEX_SPAWN_RE =
  /(?:\b(?:spawn|spawnSync|spawnHidden|spawnSdkProcess|execFile|execFileSync|fork)|(?:^|[^.\w$])(?:exec|execSync))\s*\(/;

// `x.exec(` / `x.execSync(` — a spawn site unless the receiver is a regex.
// Excluding EVERY member call (the old rule) let `cp.execSync(cmd)` through.
const CODEX_MEMBER_EXEC_RE = /\.\s*(?:exec|execSync)\s*\(/g;
const REGEX_RECEIVER_RE = /(?:RE|_REGEX|REGEX|RegExp|Regexp|Regex|regex|Pattern|pattern|[Rr]e)$|\/[gimsuy]*$/;

/**
 * Callee-anchored rule: ANY spawn in src/ that starts the codex binary must
 * build its env with buildCodexObserverEnv, not only the ones under
 * src/services/worker/codex/. M2/M3 wire codex into dependency-health.ts,
 * provider-dispatch.ts, worker-service.ts and SessionRoutes.ts, none of which
 * are under that prefix; an env-less `codex --version` probe written there
 * would inherit CODEX_API_KEY / OPENAI_BASE_URL from the worker.
 */
const CODEX_CALLEE_RE =
  /\b(?:findCodexExecutable|buildCodexExecArgs|buildCodexProbeArgs|assertCodexArgvSafe|codexBinaryPath|codexBinary|codexPath|codexCommand|CLAUDE_MEM_CODEX_PATH)\b/;

// claude-mem's Codex HOST integration (plugin install/marketplace), a separate
// trust boundary from the observer provider; the plan leaves it untouched.
const CODEX_CALLEE_EXEMPT_FILES = new Set(['src/services/integrations/CodexCliInstaller.ts']);

const CODEX_FORBIDDEN_STRINGS = [
  { label: '--dangerously-bypass-approvals-and-sandbox', re: /--dangerously-bypass-approvals-and-sandbox/ },
  { label: '--dangerously-bypass-hook-trust', re: /--dangerously-bypass-hook-trust/ },
  { label: 'danger-full-access', re: /danger-full-access/ },
  { label: "'--last'", re: /(['"`])--last\1/ },
  { label: '--add-dir', re: /--add-dir/ },
];

// How many lines after a spawn match to inspect for the env: option.
const WINDOW_LINES = 10;

const SPAWN_RE = /\b(spawn|spawnSync|spawnHidden)\s*\(/;

/** Strip // line comments and block comments so doc mentions don't trip. */
function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  return out;
}

function walk(dir) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...walk(full));
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function walkScripts(dir) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...walkScripts(full));
    } else if (entry.isFile() && /\.(?:c|m)?[jt]s$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function toRepoRelative(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * Spawn sites in a codex-dir source text, each with whether its window builds
 * the env with buildCodexObserverEnv(sanitizeEnv(...)).
 */
function hasMemberExecSpawn(line) {
  CODEX_MEMBER_EXEC_RE.lastIndex = 0;
  let match;
  while ((match = CODEX_MEMBER_EXEC_RE.exec(line)) !== null) {
    const receiver = line.slice(0, match.index).trimEnd();
    if (!REGEX_RECEIVER_RE.test(receiver)) return true;
  }
  return false;
}

function isSpawnLine(line) {
  return CODEX_SPAWN_RE.test(line) || hasMemberExecSpawn(line);
}

function codexSpawnSitesInSource(source) {
  const lines = stripComments(source).split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    if (!isSpawnLine(line)) return;
    const window = lines.slice(i, i + WINDOW_LINES).join('\n');
    const ok = /buildCodexObserverEnv\s*\(/.test(window) && /sanitizeEnv\s*\(/.test(window);
    sites.push({ line: i + 1, ok });
  });
  return sites;
}

/**
 * Spawn sites ANYWHERE in src/ whose argument window names the codex binary
 * but does not build the env with buildCodexObserverEnv.
 */
function codexCalleeSitesInSource(relPath, source) {
  if (CODEX_CALLEE_EXEMPT_FILES.has(relPath)) return [];
  const lines = stripComments(source).split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    if (!isSpawnLine(line)) return;
    const window = lines.slice(i, i + WINDOW_LINES).join('\n');
    if (!CODEX_CALLEE_RE.test(window)) return;
    if (/buildCodexObserverEnv\s*\(/.test(window)) return;
    sites.push({ line: i + 1 });
  });
  return sites;
}

/**
 * Codex-rule violations for one file. `relPath` is repo-relative with forward
 * slashes; exported so tests can feed synthetic sources.
 */
function checkCodexSource(relPath, source) {
  const violations = [];
  if (relPath.startsWith(CODEX_DIR_PREFIX)) {
    for (const site of codexSpawnSitesInSource(source)) {
      if (!site.ok) {
        violations.push({ file: relPath, line: site.line, rule: 'codex-spawn-env' });
      }
    }
  } else {
    for (const site of codexCalleeSitesInSource(relPath, source)) {
      violations.push({ file: relPath, line: site.line, rule: 'codex-callee-env' });
    }
  }
  if (relPath !== CODEX_INVOCATION_FILE && relPath !== SELF_FILE) {
    source.split('\n').forEach((line, i) => {
      for (const forbidden of CODEX_FORBIDDEN_STRINGS) {
        if (forbidden.re.test(line)) {
          violations.push({ file: relPath, line: i + 1, rule: 'codex-forbidden-arg', detail: forbidden.label });
        }
      }
    });
  }
  return violations;
}

/** Codex spawn sites across the real codex dir (for tests asserting the rule is not vacuous). */
function findCodexSpawnSites() {
  const sites = [];
  for (const file of walk(path.join(REPO_ROOT, CODEX_DIR_PREFIX))) {
    const relPath = toRepoRelative(file);
    for (const site of codexSpawnSitesInSource(fs.readFileSync(file, 'utf-8'))) {
      sites.push({ file: relPath, line: site.line, ok: site.ok });
    }
  }
  return sites;
}

function findCodexViolations() {
  const violations = [];
  const files = [...walk(SRC_DIR), ...walkScripts(SCRIPTS_DIR)];
  for (const file of files) {
    violations.push(...checkCodexSource(toRepoRelative(file), fs.readFileSync(file, 'utf-8')));
  }
  return violations;
}

function findViolations() {
  const violations = [];
  for (const file of walk(SRC_DIR)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const stripped = stripComments(raw);
    const lines = stripped.split('\n');

    lines.forEach((line, i) => {
      if (!SPAWN_RE.test(line)) return;

      // Inspect the spawn call's argument window.
      const window = lines.slice(i, i + WINDOW_LINES).join('\n');

      // Only spawns that pass an explicit env block built from process.env are
      // in scope. Implicit-inherit spawns (no env:) are out of scope.
      const passesEnvOption = /env\s*:/.test(window);
      const referencesProcessEnv = /process\s*\.\s*env/.test(window);
      if (!passesEnvOption || !referencesProcessEnv) return;

      // The env block must be sanitized.
      if (!/sanitizeEnv\s*\(/.test(window)) {
        violations.push({
          file: path.relative(REPO_ROOT, file),
          line: i + 1,
          rule: 'sanitize-env',
        });
      }
    });
  }
  violations.push(...findCodexViolations());
  return violations;
}

function run() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('spawn-env discipline: OK (all env-bearing spawns sanitize process.env; codex spawns use buildCodexObserverEnv; no forbidden codex args)');
    return 0;
  }
  console.error('spawn-env discipline VIOLATIONS:');
  for (const v of violations) {
    if (v.rule === 'codex-spawn-env') {
      console.error(`  ${v.file}:${v.line}  codex spawn must pass env: buildCodexObserverEnv(sanitizeEnv(process.env), ...)`);
    } else if (v.rule === 'codex-callee-env') {
      console.error(`  ${v.file}:${v.line}  spawn of the codex binary must pass env: buildCodexObserverEnv(sanitizeEnv(process.env), ...)`);
    } else if (v.rule === 'codex-forbidden-arg') {
      console.error(`  ${v.file}:${v.line}  forbidden codex argument ${v.detail} outside codex-invocation.ts`);
    } else {
      console.error(`  ${v.file}:${v.line}  spawn passes raw process.env without sanitizeEnv`);
    }
  }
  return 1;
}

module.exports = {
  findViolations,
  findCodexViolations,
  findCodexSpawnSites,
  checkCodexSource,
  codexCalleeSitesInSource,
};

if (require.main === module) {
  process.exit(run());
}
