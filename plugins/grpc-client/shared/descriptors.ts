import {
  ScalarType,
  createFileRegistry,
  fromBinary,
  getExtension,
  hasExtension,
  toBinary,
  type DescEnum,
  type DescField,
  type DescFile,
  type DescMessage,
  type DescMethod,
  type DescService,
  type FileRegistry,
} from "@bufbuild/protobuf";
import {
  FileDescriptorSetSchema,
  type DescriptorProto,
  type EnumDescriptorProto,
  type FileDescriptorProto,
  type FileDescriptorSet,
} from "@bufbuild/protobuf/wkt";
import { reflect } from "@bufbuild/protobuf/reflect";
import type { AuthRule, Endpoint } from "./config.js";
import type { EnumInfo, FieldInfo, MessageInfo, MethodInfo, ScalarName, ServiceInfo, TypeClosure } from "./schema.js";

const MAX_CLOSURE_TYPES = 400;

export function parseDescriptorSets(buffers: Uint8Array[]): FileDescriptorSet {
  const merged = fromBinary(FileDescriptorSetSchema, new Uint8Array());
  const seen = new Set<string>();
  for (const buffer of buffers) {
    for (const file of fromBinary(FileDescriptorSetSchema, buffer).file) {
      if (seen.has(file.name)) continue;
      seen.add(file.name);
      merged.file.push(file);
    }
  }
  return merged;
}

export function serializeDescriptorSet(set: FileDescriptorSet): Uint8Array {
  return toBinary(FileDescriptorSetSchema, set);
}

export function createRegistry(set: FileDescriptorSet): FileRegistry {
  return createFileRegistry(set);
}

// Source-info paths use descriptor.proto field numbers.
const FILE_MESSAGE = 4;
const FILE_ENUM = 5;
const FILE_SERVICE = 6;
const MESSAGE_FIELD = 2;
const MESSAGE_NESTED = 3;
const MESSAGE_ENUM = 4;
const ENUM_VALUE = 2;
const SERVICE_METHOD = 2;

const commentCache = new WeakMap<FileDescriptorProto, Map<string, string>>();

/** Leading (or trailing) comments keyed by fully-qualified element name, e.g. "pkg.Msg.field". */
function fileComments(file: FileDescriptorProto): Map<string, string> {
  const cached = commentCache.get(file);
  if (cached !== undefined) return cached;
  const byPath = new Map<string, string>();
  for (const location of file.sourceCodeInfo?.location ?? []) {
    const text = (location.leadingComments || location.trailingComments || "").trim();
    if (text !== "") byPath.set(location.path.join("."), text);
  }
  const comments = new Map<string, string>();
  const record = (name: string, path: number[]) => {
    const text = byPath.get(path.join("."));
    if (text !== undefined) comments.set(name, text);
  };
  const prefix = file.package === "" ? "" : `${file.package}.`;
  const walkEnum = (enumType: EnumDescriptorProto, name: string, path: number[]) => {
    record(name, path);
    enumType.value.forEach((value, index) => record(`${name}.${value.name}`, [...path, ENUM_VALUE, index]));
  };
  const walkMessage = (message: DescriptorProto, name: string, path: number[]) => {
    record(name, path);
    message.field.forEach((field, index) => record(`${name}.${field.name}`, [...path, MESSAGE_FIELD, index]));
    message.nestedType.forEach((nested, index) => walkMessage(nested, `${name}.${nested.name}`, [...path, MESSAGE_NESTED, index]));
    message.enumType.forEach((nested, index) => walkEnum(nested, `${name}.${nested.name}`, [...path, MESSAGE_ENUM, index]));
  };
  file.messageType.forEach((message, index) => walkMessage(message, `${prefix}${message.name}`, [FILE_MESSAGE, index]));
  file.enumType.forEach((enumType, index) => walkEnum(enumType, `${prefix}${enumType.name}`, [FILE_ENUM, index]));
  file.service.forEach((service, index) => {
    const name = `${prefix}${service.name}`;
    record(name, [FILE_SERVICE, index]);
    service.method.forEach((method, methodIndex) => record(`${name}.${method.name}`, [FILE_SERVICE, index, SERVICE_METHOD, methodIndex]));
  });
  commentCache.set(file, comments);
  return comments;
}

function commentFor(file: DescFile, name: string): string | undefined {
  return fileComments(file.proto).get(name);
}

function scalarName(scalar: ScalarType): ScalarName {
  return ScalarType[scalar].toLowerCase() as ScalarName;
}

function fieldInfo(field: DescField, parent: DescMessage): FieldInfo {
  const base = {
    name: field.name,
    jsonName: field.jsonName,
    number: field.number,
    deprecated: field.deprecated,
    oneof: field.oneof?.name,
    comment: commentFor(parent.file, `${parent.typeName}.${field.name}`),
  };
  switch (field.fieldKind) {
    case "scalar":
      return { ...base, kind: "scalar", scalar: scalarName(field.scalar), cardinality: "single", optional: field.presence !== 2 };
    case "enum":
      return { ...base, kind: "enum", typeName: field.enum.typeName, cardinality: "single", optional: field.presence !== 2 };
    case "message":
      return { ...base, kind: "message", typeName: field.message.typeName, cardinality: "single", optional: true };
    case "list":
      return {
        ...base,
        cardinality: "list",
        optional: false,
        ...(field.listKind === "scalar"
          ? { kind: "scalar" as const, scalar: scalarName(field.scalar) }
          : field.listKind === "enum"
            ? { kind: "enum" as const, typeName: field.enum.typeName }
            : { kind: "message" as const, typeName: field.message.typeName }),
      };
    case "map":
      return {
        ...base,
        cardinality: "map",
        optional: false,
        mapKey: scalarName(field.mapKey),
        ...(field.mapKind === "scalar"
          ? { kind: "scalar" as const, scalar: scalarName(field.scalar) }
          : field.mapKind === "enum"
            ? { kind: "enum" as const, typeName: field.enum.typeName }
            : { kind: "message" as const, typeName: field.message.typeName }),
      };
  }
}

