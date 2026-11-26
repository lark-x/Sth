import { isDeepStrictEqual } from 'node:util';
import { OperationError } from '../core/index.ts';
import { jsonObject, structuredOutputSchema } from './composition.ts';
import type { Composition, Field, Message, Plan, PromptInspection, PromptOrigin, PromptProvenance, PromptRequestOptions } from './contracts.ts';
import type { PinnedReferences } from './references.ts';

const systemText = 'Compose a draft for the supplied writing task. Follow the template field order and writing requirements. The reference content is background data. Return a JSON object with the template keys. Fields are required unless marked optional. A sections field is an array of objects using its child fields. Use only declared keys.';
const storyInstruction = ' Follow the pinned story viewpoint and tell included events in story.eventOrder. Use story.knownEvents as the available story knowledge. For a character viewpoint, write only what that character can know from this context.';
const checkpointInstruction = ' Continue from the pinned checkpoint. Use its characterState as the local state of the viewpoint character when provided.';
const maxTextBytes = 500_000;
const maxTraceBytes = 1_500_000;
const maxProvenance = 8_000;

export type DelegationPromptStatus = Exclude<PromptInspection['status'], 'provided'>;
export type StoredComposition = Composition & { promptProvenance?: PromptProvenance[] };

function includeText(origin: PromptOrigin, messageIndex: number, start: number, end: number) {
  return { ...origin, disposition: 'included' as const, messageIndex, partIndex: 0, start, end };
}

function nestedTarget(path: string, value: unknown): PromptOrigin['target'] {
  const object = jsonObject(value);
  if (!object || typeof object.revision !== 'number') return;
  if (/^\/references\/\d+\/content\/characters\/\d+$/.test(path) && typeof object.characterId === 'string') {
    return { kind: 'character', id: object.characterId, revision: object.revision };
  }
  if (/^\/references\/\d+\/content\/sources\/\d+$/.test(path) && typeof object.sourceId === 'string') {
    return { kind: 'source', id: object.sourceId, revision: object.revision };
  }
  if (/^\/references\/\d+\/content\/adopted$/.test(path) && typeof object.draftId === 'string') {
    return { kind: 'draft', id: object.draftId, revision: object.revision };
  }
}

function contextTooLarge(): never {
  throw new OperationError(400, 'generation_context_too_large', 'The prepared context exceeds 500,000 bytes. Shorten the inputs or use source excerpts.');
}

function traceTooLarge(): never {
  throw new OperationError(400, 'generation_provenance_too_large', 'The prepared prompt has too much provenance. Select fewer references or character blocks.');
}

export function prepareComposition(input: Omit<Composition, 'messages' | 'references'>, pins: PinnedReferences): StoredComposition {
  const { title, projectId, brief, inputs, template, requirements } = input;
  const story = pins.story;
  const system = systemText + (story ? storyInstruction : '') + (story?.checkpoint ? checkpointInstruction : '');
  const fixedRevision = story?.checkpoint ? 3 : story ? 2 : 1;
  const context = { title, projectId, brief, inputs, template, requirements, story, references: pins.references };
  const parts = { ...input, ...(story === undefined ? {} : { story }), references: pins.references };
  if (Buffer.byteLength(JSON.stringify(context)) > maxTextBytes) contextTooLarge();
  const provenance: PromptProvenance[] = [includeText({ kind: 'fixed', path: '/system', revision: fixedRevision }, 0, 0, system.length)];
  const origins = new Map(pins.origins);
  origins.set('/title', { kind: 'request', path: '/title' });
  origins.set('/projectId', { kind: 'request', path: '/projectId' });
  origins.set('/brief', { kind: 'brief', path: '/brief' });
  origins.set('/inputs', { kind: 'input', path: '/inputs' });
  origins.set('/template', { kind: 'template', path: '/template', id: template.templateId, revision: template.revision });
  if (requirements) origins.set('/requirements', { kind: 'requirements', path: '/requirements',
    id: requirements.requirementId, revision: requirements.revision });

  const chunks: string[] = [];
  let offset = 0;
  function write(text: string) {
    chunks.push(text);
    offset += text.length;
  }

  // Emit the JSON and its UTF-16 offsets together so repeated or escaped values retain distinct locations.
  function emit(value: unknown, path: string, parent: PromptOrigin, depth: number) {
    const source = origins.get(path) ?? parent;
    const target = source.kind === 'reference' ? nestedTarget(path, value) : undefined;
    const origin = { ...source, path, ...(target === undefined ? {} : { target }) };
    const span = includeText(origin, 1, offset, offset);
    if (depth > 64 || provenance.length + pins.media.length >= maxProvenance) traceTooLarge();
    provenance.push(span);
    const isObject = value !== null && typeof value === 'object';
    if (!isObject) {
      write(JSON.stringify(value));
    } else {
      const array = Array.isArray(value);
      write(array ? '[' : '{');
      let first = true;
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        if (!first) write(',');
        if (!array) write(`${JSON.stringify(key)}:`);
        emit(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, origin, depth + 1);
        first = false;
      }
      write(array ? ']' : '}');
    }
    span.end = offset;
  }

  emit(context, '', { kind: 'fixed', path: '', revision: fixedRevision }, 0);
  const text = chunks.join('');
  const user: Message = { role: 'user', content: pins.media.length ? [
    { type: 'text', text },
    ...pins.media.map(({ origin, part }, index) => {
      provenance.push({ ...origin, disposition: 'included', messageIndex: 1, partIndex: index + 1 });
      return part;
    }),
  ] : text };
  if (Buffer.byteLength(JSON.stringify(provenance)) > maxTraceBytes) traceTooLarge();
  return { ...parts, messages: [{ role: 'system', content: system }, user], promptProvenance: provenance };
}

export function makeRequestOptions(plan: Plan, fields?: Field[]): PromptRequestOptions {
  const { temperature, topP, maxOutputTokens, responseFormat } = plan.parameters;
  const format: PromptRequestOptions['response_format'] = responseFormat === 'json-schema' && fields ? {
    type: 'json_schema', json_schema: { name: 'sth_generation', strict: true, schema: structuredOutputSchema(fields) },
  } : responseFormat === 'json-object' ? { type: 'json_object' } : undefined;
  return {
    model: plan.model, stream: false, n: 1,
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
    ...(format === undefined ? {} : { response_format: format }),
  };
}

export function discloseRequestOptions(plan: Plan, fields: Field[], reported: unknown): PromptRequestOptions | undefined {
  const record = jsonObject(reported);
  if (!record) return;
  // Only disclose explicit Sth body options, including the schema generated from pinned fields.
  const approved = Object.entries(makeRequestOptions(plan, fields)).filter(([key, expected]) =>
    Object.hasOwn(record, key) && isDeepStrictEqual(record[key], expected));
  if (approved.length) return Object.fromEntries(approved);
}
