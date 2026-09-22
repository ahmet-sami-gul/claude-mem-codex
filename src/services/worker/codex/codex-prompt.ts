/**
 * Deterministic, cache-friendly prompt rendering for the Codex observer
 * (plan 2.9).
 *
 * The developer item is the fixed CODEX_OBSERVER_DEVELOPER_INSTRUCTIONS
 * (codex-invocation.ts). The single user item, written to stdin, is:
 *
 *   <observer_transcript>
 *   <turn n="1" from="claude-mem">
 *   ...history[0].content...
 *   </turn>
 *   <turn n="2" from="observer">
 *   ...
 *   </turn>
 *   </observer_transcript>
 *   <current_task turn="N">
 *   ...observation reply rules / summary marker / plain-text instruction...
 *   </current_task>
 *
 * INVARIANT (unit-tested): the transcript part of render(history[0..k]) is a
 * byte prefix of the transcript part of render(history[0..k+1]); only the
 * trailer (`</observer_transcript>` + current_task) differs. Nothing variable
 * (timestamp, counter, session id) precedes new content, so the longest
 * possible prefix stays identical between calls.
 *
 * ESCAPING (render-time only; stored history stays raw): inside every content
 * block the leading `<` of these sequences becomes `&lt;` so content can forge
 * neither an opening nor a closing framing tag:
 *   `<turn` + whitespace / `>` / `/`, `</turn`, `<observer_transcript` +
 *   whitespace / `>` / `/`, `</observer_transcript`, `<current_task`,
 *   `</current_task`.
 * `<observer_transcript>` is emitted only by this renderer
 * (CODEX_TRANSCRIPT_OPEN), so BOTH of its forms are escaped unconditionally
 * inside content. `</current_task` is escaped on top of the plan list: it
 * would otherwise end the task early.
 *
 * `observed_from_primary_session` is the one envelope whose real tags live
 * INSIDE the content block (src/sdk/prompts.ts builds the envelope around the
 * untrusted tool fields and appends the reply rules after it), so it cannot be
 * escaped unconditionally. Instead the block is segmented (see
 * escapeCodexContent): the first opening tag is genuine, a closing tag is
 * genuine when it is the last one before a following opening tag separated
 * only by whitespace (the batched-envelope shape) or the last one in the
 * block, and every other opening and closing tag is escaped. Consequences:
 * untrusted content can never end an envelope early, can never open one that
 * the renderer does not close, and can never place its own text in the trusted
 * region between envelopes; the worst it can do is split one envelope into two
 * untrusted ones. A block whose only envelope tag is an unpaired opening tag
 * has that tag escaped, so a block never ends inside an envelope.
 *
 * Pure module: no I/O, no logging.
 */

import type { ConversationMessage } from '../../worker-types.js';
import { ClassifiedProviderError } from '../provider-errors.js';

/** Hard size guard for the rendered stdin prompt (characters). */
export const CODEX_PROMPT_MAX_CHARS = 600_000;

export const CODEX_TRANSCRIPT_OPEN = '<observer_transcript>\n';
export const CODEX_TRANSCRIPT_CLOSE = '</observer_transcript>\n';

/** Every `observed_from_primary_session` tag, opening or closing. */
const ENVELOPE_TAG_RE = /<(\/?)observed_from_primary_session/gi;

/**
 * Text allowed between a genuine closing tag and the next genuine opening tag:
 * the closing tag's own `>` plus whitespace. Anything else means the closing
 * tag did not end a top-level envelope, so the pair is not a segment boundary.
 */
const ENVELOPE_GAP_RE = /^\s*>?\s*$/;

/** Framing sequences whose leading `<` is always escaped. */
const FRAMING_RE = /<(?=\/turn|turn[\s>/]|observer_transcript|\/observer_transcript|current_task|\/current_task)/gi;

export type CodexTurnSpeaker = 'claude-mem' | 'observer';

export function speakerFor(role: ConversationMessage['role']): CodexTurnSpeaker {
  return role === 'assistant' ? 'observer' : 'claude-mem';
}

interface EnvelopeTag {
  index: number;
  length: number;
  closing: boolean;
}

function envelopeTags(text: string): EnvelopeTag[] {
  const tags: EnvelopeTag[] = [];
  ENVELOPE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENVELOPE_TAG_RE.exec(text)) !== null) {
    tags.push({ index: match.index, length: match[0].length, closing: match[1] === '/' });
  }
  return tags;
}

