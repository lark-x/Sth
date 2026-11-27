import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false };

export const OperationIdSchema = Type.String({
  maxLength: 100,
  pattern: '^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)*$',
});
export const OperationStepIdSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: '^[^\\s\\x00-\\x1f\\x7f]+$',
});

const operationFields = {
  operationId: OperationIdSchema,
  stepId: OperationStepIdSchema,
};

export const OperationReceiptQuerySchema = Type.Object(operationFields, strict);
export type OperationReceiptQuery = Static<typeof OperationReceiptQuerySchema>;

export const OperationInvokeSchema = Type.Object({
  ...operationFields,
  input: Type.Unknown(),
}, strict);
export type OperationInvoke = Static<typeof OperationInvokeSchema>;

export const OperationResultSchema = Type.Object({
  ...operationFields,
  replayed: Type.Boolean(),
  result: Type.Unknown(),
}, strict);
export type OperationResult = Static<typeof OperationResultSchema>;

export const OperationEffectSchema = Type.Union([Type.Literal('read'), Type.Literal('write')]);
export type OperationEffect = Static<typeof OperationEffectSchema>;

/** Client hints about top-level input fields and the fields used to present a result link. */
export const OperationInteractionSchema = Type.Object({
  identityFields: Type.Optional(Type.Array(Type.String())),
  localDateField: Type.Optional(Type.String()),
  resultLink: Type.Optional(Type.Object({
    hrefField: Type.String(), labelField: Type.String(),
    revisionField: Type.Optional(Type.String()), rangeField: Type.Optional(Type.String()),
  }, strict)),
}, strict);
export type OperationInteraction = Static<typeof OperationInteractionSchema>;

export const OperationDescriptorSchema = Type.Object({
  id: OperationIdSchema,
  description: Type.String({ pattern: '\\S' }),
  effect: OperationEffectSchema,
  inputSchema: Type.Record(Type.String(), Type.Unknown()),
  outputSchema: Type.Record(Type.String(), Type.Unknown()),
  interaction: Type.Optional(OperationInteractionSchema),
}, strict);
export type OperationDescriptor = Static<typeof OperationDescriptorSchema>;

export const OperationCatalogSchema = Type.Object({
  operations: Type.Array(OperationDescriptorSchema),
}, strict);
export type OperationCatalog = Static<typeof OperationCatalogSchema>;
