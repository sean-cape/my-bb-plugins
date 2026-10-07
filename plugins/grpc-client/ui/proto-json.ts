import type { FieldInfo, TypeClosure } from "../shared/schema";
import type { ScalarName } from "../shared/schema";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WRAPPERS: Record<string, ScalarName> = {
  "google.protobuf.StringValue": "string",
  "google.protobuf.BytesValue": "bytes",
  "google.protobuf.BoolValue": "bool",
  "google.protobuf.Int32Value": "int32",
  "google.protobuf.UInt32Value": "uint32",
  "google.protobuf.Int64Value": "int64",
  "google.protobuf.UInt64Value": "uint64",
  "google.protobuf.FloatValue": "float",
  "google.protobuf.DoubleValue": "double",
};

/** Well-known types have a special proto3 JSON form, so they get dedicated editors. */
export type WellKnown =
  | { kind: "timestamp" }
  | { kind: "duration" }
  | { kind: "fieldmask" }
  | { kind: "empty" }
  | { kind: "json" }
  | { kind: "wrapper"; scalar: ScalarName };

export function wellKnown(typeName: string | undefined): WellKnown | null {
  if (typeName === undefined) return null;
  const wrapped = WRAPPERS[typeName];
  if (wrapped !== undefined) return { kind: "wrapper", scalar: wrapped };
  switch (typeName) {
    case "google.protobuf.Timestamp":
      return { kind: "timestamp" };
    case "google.protobuf.Duration":
      return { kind: "duration" };
    case "google.protobuf.FieldMask":
      return { kind: "fieldmask" };
    case "google.protobuf.Empty":
      return { kind: "empty" };
    case "google.protobuf.Struct":
    case "google.protobuf.Value":
    case "google.protobuf.ListValue":
    case "google.protobuf.Any":
      return { kind: "json" };
    default:
      return null;
  }
}

export function shortName(typeName: string): string {
  return typeName.slice(typeName.lastIndexOf(".") + 1);
}

export function elementLabel(field: FieldInfo): string {
  if (field.kind === "scalar") return field.scalar ?? "scalar";
  const wkt = wellKnown(field.typeName);
  if (wkt?.kind === "wrapper") return `${wkt.scalar}?`;
  return shortName(field.typeName ?? "");
}

export function typeLabel(field: FieldInfo): string {
  const element = elementLabel(field);
  if (field.cardinality === "list") return `repeated ${element}`;
  if (field.cardinality === "map") return `map<${field.mapKey}, ${element}>`;
  return field.optional && field.kind !== "message" ? `optional ${element}` : element;
}

const INT64: ReadonlySet<ScalarName> = new Set(["int64", "uint64", "sint64", "fixed64", "sfixed64"]);
const NUMBER: ReadonlySet<ScalarName> = new Set(["int32", "uint32", "sint32", "fixed32", "sfixed32", "float", "double"]);

/** 64-bit integers are strings in proto3 JSON so they survive JavaScript numbers. */
export function isInt64(scalar: ScalarName): boolean {
  return INT64.has(scalar);
}

export function isNumber(scalar: ScalarName): boolean {
  return NUMBER.has(scalar);
}

function exampleScalar(scalar: ScalarName): Json {
  if (scalar === "bool") return false;
  if (scalar === "string") return "";
  if (scalar === "bytes") return "";
  if (isInt64(scalar)) return "0";
  return 0;
}

function exampleElement(field: FieldInfo, closure: TypeClosure, depth: number, seen: Set<string>): Json {
  if (field.kind === "scalar") return exampleScalar(field.scalar ?? "string");
  if (field.kind === "enum") return closure.enums[field.typeName ?? ""]?.values[0]?.name ?? 0;
  const wkt = wellKnown(field.typeName);
  if (wkt !== null) {
    switch (wkt.kind) {
      case "timestamp":
        return new Date().toISOString();
      case "duration":
        return "1s";
      case "fieldmask":
        return "";
      case "empty":
        return {};
      case "json":
        return {};
      case "wrapper":
        return exampleScalar(wkt.scalar);
    }
  }
  return exampleMessage(field.typeName ?? "", closure, depth + 1, seen);
}

/** A filled-in skeleton: every field once, first oneof member only, recursion cut off. */
export function exampleMessage(typeName: string, closure: TypeClosure, depth = 0, seen = new Set<string>()): JsonObject {
  const message = closure.messages[typeName];
  if (message === undefined || depth > 4 || seen.has(typeName)) return {};
  seen.add(typeName);
  const result: JsonObject = {};
  const oneofsDone = new Set<string>();
  for (const field of message.fields) {
    if (field.deprecated) continue;
    if (field.oneof !== undefined) {
      if (oneofsDone.has(field.oneof)) continue;
      oneofsDone.add(field.oneof);
    }
    const element = exampleElement(field, closure, depth, seen);
    if (field.cardinality === "list") result[field.jsonName] = [element];
    else if (field.cardinality === "map") result[field.jsonName] = { [field.mapKey === "string" ? "key" : field.mapKey === "bool" ? "true" : "0"]: element };
    else result[field.jsonName] = element;
  }
  seen.delete(typeName);
  return result;
}

/** Reads a field by JSON name, falling back to the proto name, which grpcurl also accepts. */
export function readField(value: JsonObject, field: FieldInfo): Json | undefined {
  // Own properties only: a field named to_string must not read Object.prototype.toString.
  if (Object.hasOwn(value, field.jsonName)) return value[field.jsonName];
  return Object.hasOwn(value, field.name) ? value[field.name] : undefined;
}

export function writeField(value: JsonObject, field: FieldInfo, next: Json | undefined): JsonObject {
  const copy: JsonObject = { ...value };
  delete copy[field.name];
  if (next === undefined) delete copy[field.jsonName];
  else copy[field.jsonName] = next;
  return copy;
}

/**
 * Whether the JSON text holds an integer literal JavaScript cannot represent
 * exactly. The form edits parsed values, so such text stays in JSON mode
 * rather than having its digits silently rewritten.
 */
export function hasUnsafeIntegers(text: string): boolean {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index));
      if (match === null) continue;
      const literal = match[0];
      if (match[1] === undefined && match[2] === undefined && !Number.isSafeInteger(Number(literal))) return true;
      if (!Number.isFinite(Number(literal))) return true;
      index += literal.length - 1;
    }
  }
  return false;
}

export function formatJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