/**
 * Offsets of the `observed_from_primary_session` tags that are kept as genuine
 * framing; every other tag in the block is escaped.
 *
 * Walk the tags left to right, alternating between "outside an envelope" and
 * "inside" one:
 *   - outside: the next opening tag is genuine (a closing tag seen while
 *     outside is always forged);
 *   - inside: the envelope ends at the LAST closing tag before the next
 *     opening tag, and only when nothing but the tag's `>` and whitespace
 *     separates the two (that is the shape a batched turn emits). Otherwise
 *     that opening tag is forged and the scan stays inside, so the envelope
 *     ends at the last closing tag in the rest of the block.
 * An opening tag with no closing tag after it is dropped, so a block never
 * ends inside an envelope.
 */
function keptEnvelopeTagOffsets(text: string): ReadonlySet<number> {
  const tags = envelopeTags(text);
  const keep = new Set<number>();
  let i = 0;
  while (i < tags.length && tags[i].closing) i++; // closing tags before any opening tag are forged

  while (i < tags.length) {
    const open = tags[i];
    i++;
    let lastClose: EnvelopeTag | null = null;
    let nextOpen = -1;
    for (let j = i; j < tags.length; j++) {
      const tag = tags[j];
      if (tag.closing) {
        lastClose = tag;
        continue;
      }
      if (lastClose && ENVELOPE_GAP_RE.test(text.slice(lastClose.index + lastClose.length, tag.index))) {
        nextOpen = j;
        break;
      }
    }
    if (lastClose === null) break; // unpaired opening tag: escape it too
    keep.add(open.index);
    keep.add(lastClose.index);
    if (nextOpen === -1) break;
    i = nextOpen;
  }
  return keep;
}

/**
 * Escape framing sequences in one content block (see module header). Pure and
 * deterministic: the same input always yields the same output.
 */
export function escapeCodexContent(content: string): string {
  const out = content.replace(FRAMING_RE, '&lt;');
  const keep = keptEnvelopeTagOffsets(out);
  ENVELOPE_TAG_RE.lastIndex = 0;
  return out.replace(ENVELOPE_TAG_RE, (tag, _slash: string, offset: number) =>
    keep.has(offset) ? tag : '&lt;' + tag.slice(1),
  );
}

function renderTurn(index: number, message: ConversationMessage): string {
  return `<turn n="${index + 1}" from="${speakerFor(message.role)}">\n${escapeCodexContent(message.content)}\n</turn>\n`;
}

/**
 * The transcript part of the prompt (no trailer). Exported so callers and
 * tests can check the byte-prefix invariant directly.
 */
export function renderCodexTranscriptPrefix(history: readonly ConversationMessage[]): string {
  let out = CODEX_TRANSCRIPT_OPEN;
  for (let i = 0; i < history.length; i++) {
    out += renderTurn(i, history[i]);
  }
  return out;
}

/** The variable trailer: closes the transcript and states the current task. */
export function renderCodexTaskTrailer(turnNumber: number, task: string): string {
  return `${CODEX_TRANSCRIPT_CLOSE}<current_task turn="${turnNumber}">\n${escapeCodexContent(task)}\n</current_task>\n`;
}

/**
 * Render the full stdin prompt: `history` becomes the transcript and `task`
 * (the message being answered now) the current_task, numbered
 * history.length + 1. Throws a transient ClassifiedProviderError
 * (`codex_prompt_too_large`) above CODEX_PROMPT_MAX_CHARS.
 */
export function renderCodexPrompt(history: readonly ConversationMessage[], task: string): string {
  const prompt = renderCodexTranscriptPrefix(history) + renderCodexTaskTrailer(history.length + 1, task);
  if (prompt.length > CODEX_PROMPT_MAX_CHARS) {
    throw new ClassifiedProviderError(
      `Codex prompt is ${prompt.length} characters, above the ${CODEX_PROMPT_MAX_CHARS} character guard`,
      {
        kind: 'transient',
        cause: new Error('codex prompt size guard'),
        code: 'codex_prompt_too_large',
      },
    );
  }
  return prompt;
}

/**
 * Render from a provider conversation whose LAST message is the user message
 * being answered now (the base provider pushes it before calling query()).
 */
export function renderCodexPromptFromConversation(conversation: readonly ConversationMessage[]): string {
  const last = conversation[conversation.length - 1];
  if (!last || last.role !== 'user') {
    throw new ClassifiedProviderError('Codex prompt requires a final user message as the current task', {
      kind: 'transient',
      cause: new Error('codex prompt without current task'),
      code: 'codex_prompt_without_task',
    });
  }
  return renderCodexPrompt(conversation.slice(0, -1), last.content);
}
