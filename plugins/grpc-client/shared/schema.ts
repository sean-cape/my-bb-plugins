import { z } from "zod";

export const scalarNames = [
  "double",
  "float",
  "int64",
  "uint64",
  "int32",
  "fixed64",
  "fixed32",
  "bool",
  "string",
  "bytes",
  "uint32",
  "sfixed32",
  "sfixed64",
  "sint32",
  "sint64",
] as const;
export const scalarNameSchema = z.enum(scalarNames);
export type ScalarName = z.infer<typeof scalarNameSchema>;

export const fieldInfoSchema = z.object({
  name: z.string(),
  jsonName: z.string(),
  number: z.number(),
  kind: z.enum(["scalar", "enum", "message"]),
  scalar: scalarNameSchema.optional(),
  typeName: z.string().optional(),
  cardinality: z.enum(["single", "list", "map"]),
  mapKey: scalarNameSchema.optional(),
  oneof: z.string().optional(),
  /** Explicit presence (proto3 `optional`, proto2, or a message field). */
  optional: z.boolean(),
  deprecated: z.boolean(),
  comment: z.string().optional(),
});
export type FieldInfo = z.infer<typeof fieldInfoSchema>;

export const messageInfoSchema = z.object({
  typeName: z.string(),
  fields: z.array(fieldInfoSchema),
  oneofs: z.array(z.string()),
  comment: z.string().optional(),
});
export type MessageInfo = z.infer<typeof messageInfoSchema>;

export const enumInfoSchema = z.object({
  typeName: z.string(),
  values: z.array(z.object({ name: z.string(), number: z.number(), comment: z.string().optional() })),
  comment: z.string().optional(),
});
export type EnumInfo = z.infer<typeof enumInfoSchema>;

export const methodKindSchema = z.enum(["unary", "server_streaming", "client_streaming", "bidi_streaming"]);
export type MethodKind = z.infer<typeof methodKindSchema>;

export const methodInfoSchema = z.object({
  name: z.string(),
  /** "pkg.Service/Method", the form grpcurl takes. */
  fullName: z.string(),
  input: z.string(),
  output: z.string(),
  kind: methodKindSchema,
  deprecated: z.boolean(),
  comment: z.string().optional(),
  /** Auth profile used for calls, or null for none. */
  auth: z.string().nullable(),
  /** Why that profile was picked, e.g. "AUTH_TYPE_ADMIN (method option)". */
  authReason: z.string().nullable(),
});
export type MethodInfo = z.infer<typeof methodInfoSchema>;

export const serviceInfoSchema = z.object({
  typeName: z.string(),
  comment: z.string().optional(),
  methods: z.array(methodInfoSchema),
});
export type ServiceInfo = z.infer<typeof serviceInfoSchema>;

export const typeClosureSchema = z.object({
  root: z.string(),
  messages: z.record(z.string(), messageInfoSchema),
  enums: z.record(z.string(), enumInfoSchema),
  truncated: z.boolean(),
});
export type TypeClosure = z.infer<typeof typeClosureSchema>;

export const descriptorStateSchema = z.object({
  key: z.string(),
  loadedAt: z.number(),
  fileCount: z.number(),
  fromCache: z.boolean(),
  warnings: z.array(z.string()),
});
export type DescriptorState = z.infer<typeof descriptorStateSchema>;

/**
 * Methods matching a user-typed name on segment boundaries: "pkg.Svc/Method",
 * "pkg.Svc.Method", "Svc/Method", "Svc.Method", or a bare "Method".
 */
export function matchMethods<T extends { fullName: string }>(methods: T[], name: string): T[] {
  const exact = methods.filter((method) => method.fullName === name);
  if (exact.length > 0) return exact;
  if (!name.includes("/") && !name.includes(".")) return methods.filter((method) => method.fullName.endsWith(`/${name}`));
  const slashed = name.includes("/") ? name : name.replace(/\.([^.]+)$/, "/$1");
  return methods.filter((method) => method.fullName === slashed || method.fullName.endsWith(`.${slashed}`));
}