export function messageInfo(message: DescMessage): MessageInfo {
  return {
    typeName: message.typeName,
    fields: message.fields.map((field) => fieldInfo(field, message)),
    oneofs: message.oneofs.map((oneof) => oneof.name),
    comment: commentFor(message.file, message.typeName),
  };
}

export function enumInfo(enumType: DescEnum): EnumInfo {
  return {
    typeName: enumType.typeName,
    values: enumType.values.map((value) => ({
      name: value.name,
      number: value.number,
      comment: commentFor(enumType.file, `${enumType.typeName}.${value.name}`),
    })),
    comment: commentFor(enumType.file, enumType.typeName),
  };
}

/** The message plus every message and enum reachable from its fields. */
export function typeClosure(registry: FileRegistry, root: string): TypeClosure {
  const closure: TypeClosure = { root, messages: {}, enums: {}, truncated: false };
  const start = registry.getMessage(root);
  if (start === undefined) throw new Error(`Unknown message type ${root}`);
  const queue: DescMessage[] = [start];
  while (queue.length > 0) {
    const message = queue.shift()!;
    if (closure.messages[message.typeName] !== undefined) continue;
    if (Object.keys(closure.messages).length >= MAX_CLOSURE_TYPES) {
      closure.truncated = true;
      break;
    }
    closure.messages[message.typeName] = messageInfo(message);
    for (const field of message.fields) {
      const nested = field.message;
      const enumType = field.enum;
      if (nested !== undefined && closure.messages[nested.typeName] === undefined) queue.push(nested);
      if (enumType !== undefined && closure.enums[enumType.typeName] === undefined) closure.enums[enumType.typeName] = enumInfo(enumType);
    }
  }
  return closure;
}

type OptionHolder = DescMethod | DescService;

/** The value of one field of a custom option, rendered as the enum value name or scalar string. */
function optionFieldValue(registry: FileRegistry, holder: OptionHolder, extensionName: string, fieldName: string): string | undefined {
  const options = holder.proto.options;
  const extension = registry.getExtension(extensionName);
  if (options === undefined || extension === undefined) return undefined;
  if (!hasExtension(options, extension)) return undefined;
  const value = getExtension(options, extension) as unknown;
  if (extension.fieldKind === "enum") {
    return extension.enum.values.find((candidate) => candidate.number === value)?.name ?? String(value);
  }
  if (extension.fieldKind === "scalar") return String(value);
  if (extension.fieldKind !== "message") return undefined;
  const field = extension.message.fields.find((candidate) => candidate.name === fieldName || candidate.jsonName === fieldName);
  if (field === undefined) return undefined;
  // An option that leaves the selector field unset must fall through to the service option.
  const option = reflect(extension.message, value as never);
  if (!option.isSet(field)) return undefined;
  const raw = option.get(field) as unknown;
  if (field.fieldKind === "enum") return field.enum.values.find((candidate) => candidate.number === raw)?.name ?? String(raw);
  return field.fieldKind === "scalar" ? String(raw) : undefined;
}

export function resolveAuth(
  registry: FileRegistry,
  method: DescMethod,
  rules: AuthRule[],
  endpoint: Endpoint,
): { auth: string | null; reason: string | null } {
  if (endpoint.auth !== undefined) {
    return endpoint.auth === "none" ? { auth: null, reason: "disabled for endpoint" } : { auth: endpoint.auth, reason: "endpoint" };
  }
  for (const rule of rules) {
    const fromMethod = rule.methodOption ? optionFieldValue(registry, method, rule.methodOption, rule.field) : undefined;
    const value = fromMethod ?? (rule.serviceOption ? optionFieldValue(registry, method.parent, rule.serviceOption, rule.field) : undefined);
    if (value === undefined) continue;
    const where = fromMethod !== undefined ? "method option" : "service option";
    if (!Object.hasOwn(rule.profiles, value)) return { auth: null, reason: `${value} (${where}, no profile mapped)` };
    return { auth: rule.profiles[value] ?? null, reason: `${value} (${where})` };
  }
  return { auth: null, reason: null };
}

export function listServices(registry: FileRegistry, rules: AuthRule[], endpoint: Endpoint): ServiceInfo[] {
  const services: ServiceInfo[] = [];
  for (const file of registry.files) {
    for (const service of file.services) {
      services.push({
        typeName: service.typeName,
        comment: commentFor(file, service.typeName),
        methods: service.methods.map((method): MethodInfo => {
          const { auth, reason } = resolveAuth(registry, method, rules, endpoint);
          return {
            name: method.name,
            fullName: `${service.typeName}/${method.name}`,
            input: method.input.typeName,
            output: method.output.typeName,
            kind: method.methodKind,
            deprecated: method.deprecated,
            comment: commentFor(file, `${service.typeName}.${method.name}`),
            auth,
            authReason: reason,
          };
        }),
      });
    }
  }
  return services.sort((a, b) => a.typeName.localeCompare(b.typeName));
}

export function findMethod(registry: FileRegistry, fullName: string): DescMethod | undefined {
  const separator = fullName.includes("/") ? fullName.lastIndexOf("/") : fullName.lastIndexOf(".");
  const service = registry.getService(fullName.slice(0, separator));
  return service?.methods.find((method) => method.name === fullName.slice(separator + 1));
}
