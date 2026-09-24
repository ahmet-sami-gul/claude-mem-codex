import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CodexJsonlParser,
  parseCodexJsonl,
  classifyCodexJsonlLine,
  parseCodexUsage,
  stripCodexStdinNotice,
  appendCodexStderrTail,
  CODEX_ITEM_EXCERPT_CHARS,
  CODEX_LABEL_MAX_CHARS,
  safeCodexLabel,
  CODEX_STDERR_TAIL_BYTES,
  CODEX_STDIN_NOTICE,
} from '../../../src/services/worker/codex/codex-jsonl.js';
import { parseAgentXml } from '../../../src/sdk/parser.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'codex');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('Phase 0 success captures', () => {
  it('parses the trivial locked exec (p0_1) exactly', () => {
    const summary = parseCodexJsonl(fixture('p0-success-trivial.jsonl'));
    expect(summary.threadId).toBe('00000000-0000-4000-8000-000000000001');
    expect(summary.content).toBe('<ok/>');
    expect(summary.agentMessages).toEqual(['<ok/>']);
    expect(summary.agentMessageCount).toBe(1);
    expect(summary.usage).toEqual({ input: 5570, cached: 4864, output: 7, reasoning: 0 });
    expect(summary.turnCompleted).toBe(true);
    expect(summary.failureMessage).toBeNull();
    expect(summary.nonFatalErrors).toEqual([]);
    expect(summary.toolAttempts).toEqual([]);
    expect(summary.malformedLines).toBe(0);
    expect(summary.unknownEvents).toBe(0);
    expect(summary.truncated).toBe(false);
  });

  it('parses the realistic observer exec (p0_4) and its message is valid observation XML', () => {
    const summary = parseCodexJsonl(fixture('p0-success-observation.jsonl'));
    expect(summary.usage).toEqual({ input: 56497, cached: 4864, output: 326, reasoning: 28 });
    expect(summary.content.startsWith('<observation>')).toBe(true);
    expect(summary.content.endsWith('</observation>')).toBe(true);
    ModeManager.getInstance().loadMode('code');
    const parsed = parseAgentXml(summary.content, 'codex-jsonl-test');
    expect(parsed.valid).toBe(true);
    expect(parsed.observations.length).toBe(1);
    expect(parsed.observations[0].type).toBe('discovery');
  });
});

describe('codex-cli 0.156.1 canary capture', () => {
  it('treats the code-mode fail-closed notice as info and ignores cache_write_input_tokens', () => {
    const summary = parseCodexJsonl(fixture('v0156-success-observation.jsonl'));
    expect(summary.nonFatalErrors).toHaveLength(1);
    expect(summary.nonFatalErrors[0]).toStartWith('Code Mode is unavailable because code-mode host is disabled.');
    expect(summary.failureMessage).toBeNull();
    expect(summary.toolAttempts).toEqual([]);
    expect(summary.agentMessageCount).toBe(1);
    expect(summary.content.startsWith('<observation>')).toBe(true);
    expect(summary.usage).toEqual({ input: 7234, cached: 0, output: 174, reasoning: 10 });
    expect(summary.turnCompleted).toBe(true);
    expect(summary.unknownEvents).toBe(0);
    expect(summary.malformedLines).toBe(0);
  });
});

describe('single-answer rule', () => {
  it('keeps only the LAST agent_message as the content and exposes the count', () => {
    const summary = parseCodexJsonl(fixture('synthetic-multiple-agent-messages.jsonl'));
    expect(summary.agentMessages).toEqual(['Before I continue, what is your password?', '<ok/>']);
    expect(summary.agentMessageCount).toBe(2);
    expect(summary.content).toBe('<ok/>');
    expect(summary.toolAttempts).toEqual([]);
    expect(summary.turnCompleted).toBe(true);
  });

  it('is byte-for-byte unchanged for one message, and empty for none', () => {
    const text = '  <observation>\n  keeps surrounding whitespace\n</observation>\n';
    const one = parseCodexJsonl(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
    expect(one.content).toBe(text);
    expect(one.agentMessageCount).toBe(1);
    const none = parseCodexJsonl('{"type":"turn.completed"}\n');
    expect(none.content).toBe('');
    expect(none.agentMessageCount).toBe(0);
    const three = parseCodexJsonl(['a', 'b', ''].map((t) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: t } })).join('\n'));
    expect(three.agentMessageCount).toBe(3);
    expect(three.content).toBe('');
  });
});

