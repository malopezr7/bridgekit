// ---------------------------------------------------------------------------
// @malopezr7/bridgekit/contract — pure entry point
//
// ZERO side effects. No react/react-native imports.
// Safe to import from Node (CLI codegen), Jest, and web builds.
// ---------------------------------------------------------------------------

export type { ValidationResult } from './codec';
// Codec (encode/decode/validate)
export { decode, encode, validate } from './codec';

// Descriptor types
export type {
  BridgeContract,
  BridgeStreamSource,
  ContractDescriptor,
  ContractShape,
  FireDescriptor,
  MethodDescriptor,
  MethodParams,
  MethodResult,
  QueryDescriptor,
  QuerySyncDescriptor,
  StateDescriptor,
  StateKeys,
  StateValue,
  StreamDescriptor,
  StreamValue,
} from './contract';
// Re-export the enriched `t` (schema DSL + descriptor builders) from contract.ts.
// contract.ts augments the base `t` with fire/query/querySync/stream/state.
// Contract definition
export { defineContract, t } from './contract';
// Hash utilities (used by CLI codegen and skew diffing)
export { memberHashes, stableHash } from './hash';
export type {
  BridgeError,
  BridgeErrorCode,
  BridgeErrorContext,
  BridgeScope,
  CallEnvelope,
  ResultEnvelope,
  ResultErr,
  ResultOk,
} from './protocol';

// Wire protocol
export {
  createBridgeError,
  ERROR_CODES,
  isBridgeError,
} from './protocol';
// Schema types (needed by consumers constructing schemas)
export type {
  AnySchema,
  ArraySchema,
  BooleanSchema,
  Infer,
  JsonSchema,
  LiteralsSchema,
  NullableSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  RecordSchema,
  StringSchema,
  UnionSchema,
  VoidSchema,
} from './schema';
