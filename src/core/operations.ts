import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import { CloneType, TypeGuard, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  OperationDescriptorSchema,
  OperationInvokeSchema,
  OperationReceiptQuerySchema,
  type OperationCatalog,
  type OperationDescriptor,
  type OperationReceiptQuery,
  type OperationResult,
} from './contracts.ts';
import { serializeJson } from './json.ts';

/** Each successful step retains its full JSON result. Use bounded or paginated read results. */
export const operationsDDL = `CREATE TABLE IF NOT EXISTS operation_receipts (
  namespace TEXT NOT NULL,
  step_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (namespace, step_id)
) STRICT, WITHOUT ROWID;`;

export class OperationError extends Error {
  override readonly name = 'OperationError';
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface OperationContext {
  readonly db: DatabaseSync;
}

export interface OperationDefinition<Input extends TSchema, Output extends TSchema> {
  readonly id: OperationDescriptor['id'];
  readonly description: OperationDescriptor['description'];
  readonly effect: OperationDescriptor['effect'];
  readonly inputSchema: Input;
  readonly outputSchema: Output;
  readonly interaction?: OperationDescriptor['interaction'];
  /** Persist domain changes and jobs on this connection. The registry owns the transaction. */
  run(input: Static<Input>, ctx: OperationContext): Static<Output>;
}

export type Operation = OperationDefinition<TSchema, TSchema>;

export function defineOperation<Input extends TSchema, Output extends TSchema>(
  definition: OperationDefinition<Input, Output>,
): OperationDefinition<Input, Output> {
  return definition;
}

function assertNamespace(namespace: string) {
  // SQLite's UTF-8 conversion replaces unpaired surrogates.
  if (typeof namespace !== 'string' || !namespace.trim() || /[\0\p{Surrogate}]/u.test(namespace)) {
    throw new OperationError(400, 'operation_invalid_scope', 'Provide a receipt namespace.');
  }
}

function hasOperationIdentity(request: OperationReceiptQuery): boolean {
  return Object.hasOwn(request, 'operationId') && Object.hasOwn(request, 'stepId') && !/\p{Surrogate}/u.test(request.stepId);
}

function assertInteractionFields(id: string, schema: TSchema, fields: readonly string[], side: 'input' | 'output') {
  for (const field of fields) {
    if (!TypeGuard.IsObject(schema) || !Object.hasOwn(schema.properties, field)) {
      throw new OperationError(500, 'operation_invalid_registration',
        `Interaction field ${JSON.stringify(field)} is not declared on the ${side} object schema for ${id}.`);
    }
  }
}

function asyncHandler(id: string) {
  return new OperationError(500, 'operation_async_handler', `Operation ${id} must run synchronously.`);
}

function payloadJson(value: unknown, phase: 'input' | 'result', id: string): string {
  try {
    return serializeJson(value, phase === 'input');
  } catch {
    throw phase === 'input'
      ? new OperationError(400, 'operation_invalid_input', `Input for ${id} must be JSON data.`)
      : new OperationError(500, 'operation_invalid_result', `Result from ${id} must be JSON data.`);
  }
}

export class Operations {
  private readonly db: DatabaseSync;
  private readonly operations = new Map<string, Operation>();
  private readonly findReceipt: StatementSync;
  private readonly insertReceipt: StatementSync;

  /** Execute operationsDDL on the database before constructing the registry. */
  constructor(db: DatabaseSync, operations: readonly Operation[]) {
    this.db = db;
    for (const { id, description, effect, inputSchema, outputSchema, interaction, run } of operations) {
      const descriptor = { id, description, effect, inputSchema, outputSchema, ...(interaction === undefined ? {} : { interaction }) };
      if (!Value.Check(OperationDescriptorSchema, descriptor)
        || !TypeGuard.IsSchema(inputSchema) || !TypeGuard.IsSchema(outputSchema) || typeof run !== 'function') {
        throw new OperationError(500, 'operation_invalid_registration', `Invalid operation definition for ${id}.`);
      }
      if (this.operations.has(id)) {
        throw new OperationError(500, 'operation_duplicate_id', `Operation ${id} is already registered.`);
      }
      if (isAsyncFunction(run)) throw asyncHandler(id);
      if (interaction !== undefined) {
        const { identityFields = [], localDateField, resultLink } = interaction;
        const inputFields = localDateField === undefined ? identityFields : [...identityFields, localDateField];
        assertInteractionFields(id, inputSchema, inputFields, 'input');
        if (resultLink) assertInteractionFields(id, outputSchema, [resultLink.hrefField, resultLink.labelField], 'output');
        descriptor.interaction = structuredClone(interaction);
      }

      this.operations.set(id, { ...descriptor, inputSchema: CloneType(inputSchema), outputSchema: CloneType(outputSchema), run });
    }

    this.findReceipt = db.prepare(`SELECT operation_id, request_hash, result_json FROM operation_receipts
      WHERE namespace = ? AND step_id = ?`);
    this.insertReceipt = db.prepare(`INSERT INTO operation_receipts
      (namespace, step_id, operation_id, request_hash, result_json) VALUES (?, ?, ?, ?, ?)`);
  }