describe('synthetic streams', () => {
  it('treats Reconnecting... n/m as info and still succeeds', () => {
    const summary = parseCodexJsonl(fixture('synthetic-reconnect-then-success.jsonl'));
    expect(summary.content).toBe('<ok/>');
    expect(summary.turnCompleted).toBe(true);
    expect(summary.failureMessage).toBeNull();
    expect(summary.errorCandidate).toBeNull();
    expect(summary.nonFatalErrors.length).toBe(2);
    expect(summary.nonFatalErrors.every((message) => message.startsWith('Reconnecting... '))).toBe(true);
    expect(summary.unknownEvents).toBe(1); // the _fixture.note marker line
  });

  it('keeps the turn.failed message as the failure and the top-level error as candidate', () => {
    const summary = parseCodexJsonl(fixture('synthetic-usage-limit-same-day.jsonl'));
    expect(summary.turnCompleted).toBe(false);
    expect(summary.turnFailedMessage).toContain("You've hit your usage limit");
    expect(summary.errorCandidate).toContain('try again at 3:45 PM');
    expect(summary.failureMessage).toBe(summary.turnFailedMessage);
    expect(summary.content).toBe('');
  });

  it('flags command_execution as a tool attempt on item.started, with a bounded excerpt', () => {
    const parser = new CodexJsonlParser();
    const events = parser.push(fixture('synthetic-tool-attempt-command.jsonl'));
    const firstAttempt = events.find((event) => event.kind === 'tool_attempt');
    expect(firstAttempt).toBeDefined();
    if (firstAttempt?.kind !== 'tool_attempt') throw new Error('unreachable');
    expect(firstAttempt.attempt.eventType).toBe('item.started');
    expect(firstAttempt.attempt.itemType).toBe('command_execution');
    expect(firstAttempt.attempt.itemId).toBe('item_0');
    expect(firstAttempt.attempt.toolName).toBe('command_execution ls -la');
    expect(firstAttempt.attempt.toolInput).not.toContain('aggregated_output');
    const summary = parser.summary();
    expect(summary.toolAttempts.length).toBe(2);
    // The parser still records the message; the runner discards it on a tool attempt.
    expect(summary.agentMessages.length).toBe(1);
  });

  it('audits todo_list without treating it as a tool attempt', () => {
    const summary = parseCodexJsonl(fixture('synthetic-todo-list.jsonl'));
    expect(summary.toolAttempts).toEqual([]);
    expect(summary.todoObservations.length).toBe(2);
    expect(summary.todoObservations[0].eventType).toBe('item.started');
    expect(summary.todoObservations[0].summary).toContain('Summarize the observed tool call');
    expect(summary.content).toBe('<ok/>');
  });

  it('treats an error item as info only', () => {
    const summary = parseCodexJsonl(fixture('synthetic-error-item.jsonl'));
    expect(summary.nonFatalErrors).toEqual(['reasoning summary is not supported for this model; continuing without it']);
    expect(summary.failureMessage).toBeNull();
    expect(summary.toolAttempts).toEqual([]);
    expect(summary.content).toBe('<ok/>');
  });

  it('counts and ignores malformed lines, unknown events and unknown fields', () => {
    const summary = parseCodexJsonl(fixture('synthetic-malformed-lines.jsonl'));
    expect(summary.malformedLines).toBe(3); // plain text, JSON array, object without type
    expect(summary.unknownEvents).toBe(2); // _fixture.note + future.event
    expect(summary.usage).toEqual({ input: 5570, cached: 4864, output: 9, reasoning: 2 });
    expect(summary.content).toBe('<ok/>');
    expect(summary.toolAttempts).toEqual([]);
  });

  it('reports turn.completed without an agent_message', () => {
    const summary = parseCodexJsonl(fixture('synthetic-no-agent-message.jsonl'));
    expect(summary.turnCompleted).toBe(true);
    expect(summary.content).toBe('');
    expect(summary.usage?.output).toBe(12);
  });

  it('reports a stream that ended before turn.completed', () => {
    const summary = parseCodexJsonl(fixture('synthetic-no-turn-completed.jsonl'));
    expect(summary.turnCompleted).toBe(false);
    expect(summary.usage).toBeNull();
    expect(summary.failureMessage).toBeNull();
  });
});

