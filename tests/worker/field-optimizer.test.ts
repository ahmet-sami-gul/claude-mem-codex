import { describe, it, expect } from 'bun:test';
import {
  countFieldsNeedingCompression,
  optimizeField,
  optimizeObservationFields,
  buildFieldCompressionPrompt,
  type FieldCompressor,
} from '../../src/services/worker/field-optimizer.js';

const CTX = { sessionDbId: 1, field: 'outcome', toolName: 'Read' };
const MAX = 200;

/** A payload comfortably over `MAX` once stringified. */
const oversized = { body: 'x'.repeat(MAX * 3) };

describe('oversized observation fields are condensed, not cut (#3800)', () => {
  it('leaves a field that already fits untouched, and never calls the model', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return 'nope'; };

    const value = { small: 'fits' };
    expect(await optimizeField(value, compress, CTX, MAX)).toBe(value);
    expect(calls).toBe(0);
  });

  it('replaces an oversized field with a condensed summary of the whole field', async () => {
    const compress: FieldCompressor = async () => 'the file defines 3 helpers and exits 0';

    const out = await optimizeField(oversized, compress, CTX, MAX) as string;

    expect(out).toContain('the file defines 3 helpers and exits 0');
    // Marked condensed rather than elided: it summarises everything, so the
    // observer must not treat it as a fragment with a hole in it.
    expect(out).toContain('<condensed');
    expect(out).not.toContain('<elided');
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  it('asks for a budget under the cap so a slightly-long reply still fits', async () => {
    let asked = -1;
    const compress: FieldCompressor = async (_t, budget) => { asked = budget; return 'ok'; };

    await optimizeField(oversized, compress, CTX, MAX);
    expect(asked).toBeLessThan(MAX);
    expect(asked).toBeGreaterThan(0);
  });

  it('falls back to the original (so truncation still applies) when the model returns nothing', async () => {
    const compress: FieldCompressor = async () => null;
    expect(await optimizeField(oversized, compress, CTX, MAX)).toBe(oversized);
  });

  it('falls back when the model returns something still over budget', async () => {
    const compress: FieldCompressor = async () => 'y'.repeat(MAX * 2);
    expect(await optimizeField(oversized, compress, CTX, MAX)).toBe(oversized);
  });

  it('falls back when the model throws, rather than losing the observation', async () => {
    const compress: FieldCompressor = async () => { throw new Error('gateway down'); };
    expect(await optimizeField(oversized, compress, CTX, MAX)).toBe(oversized);
  });

  it('tries once per field — a failure never becomes a retry ladder', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return null; };

    await optimizeField(oversized, compress, CTX, MAX);
    expect(calls).toBe(1);
  });

  it('condenses both payload fields independently', async () => {
    const compress: FieldCompressor = async text =>
      text.includes('IN') ? 'condensed input' : 'condensed output';

    const out = await optimizeObservationFields(
      { toolInput: { body: 'IN'.repeat(MAX * 2) }, toolOutput: oversized },
      compress,
      { sessionDbId: 1, toolName: 'Bash' },
      MAX,
    );

    expect(String(out.toolInput)).toContain('condensed input');
    expect(String(out.toolOutput)).toContain('condensed output');
  });

  it('only condenses the field that is actually oversized', async () => {
    const compress: FieldCompressor = async () => 'condensed';
    const small = { ok: 1 };

    const out = await optimizeObservationFields(
      { toolInput: small, toolOutput: oversized },
      compress,
      { sessionDbId: 1 },
      MAX,
    );

    expect(out.toolInput).toBe(small);
    expect(String(out.toolOutput)).toContain('condensed');
  });

  it('tells the model to keep the signal and return the payload only', () => {
    const prompt = buildFieldCompressionPrompt('some payload', 500);
    expect(prompt).toContain('500');
    expect(prompt).toContain('some payload');
    expect(prompt).toContain('file paths');
    expect(prompt).toContain('no code');
  });
});

describe('countFieldsNeedingCompression (M4: the compression execs a skipped pass saves)', () => {
  const editInput = { file_path: '/fixture/huge.ts', old_string: 'old()', new_string: 'new()', replace_all: false };
  const prefix = 'x'.repeat(100_000);
  const editOutput = { filePath: editInput.file_path, oldString: editInput.old_string, newString: editInput.new_string,
    originalFile: null, userModified: false,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ['-' + prefix + 'old()', '+' + prefix + 'new()'] }] };

  it('predicts exactly the number of compressor calls optimizeObservationFields makes', async () => {
    const cases: Array<{ fields: { toolInput: unknown; toolOutput: unknown }; toolName?: string }> = [
      { fields: { toolInput: { a: 1 }, toolOutput: 'ok' } },
      { fields: { toolInput: oversized, toolOutput: 'ok' } },
      { fields: { toolInput: 'small', toolOutput: oversized } },
      { fields: { toolInput: oversized, toolOutput: oversized } },
      // A JSON string the size test measures quoted, as the HTTP ingest delivers it.
      { fields: { toolInput: JSON.stringify(oversized), toolOutput: '{}' } },
      // Just under / just over the cap once pretty-printed.
      { fields: { toolInput: 'y'.repeat(MAX - 2), toolOutput: 'y'.repeat(MAX - 1) } },
      // An oversized native Edit whose observer view is compacted first: no call.
      { fields: { toolInput: editInput, toolOutput: editOutput }, toolName: 'Edit' },
      // The same payload under another tool name is not compacted.
      { fields: { toolInput: editInput, toolOutput: editOutput }, toolName: 'Write' },
    ];
    for (const { fields, toolName } of cases) {
      let calls = 0;
      const counting: FieldCompressor = async () => { calls++; return null; };
      await optimizeObservationFields(fields, counting, { sessionDbId: 1, toolName }, MAX);
      expect(countFieldsNeedingCompression(fields, { toolName }, MAX)).toBe(calls);
    }
  });
});
