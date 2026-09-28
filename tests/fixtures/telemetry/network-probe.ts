/**
 * Subprocess probe for tests/telemetry/no-network-default.test.ts.
 *
 * Runs with plain `bun <file>` (NOT `bun test`), so the tests/preload.ts
 * posthog-node mock is NOT loaded: the real SDK is exercised. Every telemetry
 * transport sends through the global fetch (posthog-node's client calls
 * `fetch(url, options)` at send time; the CLI transport and the historical
 * backfill do the same), so fetch is replaced BEFORE any telemetry module is
 * imported and every call is recorded. node:http / node:https request entry
 * points are trapped too, so a transport that bypassed fetch would still be
 * counted. Nothing here can reach the network: the fake fetch answers locally
 * and the trapped http(s) calls throw.
 *
 * The probe drives every send path the worker and the CLI have — live events
 * (person and profile-less), a rolled-up buffer event, a manual $exception with
 * exception autocapture enabled, the CLI direct POST and the one-time
 * historical backfill over a database with pre-telemetry activity — then shuts
 * telemetry down (which flushes any queued client) and prints one line:
 *   PROBE_RESULT {"calls":[...urls]}
 *
 * The environment (consent, key, host, data dir) is set by the test.
 */
import http from 'node:http';
import https from 'node:https';
import { Database } from 'bun:sqlite';

const calls: string[] = [];

function describeTarget(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

globalThis.fetch = (async (input: unknown) => {
  calls.push(describeTarget(input));
  return new Response('{"status":1}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

for (const mod of [http, https] as Array<Record<string, unknown>>) {
  for (const name of ['request', 'get']) {
    mod[name] = (...args: unknown[]) => {
      calls.push(`node:${name} ${describeTarget(args[0])}`);
      throw new Error('network-probe: node http(s) requests are blocked');
    };
  }
}

const DAY_MS = 86_400_000;

function makeDbWithHistory(): Database {
  const db = new Database(':memory:');
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      started_at_epoch INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'other',
      agent_type TEXT,
      created_at_epoch INTEGER NOT NULL,
      discovery_tokens INTEGER DEFAULT 0
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      discovery_tokens INTEGER DEFAULT 0
    );
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT,
      prompt_number INTEGER,
      prompt_text TEXT,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  const epoch = Date.now() - 10 * DAY_MS;
  db.prepare(
    'INSERT INTO sdk_sessions (memory_session_id, project, platform_source, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)'
  ).run('mem-1', 'alpha', 'claude', epoch, 'completed');
  db.prepare(
    'INSERT INTO observations (memory_session_id, project, text, type, agent_type, created_at_epoch, discovery_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('mem-1', 'alpha', '', 'discovery', null, epoch, 100);
  return db;
}

const telemetry = await import('../../../src/services/telemetry/telemetry.ts');
const { telemetryBuffer } = await import('../../../src/services/telemetry/buffer.ts');
const { captureCliEvent } = await import('../../../src/services/telemetry/cli-telemetry.ts');
const { runHistoricalBackfill } = await import('../../../src/services/telemetry/backfill.ts');

telemetry.enableExceptionAutocaptureForWorker();
telemetry.captureEvent('worker_started', { trigger: 'start', provider: 'codex' }, { person: true });
telemetry.captureEvent('search_performed', { endpoint: 'by-file', outcome: 'ok', result_count: 1 });
telemetry.captureException(new Error('network probe failure'));
telemetryBuffer.record('session_compressed', 1, { outcome: 'ok', tokens_input: 10, tokens_output: 2 });
telemetryBuffer.flushSession(1, 'session_end');
await captureCliEvent('install_completed', { ide: 'claude-code', outcome: 'ok' }, { person: true });
await runHistoricalBackfill(makeDbWithHistory());
await telemetry.shutdownTelemetry();

process.stdout.write(`PROBE_RESULT ${JSON.stringify({ calls })}\n`);
process.exit(0);
