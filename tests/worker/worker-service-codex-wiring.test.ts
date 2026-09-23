/**
 * The two production lines that connect the Codex provider to the worker
 * (M2 item 5). Both are single expressions with no other coverage: every
 * SessionRoutes test in the suite supplies its OWN fake codex agent
 * positionally, so deleting `this.codexAgent` from the real construction would
 * leave the whole suite green while every codex session and every codex
 * Telegram wrap-up raised observer_agent_missing in production.
 */

import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { Server } from '../../src/services/server/Server.js';
import type { RouteHandler } from '../../src/services/server/Server.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import * as providerDispatch from '../../src/services/worker/provider-dispatch.js';
import { WorkerService } from '../../src/services/worker-service.js';
import * as supervisorIndex from '../../src/supervisor/index.js';
import * as orphanReaper from '../../src/supervisor/codex-orphan-reaper.js';
import * as codexMetricsModule from '../../src/services/worker/codex/codex-metrics.js';
import * as telemetry from '../../src/services/telemetry/telemetry.js';
import * as workerShutdown from '../../src/services/worker-shutdown.js';
import { DATA_DIR } from '../../src/shared/paths.js';
import { logger } from '../../src/utils/logger.js';

describe('WorkerService — Codex wiring', () => {
  let spies: ReturnType<typeof spyOn>[] = [];
  let handlers: RouteHandler[];
  let worker: WorkerService;

  beforeEach(() => {
    handlers = [];
    const register = spyOn(Server.prototype, 'registerRoutes').mockImplementation(function (
      this: Server,
      handler: RouteHandler,
    ) {
      handlers.push(handler);
    });
    spies = [register];
    worker = new WorkerService();
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    spies = [];
  });

  function sessionRoutes(): SessionRoutes {
    const found = handlers.find(handler => handler instanceof SessionRoutes);
    expect(found).toBeDefined();
    return found as SessionRoutes;
  }

  function codexAgentOf(routes: SessionRoutes): unknown {
    return (routes as unknown as { codexAgent?: unknown }).codexAgent;
  }

  it('hands SessionRoutes the CodexProvider it built', () => {
    const routes = sessionRoutes();

    expect(codexAgentOf(routes)).toBeInstanceOf(CodexProvider);
    // The same instance, not a second one: the provider caches its lockdown
    // self-check state, so two instances would verify the binary twice.
    expect(codexAgentOf(routes)).toBe((worker as unknown as { codexAgent: CodexProvider }).codexAgent);
  });

  it('reports the codex auth method from the codex agent, including while it verifies', () => {
    const getAiStatus = (worker as unknown as {
      server: { options: { getAiStatus: () => { provider: string; authMethod: string } } };
    }).server.options.getAiStatus;

    const codexAgent = (worker as unknown as { codexAgent: CodexProvider }).codexAgent;
    const describe_ = spyOn(codexAgent, 'getAuthMethodDescription')
      .mockReturnValue('Codex CLI (verifying ChatGPT login)');
    const selected = spyOn(providerDispatch, 'getSelectedProvider').mockReturnValue('codex');
    spies.push(describe_, selected);

    expect(getAiStatus()).toMatchObject({
      provider: 'codex',
      // Never getAuthMethodDescription()'s Anthropic identities: codex
      // authenticates through its own CLI login, and only the lockdown
      // self-check knows whether that login is the required ChatGPT one.
      authMethod: 'Codex CLI (verifying ChatGPT login)',
    });
    expect(describe_).toHaveBeenCalled();
  });

  it('exposes the codex exec budget and usage counters on /api/health ai status (M4)', () => {
    const getAiStatus = (worker as unknown as {
      server: { options: { getAiStatus: () => Record<string, unknown> } };
    }).server.options.getAiStatus;
    const codexAgent = (worker as unknown as { codexAgent: CodexProvider }).codexAgent;
    spies.push(
      spyOn(codexAgent, 'getAuthMethodDescription').mockReturnValue('Codex CLI (ChatGPT login)'),
      spyOn(providerDispatch, 'getSelectedProvider').mockReturnValue('codex'),
    );

    const status = getAiStatus() as { codex?: { budget: Record<string, unknown>; metrics: Record<string, unknown> } };

    expect(status.codex).toBeDefined();
    // The real provider's snapshot, straight through: the budget window and
    // the counters, numbers and timestamps only.
    expect(status.codex!.budget).toMatchObject({ windowMs: 5 * 60 * 60 * 1000 });
    expect(typeof status.codex!.budget.used).toBe('number');
    expect(status.codex!.metrics).toMatchObject({
      calls: expect.any(Object),
      skipped: expect.any(Object),
      observations: expect.any(Object),
      tokens: expect.any(Object),
    });
    expect(typeof status.codex!.metrics.budgetRefusals).toBe('number');
    expect(typeof status.codex!.metrics.toolAttempts).toBe('number');
  });

  it('adds no codex block for the other providers', () => {
    const getAiStatus = (worker as unknown as {
      server: { options: { getAiStatus: () => Record<string, unknown> } };
    }).server.options.getAiStatus;
    const codexAgent = (worker as unknown as { codexAgent: CodexProvider }).codexAgent;
    const usage = spyOn(codexAgent, 'getUsageStatus');
    spies.push(usage, spyOn(providerDispatch, 'getSelectedProvider').mockReturnValue('openrouter'));

    expect(getAiStatus()).not.toHaveProperty('codex');
    expect(usage).not.toHaveBeenCalled();
  });

  it('leaves the other providers on the Anthropic auth description', () => {
    const getAiStatus = (worker as unknown as {
      server: { options: { getAiStatus: () => { provider: string; authMethod: string } } };
    }).server.options.getAiStatus;

    const codexAgent = (worker as unknown as { codexAgent: CodexProvider }).codexAgent;
    const describe_ = spyOn(codexAgent, 'getAuthMethodDescription').mockReturnValue('Codex CLI (ChatGPT login)');
    const selected = spyOn(providerDispatch, 'getSelectedProvider').mockReturnValue('claude');
    spies.push(describe_, selected);

    const status = getAiStatus();
    expect(status.provider).toBe('claude');
    expect(status.authMethod).not.toContain('Codex');
    expect(describe_).not.toHaveBeenCalled();
  });
  it('boots the codex housekeeping right after the supervisor, and shutdown undoes it (M4)', async () => {
    const worker_ = worker as unknown as {
      codexAgent: CodexProvider;
      start(): Promise<void>;
      shutdown(reason?: string): Promise<void>;
    };
    const codexAgent = worker_.codexAgent;
    const order: string[] = [];
    const reapCalls: Array<Parameters<typeof orphanReaper.reapOrphanedCodexExecs>[0]> = [];
    const reporter = { stop: mock(() => {}), report: mock(() => false) };
    const stopHere = new Error('start() stopped at listen by the test');
    spies.push(
      spyOn(telemetry, 'enableExceptionAutocaptureForWorker').mockImplementation(() => {}),
      spyOn(logger, 'setErrorSink').mockImplementation(() => {}),
      spyOn(supervisorIndex, 'startSupervisor').mockImplementation(async () => { order.push('supervisor'); }),
      spyOn(orphanReaper, 'reapOrphanedCodexExecs').mockImplementation(async (options) => {
        order.push('reap');
        reapCalls.push(options);
        return {
          candidates: 0, matched: 0, interrupted: 0, killed: 0, exited: 0, unregistered: 0, skipped: {}, skippedAll: null,
        };
      }),
      spyOn(codexMetricsModule, 'startCodexMetricsReporter').mockImplementation(() => {
        order.push('reporter');
        return reporter;
      }),
      spyOn(Server.prototype, 'listen').mockImplementation(async () => {
        order.push('listen');
        throw stopHere;
      }),
      spyOn(codexAgent, 'resolvedBinaryPath').mockReturnValue('/opt/codex/bin/codex'),
    );

    await expect(worker_.start()).rejects.toBe(stopHere);

    // Once, after the supervisor loaded the registry and before the worker
    // can serve (and so spawn) anything.
    expect(order).toEqual(['supervisor', 'reap', 'reporter', 'listen']);
    expect(reapCalls).toHaveLength(1);
    const resolve = reapCalls[0]!.executablePath;
    expect(typeof resolve).toBe('function');
    // The binary is the codex agent's own resolution, asked lazily.
    expect((resolve as () => string | null)()).toBe('/opt/codex/bin/codex');

    // Shutdown: capture the sequence rather than running it, then run the
    // step that tears the worker's own state down.
    let sequence: Parameters<typeof workerShutdown.runShutdownSequence>[0] | null = null;
    const flushUsage = spyOn(codexAgent, 'flushUsage').mockImplementation(() => {});
    spies.push(
      flushUsage,
      spyOn(workerShutdown, 'runShutdownSequence').mockImplementation(async (options) => { sequence = options; }),
      spyOn(telemetry, 'captureEvent').mockImplementation(() => {}),
      spyOn(telemetry, 'shutdownTelemetry').mockImplementation(async () => {}),
    );
    try {
      await worker_.shutdown('stop');
      expect(sequence).not.toBeNull();
      await sequence!.beforeGracefulShutdown();

      expect(reporter.stop).toHaveBeenCalledTimes(1);
      expect(flushUsage).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(join(DATA_DIR, '.worker-clean-shutdown'), { force: true });
    }
  });
});
