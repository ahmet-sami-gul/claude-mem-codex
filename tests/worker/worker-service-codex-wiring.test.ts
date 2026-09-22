/**
 * The two production lines that connect the Codex provider to the worker
 * (M2 item 5). Both are single expressions with no other coverage: every
 * SessionRoutes test in the suite supplies its OWN fake codex agent
 * positionally, so deleting `this.codexAgent` from the real construction would
 * leave the whole suite green while every codex session and every codex
 * Telegram wrap-up raised observer_agent_missing in production.
 */

import { describe, it, expect, afterEach, beforeEach, spyOn } from 'bun:test';
import { Server } from '../../src/services/server/Server.js';
import type { RouteHandler } from '../../src/services/server/Server.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import * as providerDispatch from '../../src/services/worker/provider-dispatch.js';
import { WorkerService } from '../../src/services/worker-service.js';

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
});