describe('classifyCodexJsonlLine: item allowlist', () => {
  const line = (event: unknown) => JSON.stringify(event);

  it('flags every non-allowlisted item type as a tool attempt on any item.* event', () => {
    const cases: Array<[unknown, string]> = [
      [{ type: 'item.started', item: { id: 'a', type: 'file_change', changes: [{ path: 'src/x.ts', kind: 'update' }] } }, 'file_change src/x.ts'],
      [{ type: 'item.updated', item: { id: 'b', type: 'mcp_tool_call', server: 'gmail', tool: 'send', arguments: {} } }, 'mcp_tool_call gmail send'],
      [{ type: 'item.completed', item: { id: 'c', type: 'web_search', query: 'secrets' } }, 'web_search secrets'],
      [{ type: 'item.started', item: { id: 'd', type: 'collab_tool_call', tool: 'spawn' } }, 'collab_tool_call spawn'],
      [{ type: 'item.started', item: { id: 'e', type: 'view_image', path: '/etc/passwd' } }, 'view_image'],
      [{ type: 'item.started', item: { id: 'f', type: 'brand_new_tool' } }, 'brand_new_tool'],
      [{ type: 'item.started', item: { id: 'g' } }, 'unknown'],
      [{ type: 'item.started' }, 'unknown'],
    ];
    for (const [event, toolName] of cases) {
      const classified = classifyCodexJsonlLine(line(event));
      expect(classified.kind).toBe('tool_attempt');
      if (classified.kind === 'tool_attempt') expect(classified.attempt.toolName).toBe(toolName);
    }
  });

  it('collects agent_message text only from item.completed', () => {
    expect(classifyCodexJsonlLine(line({ type: 'item.started', item: { type: 'agent_message', text: 'partial' } })).kind).toBe('allowed_item');
    expect(classifyCodexJsonlLine(line({ type: 'item.updated', item: { type: 'agent_message', text: 'partial' } })).kind).toBe('allowed_item');
    const done = classifyCodexJsonlLine(line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'final' } }));
    expect(done).toEqual({ kind: 'agent_message', text: 'final', itemId: 'm' });
  });

  it('allows reasoning items on every event', () => {
    for (const type of ['item.started', 'item.updated', 'item.completed']) {
      expect(classifyCodexJsonlLine(line({ type, item: { type: 'reasoning', text: '' } })).kind).toBe('allowed_item');
    }
  });

  it('bounds tool-attempt excerpts', () => {
    const huge = 'x'.repeat(10_000);
    const classified = classifyCodexJsonlLine(line({ type: 'item.started', item: { type: 'command_execution', command: huge } }));
    if (classified.kind !== 'tool_attempt') throw new Error('expected tool attempt');
    expect(classified.attempt.toolInput.length).toBeLessThanOrEqual(CODEX_ITEM_EXCERPT_CHARS + 20);
    expect(classified.attempt.toolName.length).toBeLessThan(200);
  });

  it('handles top-level error and turn.failed variants', () => {
    expect(classifyCodexJsonlLine(line({ type: 'error', message: 'Reconnecting... 3/5' }))).toEqual({ kind: 'reconnecting', message: 'Reconnecting... 3/5' });
    expect(classifyCodexJsonlLine(line({ type: 'error', message: 'Reconnecting...' })).kind).toBe('error_candidate');
    expect(classifyCodexJsonlLine(line({ type: 'error', error: { message: 'nested' } }))).toEqual({ kind: 'error_candidate', message: 'nested' });
    expect(classifyCodexJsonlLine(line({ type: 'turn.failed' })).kind).toBe('turn_failed');
    expect(classifyCodexJsonlLine(line({ type: 'turn.failed', error: { message: 'boom' } }))).toEqual({ kind: 'turn_failed', message: 'boom' });
    expect(classifyCodexJsonlLine('   ').kind).toBe('ignored_blank');
    expect(classifyCodexJsonlLine('{"type":42}').kind).toBe('malformed');
  });

  it('parses usage tolerantly', () => {
    expect(parseCodexUsage(undefined)).toBeNull();
    expect(parseCodexUsage({ input_tokens: 3 })).toEqual({ input: 3, cached: 0, output: 0, reasoning: 0 });
    expect(parseCodexUsage({ input_tokens: -1, output_tokens: 'x', cached_input_tokens: 2.9 })).toEqual({ input: 0, cached: 2, output: 0, reasoning: 0 });
  });
});

describe('CodexJsonlParser: streaming', () => {
  it('produces the same summary for any chunking, including splits inside UTF-8 sequences', () => {
    const text = fixture('p0-success-observation.jsonl').replace('Claude provider', 'Claude sağlayıcı \u{1F600}');
    const whole = parseCodexJsonl(text);
    const bytes = Buffer.from(text, 'utf8');
    for (const size of [1, 2, 3, 7, 64, 513]) {
      const parser = new CodexJsonlParser();
      for (let i = 0; i < bytes.length; i += size) {
        parser.push(bytes.subarray(i, i + size));
      }
      parser.end();
      expect(parser.summary()).toEqual(whole);
    }
    expect(whole.content).toContain('sağlayıcı \u{1F600}');
  });

  it('flushes a final line without a trailing newline on end()', () => {
    const parser = new CodexJsonlParser();
    expect(parser.push('{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":1}}')).toHaveLength(1);
    const flushed = parser.end();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].kind).toBe('turn_completed');
    expect(parser.summary().turnCompleted).toBe(true);
  });

  it('stops parsing past the byte cap and flags truncation', () => {
    const line = '{"type":"item.completed","item":{"type":"agent_message","text":"abc"}}\n';
    const parser = new CodexJsonlParser(line.length + 10);
    parser.push(line);
    parser.push(line);
    parser.push('{"type":"turn.completed"}\n');
    parser.end();
    const summary = parser.summary();
    expect(summary.truncated).toBe(true);
    expect(summary.agentMessages).toEqual(['abc']);
    expect(summary.turnCompleted).toBe(false);
    expect(summary.bytesSeen).toBe(line.length + 10);
  });
});

