import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { OperationIdSchema, type OperationDescriptor } from './contracts.ts';
import { OperationError } from './operations.ts';

const querySchema = Type.Object({
  view: Type.Optional(Type.Union([Type.Literal('index'), Type.Literal('full')])),
  prefix: Type.Optional(OperationIdSchema),
  operationId: Type.Optional(OperationIdSchema),
}, { additionalProperties: false });

/** All transports resolve discovery against the same immutable service catalog. */
export function discoverOperations(operations: readonly OperationDescriptor[], query: unknown) {
  if (!Value.Check(querySchema, query) || (query.prefix && query.operationId)) {
    throw new OperationError(400, 'catalog_invalid_query', 'Use view=index or full, and at most one prefix or operationId.');
  }
  const selected = operations.filter(({ id }) => {
    if (query.operationId) return id === query.operationId;
    return !query.prefix || id === query.prefix || id.startsWith(query.prefix + '.');
  });
  if (query.operationId && !selected.length) throw new OperationError(404, 'operation_not_found', 'This operation is not registered.');
  return { operations: query.view === 'index' ? selected.map(({ id, effect, description }) => ({ id, effect, description })) : selected };
}