  catalog(): OperationCatalog {
    const operations = [...this.operations.values()].map(({ id, description, effect, inputSchema, outputSchema, interaction }) => ({
      id, description, effect, inputSchema, outputSchema, ...(interaction === undefined ? {} : { interaction }),
    }));
    return { operations: structuredClone(operations) };
  }

  /** The authenticated adapter supplies the namespace for the web or connection caller. */
  receipt(namespace: string, query: unknown): OperationResult {
    assertNamespace(namespace);
    if (!Value.Check(OperationReceiptQuerySchema, query) || !hasOperationIdentity(query)) {
      throw new OperationError(400, 'operation_invalid_receipt_query', 'Provide an operation ID and step ID.');
    }

    const { operationId, stepId } = query;
    const receipt = this.findReceipt.get(namespace, stepId);
    if (!receipt || receipt.operation_id !== operationId) {
      throw new OperationError(404, 'operation_receipt_not_found', 'No receipt was found for this operation and step.');
    }
    return { operationId, stepId, replayed: true, result: JSON.parse(String(receipt.result_json)) };
  }

  /** The authenticated adapter supplies the namespace for the web or connection caller. */
  invoke(namespace: string, payload: unknown): OperationResult {
    assertNamespace(namespace);
    if (!Value.Check(OperationInvokeSchema, payload)
      || !hasOperationIdentity(payload) || !Object.hasOwn(payload, 'input')) {
      throw new OperationError(400, 'operation_invalid_invocation', 'Provide an operation ID, step ID and input.');
    }

    const { operationId, stepId, input } = payload;
    const inputJson = payloadJson(input, 'input', operationId);
    const hash = createHash('sha256').update(operationId).update('\0').update(inputJson).digest('hex');

    // Acquire the write reservation before checking receipts, including for read operations.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.findReceipt.get(namespace, stepId);
      if (receipt) {
        if (receipt.operation_id !== operationId || receipt.request_hash !== hash) {
          throw new OperationError(409, 'operation_step_conflict', 'This step was already used for a different operation or input.');
        }
        const result: unknown = JSON.parse(String(receipt.result_json));
        this.db.exec('COMMIT');
        return { operationId, stepId, replayed: true, result };
      }

      const operation = this.operations.get(operationId);
      if (!operation) {
        throw new OperationError(404, 'operation_not_found', `Operation ${operationId} is not registered.`);
      }
      const normalizedInput: unknown = JSON.parse(inputJson);
      if (!Value.Check(operation.inputSchema, normalizedInput)) {
        const issue = Value.Errors(operation.inputSchema, normalizedInput).First();
        const location = issue?.path || '(input)';
        throw new OperationError(400, 'operation_invalid_input', `${operationId} ${location}: ${issue?.message ?? 'Invalid input'}.`);
      }
      const output: unknown = operation.run(normalizedInput, { db: this.db });
      if (isPromise(output)) {
        void output.catch(() => {});
        throw asyncHandler(operationId);
      }

      const resultJson = payloadJson(output, 'result', operationId);
      const result: unknown = JSON.parse(resultJson);
      if (!Value.Check(operation.outputSchema, result)) {
        throw new OperationError(500, 'operation_invalid_result', `Result does not match the schema for ${operationId}.`);
      }

      const inserted = this.insertReceipt.run(namespace, stepId, operationId, hash, resultJson);
      if (inserted.changes !== 1) {
        throw new OperationError(500, 'operation_receipt_not_saved', `Could not save the receipt for ${operationId}.`);
      }
      this.db.exec('COMMIT');
      return { operationId, stepId, replayed: false, result };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