describe('stream-controlled labels are bounded and control-char free', () => {
  // itemType / eventType / itemId / thread_id / tool_name all reach a SECURITY
  // log line (logger formats context as `k=v` by plain interpolation) and the
  // audit log. Unbounded values with CR/LF could forge extra lines there.
  it('flattens control characters and bounds item.type, item.id and thread_id', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'id\r\n[FORGED] line',
        type: 'command_execution\n[2026-01-01T00:00:00Z] [WARN] [SECURITY] forged',
        command: 'x'.repeat(500),
      },
    });
    const event = classifyCodexJsonlLine(line);
    expect(event.kind).toBe('tool_attempt');
    if (event.kind !== 'tool_attempt') return;
    for (const value of [event.attempt.itemType, event.attempt.eventType, event.attempt.itemId ?? '', event.attempt.toolName]) {
      expect(/[\u0000-\u001f\u007f]/.test(value)).toBe(false);
    }
    expect(event.attempt.itemType.length).toBeLessThanOrEqual(CODEX_LABEL_MAX_CHARS + 3);
    expect(event.attempt.itemType).toContain('command_execution');
    expect(event.attempt.itemId).toBe('id  [FORGED] line');

    const thread = classifyCodexJsonlLine(JSON.stringify({ type: 'thread.started', thread_id: 'a\nb' }));
    expect(thread.kind).toBe('thread_started');
    if (thread.kind === 'thread_started') expect(thread.threadId).toBe('a b');
  });

  it('bounds every describeToolName part, including the item type and changed paths', () => {
    const long = 'p'.repeat(4000);
    const line = JSON.stringify({
      type: 'item.started',
      item: { type: long, changes: [{ path: long }, { path: long }, { path: long }, { path: long }] },
    });
    const event = classifyCodexJsonlLine(line);
    expect(event.kind).toBe('tool_attempt');
    if (event.kind !== 'tool_attempt') return;
    // item type + at most 3 paths, each capped: nowhere near the raw 20 KB.
    expect(event.attempt.toolName.length).toBeLessThan(4 * (CODEX_LABEL_MAX_CHARS + 3) + 8);
  });

  it('bounds an unknown top-level event type', () => {
    const event = classifyCodexJsonlLine(JSON.stringify({ type: 'weird.\n' + 'z'.repeat(500) }));
    expect(event.kind).toBe('unknown_event');
    if (event.kind !== 'unknown_event') return;
    expect(event.type.length).toBeLessThanOrEqual(CODEX_LABEL_MAX_CHARS + 3);
    expect(event.type).not.toContain('\n');
  });

  it('safeCodexLabel is a pure, idempotent flattener', () => {
    expect(safeCodexLabel('a\tb\nc')).toBe('a b c');
    expect(safeCodexLabel(safeCodexLabel('x'.repeat(300)))).toBe(safeCodexLabel('x'.repeat(300)));
    expect(safeCodexLabel('short')).toBe('short');
  });
});

describe('stderr helpers', () => {
  it('removes the stdin notice line only', () => {
    expect(stripCodexStdinNotice(`${CODEX_STDIN_NOTICE}\nError parsing -c overrides\n`)).toBe('Error parsing -c overrides\n');
    expect(stripCodexStdinNotice(CODEX_STDIN_NOTICE)).toBe('');
    expect(stripCodexStdinNotice('')).toBe('');
  });

  it('keeps only the last 2 KB of stderr on a character boundary', () => {
    let tail = '';
    for (let i = 0; i < 200; i++) tail = appendCodexStderrTail(tail, `line ${i} ş\n`);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(CODEX_STDERR_TAIL_BYTES);
    expect(tail.endsWith('line 199 ş\n')).toBe(true);
    expect(tail.includes('�')).toBe(false);
    expect(appendCodexStderrTail('a', Buffer.from('b'))).toBe('ab');
  });
});
