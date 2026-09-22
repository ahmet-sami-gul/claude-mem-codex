/**
 * The 'aux' process role (plan 3.4's process-registration decision).
 *
 * A Codex Telegram wrap-up spawns under a LIVE session's id — it has to, for
 * the jail directory and the audit attribution — but it is not that session's
 * generator. Registered as an ordinary 'sdk' record it is indistinguishable
 * from the generator's own exec, and handleGeneratorExit takes
 * getSdkProcessForSession's first match and SIGKILLs it after 5 s: a wrap-up
 * that overlaps a generator exit is either killed mid-flight or reaped in
 * place of the generator's real process, which then survives unreaped.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { ChildProcess } from 'child_process';
import {
  getProcessRegistry,
  getSdkProcessForSession,
  isSessionParkedForSlot,
  waitForSlot,
  type SlotReservation,
} from '../../src/supervisor/process-registry.js';
import { guardSharedProcessRegistrySingleton } from './process-registry-singleton-guard.js';

guardSharedProcessRegistrySingleton('process-registry-aux-role.test.ts');

const registry = getProcessRegistry();
const registeredIds: string[] = [];

function fakeChild(pid: number): ChildProcess {
  return { pid, killed: false, exitCode: null } as unknown as ChildProcess;
}

function registerFake(sessionDbId: number, pid: number, role?: 'aux'): string {
  const id = `sdk:${sessionDbId}:${pid}`;
  registry.register(id, {
    pid,
    type: 'sdk',
    sessionId: sessionDbId,
    startedAt: new Date().toISOString(),
    ...(role ? { role } : {}),
  }, fakeChild(pid));
  registeredIds.push(id);
  return id;
}

describe('process registry — the aux role', () => {
  afterEach(() => {
    while (registeredIds.length > 0) {
      const id = registeredIds.pop();
      if (id) registry.unregister(id);
    }
  });

  it('returns the session generator, never an aux process registered under it', () => {
    const sessionDbId = 920001;
    // The wrap-up registers FIRST, so a naive matches[0] would return it.
    registerFake(sessionDbId, 424242, 'aux');
    registerFake(sessionDbId, 434343);

    expect(getSdkProcessForSession(sessionDbId)?.pid).toBe(434343);
  });

  it('reports no generator when only an aux process is registered', () => {
    const sessionDbId = 920002;
    registerFake(sessionDbId, 454545, 'aux');

    // Nothing for a generator exit to reap: the wrap-up is not its process.
    expect(getSdkProcessForSession(sessionDbId)).toBeUndefined();
  });

  it('still counts an aux process against the concurrency limit', async () => {
    const sessionDbId = 920003;
    // A live pid: the slot scan only counts records whose process still exists.
    registerFake(sessionDbId, process.pid, 'aux');

    // Slot accounting is deliberately unchanged: an off-band exec costs a slot
    // like any other, it is just not mistaken for the session's generator.
    const controller = new AbortController();
    let acquired: SlotReservation | null = null;
    const parked = waitForSlot(1, controller.signal, 920004).then(
      (reservation: SlotReservation) => { acquired = reservation; return 'acquired'; },
      () => 'aborted',
    );
    await Promise.resolve();
    expect(isSessionParkedForSlot(920004)).toBe(true);

    controller.abort();
    expect(await parked).toBe('aborted');
    (acquired as SlotReservation | null)?.release();
  });
});
