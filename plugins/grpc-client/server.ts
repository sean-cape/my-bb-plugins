import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { callResultSchema, hostContract, metadataEntrySchema, type CallResult, type Launch, type MetadataEntry } from "./contract.js";
import {
  SOURCE_KINDS,
  authSchema,
  endpointSchema,
  endpointsSchema,
  headerNameSchema,
  jsonSettingValidator,
  parseJsonSetting,
  profileSchema,
  resolveSourceName,
  sourceSchema,
  sourcesSchema,
  transportSchema,
  withBuiltinSources,
  type AuthConfig,
  type Endpoint,
  type Source,
} from "./shared/config.js";
import {
  descriptorStateSchema,
  matchMethods,
  serviceInfoSchema,
  typeClosureSchema,
  type MessageInfo,
  type ServiceInfo,
  type TypeClosure,
} from "./shared/schema.js";

export type { CallResult, MetadataEntry } from "./contract.js";
export type { FieldInfo, MessageInfo, EnumInfo, MethodInfo, ServiceInfo, TypeClosure, DescriptorState } from "./shared/schema.js";

const endpointSummarySchema = z.object({
  name: z.string(),
  target: z.string(),
  transport: transportSchema,
  description: z.string().nullable(),
  source: z.string(),
  protected: z.boolean(),
});
export type EndpointSummary = z.infer<typeof endpointSummarySchema>;

const overviewSchema = z.object({
  endpoints: z.array(endpointSummarySchema),
  sources: z.array(z.object({ name: z.string(), kind: z.string() })),
  profiles: z.array(z.string()),
  timeoutSeconds: z.number(),
  errors: z.array(z.string()),
});
export type Overview = z.infer<typeof overviewSchema>;

const historyEntrySchema = z.object({
  id: z.number(),
  at: z.number(),
  origin: z.string(),
  endpoint: z.string(),
  source: z.string(),
  method: z.string(),
  request: z.string(),
  metadata: z.array(metadataEntrySchema),
  ok: z.boolean(),
  status: z.string(),
  message: z.string(),
  durationMs: z.number(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

const target = { endpoint: z.string(), source: z.string().optional() };
const callInput = z.object({
  ...target,
  method: z.string().min(1),
  request: z.string(),
  metadata: z.array(metadataEntrySchema).default([]),
  timeoutSeconds: z.number().min(0.1).max(3600).optional(),
});

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: overviewSchema },
  services: {
    input: z.object({ ...target, reload: z.boolean().default(false) }),
    output: z.object({ source: z.string(), state: descriptorStateSchema, services: z.array(serviceInfoSchema) }),
  },
  types: { input: z.object({ ...target, typeName: z.string().min(1) }), output: typeClosureSchema },
  invoke: { input: callInput, output: callResultSchema },
  command: { input: callInput, output: z.object({ command: z.string() }) },
  history: {
    input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
    output: z.object({ entries: z.array(historyEntrySchema) }),
  },
  clearHistory: { input: z.null(), output: z.object({ cleared: z.number() }) },
  resetAuth: { input: z.null(), output: z.object({ cleared: z.number() }) },
});

/** Realtime channel the page refetches on. */
const CHANGED = "changed";
const HISTORY_LIMIT = 500;
const SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api-?key|session|auth|jwt|assertion/i;
// Worst cases on the host: a descriptor build, and a token command + refresh + command, each of
// which may wait on an interactive SSO login.
const AUTH_TIMEOUT_MS = 3 * 120_000 + 30_000;
const DESCRIPTOR_TIMEOUT_MS = 120_000 + AUTH_TIMEOUT_MS;
const DEFAULT_AUTH = JSON.stringify({ profiles: {}, rules: [] }, null, 2);

interface Config {
  tools: Launch["tools"];
  defaultSource: string;
  timeoutSeconds: number;
  endpoints: Endpoint[];
  sources: Source[];
  auth: AuthConfig;
  errors: string[];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    grpcurl: { type: "string", label: "grpcurl executable", description: "Name on PATH or absolute path.", default: "grpcurl" },
    buf: { type: "string", label: "buf executable", description: 'Used by "buf" proto sources.', default: "buf" },
    defaultSource: {
      type: "string",
      label: "Default proto source",
      description: 'Source used when an endpoint names none. "reflection" is always available.',
      default: "reflection",
    },
    timeoutSeconds: {
      type: "number",
      label: "Default call timeout (seconds)",
      experimental_schema: z.number().min(0.1).max(3600),
      default: 30,
    },
    endpoints: {
      type: "string",
      label: "Endpoints",
      description:
        'JSON array of {name, target, transport?: "tls"|"plaintext"|"insecure", source?, headers?, auth?: profile|"none", vars?, args?, protected?, description?}.',
      experimental_multiline: true,
      experimental_schema: jsonSettingValidator(endpointsSchema, "endpoints"),
      default: "[]",
    },
    sources: {
      type: "string",
      label: "Proto sources",
      description:
        'JSON array of {name, kind}: "reflection"; "protoDir" {path, scan?, importPaths?}; "protoFiles" {files, importPaths}; "protoset" {files}; "buf" {path, args?}.',
      experimental_multiline: true,
      experimental_schema: jsonSettingValidator(sourcesSchema, "sources"),
      default: "[]",
    },
    auth: {
      type: "string",
      label: "Auth",
      description:
        'JSON {profiles: {name: {header?, command, refreshCommand?, prefix?, refreshSeconds?, vars?}}, rules: [{methodOption?, serviceOption?, field, profiles: {value: profile|null}}]}.',
      experimental_multiline: true,
      experimental_schema: jsonSettingValidator(authSchema, "auth", "{}"),
      default: DEFAULT_AUTH,
    },
  });
  settings.onChange(() => bb.realtime.publish(CHANGED, { reason: "config" }));

  const host = bb.hosts.experimental_client({ contract: hostContract });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      origin TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      source TEXT NOT NULL,
      method TEXT NOT NULL,
      request TEXT NOT NULL,
      metadata TEXT NOT NULL,
      ok INTEGER NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    )`,
  ]);

  async function hostId(): Promise<string> {
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) throw new Error("The bb server machine is not connected yet.");
    return primaryHostId;
  }

  async function loadConfig(): Promise<Config> {
    const values = await settings.get();
    const endpoints = parseJsonSetting(values.endpoints, endpointsSchema, "endpoints");
    const sources = parseJsonSetting(values.sources, sourcesSchema, "sources");
    const auth = parseJsonSetting(values.auth, authSchema, "auth", "{}");
    const errors = [endpoints, sources, auth].flatMap((result) => (result.ok ? [] : [result.error]));
    if (endpoints.ok && auth.ok) {
      for (const endpoint of endpoints.value) {
        if (endpoint.auth !== undefined && endpoint.auth !== "none" && auth.value.profiles[endpoint.auth] === undefined) {
          errors.push(`endpoint "${endpoint.name}" uses unknown auth profile "${endpoint.auth}"`);
        }
      }
      for (const rule of auth.value.rules) {
        for (const profile of Object.values(rule.profiles)) {
          if (profile !== null && auth.value.profiles[profile] === undefined) errors.push(`auth rule maps to unknown profile "${profile}"`);
        }
      }
    }
    return {
      tools: { grpcurl: values.grpcurl.trim() || "grpcurl", buf: values.buf.trim() || "buf" },
      defaultSource: values.defaultSource.trim() || "reflection",
      timeoutSeconds: values.timeoutSeconds,
      endpoints: endpoints.ok ? endpoints.value : [],
      sources: withBuiltinSources(sources.ok ? sources.value : []),
      auth: auth.ok ? auth.value : { profiles: {}, rules: [] },
      errors,
    };
  }

  function resolveLaunch(config: Config, endpointName: string, sourceName: string | undefined): Launch {
    const endpoint = config.endpoints.find((candidate) => candidate.name === endpointName);
    if (endpoint === undefined) {
      throw new PluginCliError(`Unknown endpoint "${endpointName}"`, { code: "unknown_endpoint", hint: "Run `bb grpc list` to see endpoints." });
    }
    const name = resolveSourceName(endpoint, sourceName, config.defaultSource);
    const source = config.sources.find((candidate) => candidate.name === name);
    if (source === undefined) {
      throw new PluginCliError(`Unknown proto source "${name}"`, { code: "unknown_source", hint: "Run `bb grpc list` to see sources." });
    }
    return { endpoint, source, auth: config.auth, tools: config.tools };
  }

  async function services(endpoint: string, source: string | undefined, reload: boolean) {
    const launch = resolveLaunch(await loadConfig(), endpoint, source);
    const result = await host.call("services", { ...launch, reload }, { hostId: await hostId(), timeoutMs: DESCRIPTOR_TIMEOUT_MS });
    return { source: launch.source.name, ...result };
  }

  async function types(endpoint: string, source: string | undefined, typeName: string): Promise<TypeClosure> {
    const launch = resolveLaunch(await loadConfig(), endpoint, source);
    return host.call("types", { ...launch, typeName }, { hostId: await hostId(), timeoutMs: DESCRIPTOR_TIMEOUT_MS });
  }

  /** History never stores credentials: values of auth, endpoint and credential-looking headers are masked. */
  function maskMetadata(config: Config, endpoint: Endpoint, metadata: MetadataEntry[]): MetadataEntry[] {
    const secret = new Set([...Object.values(config.auth.profiles).map((profile) => profile.header), ...Object.keys(endpoint.headers)]);
    return metadata.map(({ name, value }) => ({ name, value: secret.has(name) || SENSITIVE_HEADER.test(name) ? "***" : value }));
  }

  function record(origin: string, config: Config, launch: Launch, input: z.infer<typeof callInput>, result: CallResult) {
    db.prepare(
      `INSERT INTO calls (at, origin, endpoint, source, method, request, metadata, ok, status, message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      origin,
      launch.endpoint.name,
      launch.source.name,
      input.method,
      input.request,
      JSON.stringify(maskMetadata(config, launch.endpoint, input.metadata)),
      result.ok ? 1 : 0,
      result.status.name,
      (result.error ?? result.status.message).slice(0, 2000),
      result.durationMs,
    );
    db.prepare(`DELETE FROM calls WHERE id <= (SELECT id FROM calls ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(HISTORY_LIMIT);
    bb.realtime.publish(CHANGED, { reason: "history" });
  }

  async function invoke(origin: string, input: z.infer<typeof callInput>): Promise<CallResult> {
    const config = await loadConfig();
    const launch = resolveLaunch(config, input.endpoint, input.source);
    const timeoutSeconds = input.timeoutSeconds ?? config.timeoutSeconds;
    const result = await host.call(
      "invoke",
      { ...launch, method: input.method, request: input.request, metadata: input.metadata, timeoutSeconds },
      { hostId: await hostId(), timeoutMs: timeoutSeconds * 1000 + DESCRIPTOR_TIMEOUT_MS + AUTH_TIMEOUT_MS },
    );
    try {
      record(origin, config, launch, input, result);
    } catch (error) {
      // The call already happened; losing its history row must not make it look failed.
      bb.log.warn(`Could not record call history: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  async function copyCommand(input: z.infer<typeof callInput>): Promise<string> {
    const config = await loadConfig();
    const launch = resolveLaunch(config, input.endpoint, input.source);
    const timeoutSeconds = input.timeoutSeconds ?? config.timeoutSeconds;
    const { command } = await host.call(
      "command",
      { ...launch, method: input.method, request: input.request, metadata: input.metadata, timeoutSeconds },
      { hostId: await hostId(), timeoutMs: DESCRIPTOR_TIMEOUT_MS },
    );
    return command;
  }

  function history(limit: number): HistoryEntry[] {
    const rows = db
      .prepare(
        `SELECT id, at, origin, endpoint, source, method, request, metadata, ok, status, message, duration_ms
         FROM calls ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      at: number;
      origin: string;
      endpoint: string;
      source: string;
      method: string;
      request: string;
      metadata: string;
      ok: number;
      status: string;
      message: string;
      duration_ms: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      origin: row.origin,
      endpoint: row.endpoint,
      source: row.source,
      method: row.method,
      request: row.request,
      metadata: JSON.parse(row.metadata) as MetadataEntry[],
      ok: row.ok === 1,
      status: row.status,
      message: row.message,
      durationMs: row.duration_ms,
    }));
  }

  async function resetAuth(): Promise<number> {
    return (await host.call("resetAuth", null, { hostId: await hostId() })).cleared;
  }

  bb.rpc.register(rpcContract, {
    async overview() {
      const config = await loadConfig();
      return {
        endpoints: config.endpoints.map((endpoint) => ({
          name: endpoint.name,
          target: endpoint.target,
          transport: endpoint.transport,
          description: endpoint.description ?? null,
          source: resolveSourceName(endpoint, undefined, config.defaultSource),
          protected: endpoint.protected,
        })),
        sources: config.sources.map((source) => ({ name: source.name, kind: source.kind })),
        profiles: Object.keys(config.auth.profiles),
        timeoutSeconds: config.timeoutSeconds,
        errors: config.errors,
      };
    },
    services: ({ endpoint, source, reload }) => services(endpoint, source, reload),
    types: ({ endpoint, source, typeName }) => types(endpoint, source, typeName),
    invoke: (input) => invoke("ui", input),
    command: async (input) => ({ command: await copyCommand(input) }),
    history: ({ limit }) => ({ entries: history(limit) }),
    clearHistory: () => ({ cleared: db.prepare(`DELETE FROM calls`).run().changes }),
    resetAuth: async () => ({ cleared: await resetAuth() }),
  });

  /** Edits one JSON setting in its raw form so schema defaults are not written back out. */
  let settingEdits: Promise<unknown> = Promise.resolve();

  /** Serialized so concurrent CLI edits cannot overwrite each other's read-modify-write. */
  function editSetting<T>(key: "endpoints" | "sources" | "auth", edit: (raw: T) => T): Promise<void> {
    const next = settingEdits.then(() => applySettingEdit(key, edit));
    settingEdits = next.catch(() => {});
    return next;
  }

  async function applySettingEdit<T>(key: "endpoints" | "sources" | "auth", edit: (raw: T) => T): Promise<void> {
    const values = await settings.get();
    const raw = values[key];
    const empty = key === "auth" ? "{}" : "[]";
    const schema = key === "endpoints" ? endpointsSchema : key === "sources" ? sourcesSchema : authSchema;
    const current = parseJsonSetting<unknown>(raw, schema, key, empty);
    if (!current.ok) {
      throw new PluginCliError(current.error, {
        code: "invalid_config",
        hint: `Fix it with \`bb plugin config ${bb.pluginId} set ${key} '<json>'\` or in Settings.`,
      });
    }
    const next = edit(JSON.parse(raw.trim() === "" ? empty : raw) as T);
    const checked = schema.safeParse(next);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new PluginCliError(`${key}${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message}`, { code: "invalid_value" });
    }
    await settings.experimental_set({ [key]: JSON.stringify(next, null, 2) });
  }

  type Named = Record<string, unknown> & { name?: unknown };
  function upsert(name: string, value: Named, replace: boolean, label: string) {
    return (items: Named[]) => {
      const index = items.findIndex((item) => item.name === name);
      if (index === -1) return [...items, value];
      if (!replace) throw new PluginCliError(`${label} "${name}" already exists`, { code: "exists", hint: "Pass --replace to overwrite it." });
      return items.map((item, position) => (position === index ? value : item));
    };
  }
  function remove(name: string, label: string) {
    return (items: Named[]) => {
      if (!items.some((item) => item.name === name)) throw new PluginCliError(`No ${label} named "${name}"`, { code: "not_found" });
      return items.filter((item) => item.name !== name);
    };
  }

  function parsePair(raw: string, separator: ":" | "="): [string, string] {
    const index = raw.indexOf(separator);
    if (index <= 0) throw new PluginCliError(`Expected "name${separator}value", got "${raw}"`, { code: "invalid_value" });
    return [raw.slice(0, index).trim(), raw.slice(index + 1).trim()];
  }

  const OUTPUT_LIMIT = PLUGIN_CLI_OUTPUT_MAX_BYTES - 4096;

  function bounded(text: string): string {
    if (Buffer.byteLength(text) <= OUTPUT_LIMIT) return text;
    return `${Buffer.from(text).subarray(0, OUTPUT_LIMIT).toString("utf8")}\n… (output truncated)`;
  }

  /** Truncated JSON would be unparseable, so oversized JSON output is an error instead. */
  function boundedJson(value: unknown): string {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) <= OUTPUT_LIMIT) return text;
    throw new PluginCliError(`JSON output is ${Buffer.byteLength(text)} bytes, over the ${OUTPUT_LIMIT}-byte CLI limit`, {
      code: "output_too_large",
      hint: "Narrow it (e.g. --filter), or drop --json for truncated text output.",
    });
  }

  function describeMessage(message: MessageInfo, closure: TypeClosure, indent: string, seen: Set<string>, lines: string[]) {
    for (const field of message.fields) {
      const type = field.kind === "scalar" ? field.scalar! : field.typeName!;
      const shape =
        field.cardinality === "map" ? `map<${field.mapKey}, ${type}>` : field.cardinality === "list" ? `repeated ${type}` : field.optional && field.kind !== "message" ? `optional ${type}` : type;
      const extra = [field.oneof ? `oneof ${field.oneof}` : "", field.deprecated ? "deprecated" : ""].filter(Boolean).join(", ");
      lines.push(`${indent}${field.jsonName}: ${shape}${extra ? ` (${extra})` : ""}${field.comment ? `  // ${field.comment.split("\n")[0]}` : ""}`);
      if (field.kind === "enum" && field.typeName && closure.enums[field.typeName]) {
        lines.push(`${indent}  values: ${closure.enums[field.typeName]!.values.map((value) => value.name).join(" | ")}`);
      }
      const nested = field.kind === "message" && field.typeName ? closure.messages[field.typeName] : undefined;
      if (nested !== undefined && !field.typeName!.startsWith("google.protobuf.") && !seen.has(nested.typeName) && indent.length < 16) {
        seen.add(nested.typeName);
        describeMessage(nested, closure, `${indent}  `, seen, lines);
        seen.delete(nested.typeName);
      }
    }
  }

  function findServiceMethod(list: ServiceInfo[], name: string) {
    const matches = matchMethods(list.flatMap((service) => service.methods), name);
    if (matches.length > 1) {
      throw new PluginCliError(`"${name}" matches ${matches.length} methods: ${matches.map((method) => method.fullName).join(", ")}`, {
        code: "ambiguous_method",
        hint: "Pass the full pkg.Service/Method name.",
      });
    }
    return matches[0];
  }

  const json = { type: "boolean", description: "Emit machine-readable JSON" } as const;
  const sourceOption = { type: "string", description: "Proto source to use instead of the endpoint's default" } as const;
  const replace = { type: "boolean", description: "Overwrite an existing entry with the same name" } as const;

  bb.cli.register(
    defineCli({
      name: "grpc",
      summary: "Call gRPC endpoints with grpcurl, using named endpoints, proto sources and auth profiles",
      description:
        "Endpoints, proto sources and auth profiles live in the gRPC plugin settings. The gRPC page in the sidebar is the interactive client; these commands are the scriptable one.",
      commands: {
        list: cliCommand({
          summary: "List endpoints, proto sources and auth profiles",
          options: { json },
          async run({ options }) {
            const config = await loadConfig();
            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ endpoints: config.endpoints, sources: config.sources, profiles: Object.keys(config.auth.profiles), errors: config.errors }),
              };
            }
            const lines = config.errors.map((error) => `! ${error}`);
            lines.push("Endpoints:");
            if (config.endpoints.length === 0) lines.push("  (none — add one with `bb grpc endpoint add`)");
            for (const endpoint of config.endpoints) {
              const flags = [endpoint.transport, `source=${resolveSourceName(endpoint, undefined, config.defaultSource)}`];
              if (endpoint.auth) flags.push(`auth=${endpoint.auth}`);
              if (endpoint.protected) flags.push("protected");
              lines.push(`  ${endpoint.name}  ${endpoint.target}  ${flags.join("  ")}`);
            }
            lines.push("Sources:");
            for (const source of config.sources) {
              const where = "path" in source ? `  ${source.path}` : "files" in source ? `  ${source.files.join(", ")}` : "";
              lines.push(`  ${source.name}  ${source.kind}${where}`);
            }
            lines.push(`Auth profiles: ${Object.keys(config.auth.profiles).join(", ") || "(none)"}; ${config.auth.rules.length} option rule(s)`);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),

        methods: cliCommand({
          summary: "List the services and methods an endpoint exposes",
          positionals: [{ name: "endpoint", description: "Endpoint name", required: true }],
          options: {
            source: sourceOption,
            filter: { type: "string", description: "Case-insensitive substring of the service or method name" },
            reload: { type: "boolean", description: "Rebuild the descriptor cache first" },
            json,
          },
          async run({ positionals, options }) {
            const result = await services(positionals.endpoint, options.source, options.reload);
            const needle = options.filter?.toLowerCase();
            const methods = result.services
              .flatMap((service) => service.methods)
              .filter((method) => needle === undefined || method.fullName.toLowerCase().includes(needle));
            if (options.json) return { exitCode: 0, stdout: boundedJson({ state: result.state, methods }) };
            const lines = methods.map((method) => {
              const tags = [method.kind === "unary" ? "" : method.kind.replace("_", " "), method.auth ? `auth=${method.auth}` : "", method.deprecated ? "deprecated" : ""].filter(Boolean);
              return `${method.fullName}${tags.length ? `  [${tags.join(", ")}]` : ""}`;
            });
            lines.push(`${methods.length} method(s) from ${result.state.fileCount} files (source ${result.source})`);
            return { exitCode: 0, stdout: bounded(lines.join("\n")) };
          },
        }),

        describe: cliCommand({
          summary: "Show a method's request shape, or a message type's fields",
          positionals: [
            { name: "endpoint", description: "Endpoint name", required: true },
            { name: "symbol", description: "Method (pkg.Service/Method or a unique Method name) or fully-qualified message", required: true },
          ],
          options: { source: sourceOption, json },
          async run({ positionals, options }) {
            const list = await services(positionals.endpoint, options.source, false);
            const method = findServiceMethod(list.services, positionals.symbol);
            const typeName = method?.input ?? positionals.symbol;
            const closure = await types(positionals.endpoint, options.source, typeName).catch((error: unknown) => {
              if (!(error instanceof Error) || !error.message.includes("Unknown message type")) throw error;
              throw new PluginCliError(`No method or message named "${positionals.symbol}"`, {
                code: "not_found",
                hint: `Run \`bb grpc methods ${positionals.endpoint} --filter <text>\` to find it.`,
              });
            });
            if (options.json) return { exitCode: 0, stdout: boundedJson({ method: method ?? null, types: closure }) };
            const lines: string[] = [];
            if (method !== undefined) {
              lines.push(`${method.fullName}  (${method.kind.replace("_", " ")})`);
              if (method.comment) lines.push(...method.comment.split("\n").map((line) => `// ${line}`));
              lines.push(`auth: ${method.auth ?? "none"}${method.authReason ? ` — ${method.authReason}` : ""}`);
              lines.push(`request ${method.input}:`);
            } else {
              lines.push(`${typeName}:`);
            }
            const root = closure.messages[closure.root]!;
            describeMessage(root, closure, "  ", new Set([root.typeName]), lines);
            if (method !== undefined) lines.push(`response ${method.output}`);
            return { exitCode: 0, stdout: bounded(lines.join("\n")) };
          },
        }),

        call: cliCommand({
          summary: "Call a method; prints the response JSON",
          positionals: [
            { name: "endpoint", description: "Endpoint name", required: true },
            { name: "method", description: "pkg.Service/Method, or a Method name unique on the endpoint", required: true },
          ],
          options: {
            data: { type: "string", stdin: true, description: "Request JSON (object; for client streaming an array). Default {}. --data-stdin reads it from stdin" },
            header: { type: "string", repeatable: true, short: "H", description: "Extra metadata 'name: value' (repeatable); overrides auth and endpoint headers" },
            timeout: { type: "duration", defaultUnit: "s", min: 100, max: 3_600_000, description: "Call deadline (default from settings, 30s)" },
            source: sourceOption,
            yes: { type: "boolean", description: "Required to call an endpoint marked protected" },
            json: { type: "boolean", description: "Print the full result (status, headers, trailers, responses) as JSON" },
          },
          async run({ positionals, options }) {
            const config = await loadConfig();
            const endpoint = config.endpoints.find((candidate) => candidate.name === positionals.endpoint);
            if (endpoint?.protected && !options.yes) {
              throw new PluginCliError(`Endpoint "${endpoint.name}" is protected`, {
                code: "confirmation_required",
                hint: "Confirm with the user, then pass --yes.",
              });
            }
            const list = await services(positionals.endpoint, options.source, false);
            const method = findServiceMethod(list.services, positionals.method);
            if (method === undefined) {
              throw new PluginCliError(`No unique method "${positionals.method}" on ${positionals.endpoint}`, {
                code: "not_found",
                hint: `Run \`bb grpc methods ${positionals.endpoint} --filter ${positionals.method.split(/[/.]/).pop()}\`.`,
              });
            }
            const result = await invoke("cli", {
              endpoint: positionals.endpoint,
              source: options.source,
              method: method.fullName,
              request: options.data ?? "{}",
              metadata: options.header.map((raw) => {
                const [name, value] = parsePair(raw, ":");
                if (!headerNameSchema.safeParse(name.toLowerCase()).success) {
                  throw new PluginCliError(`Invalid header name "${name}"`, { code: "invalid_value", hint: "Use letters, digits, '_', '.' or '-'." });
                }
                return { name: name.toLowerCase(), value };
              }),
              timeoutSeconds: options.timeout === undefined ? undefined : options.timeout / 1000,
            });
            if (options.json) return { exitCode: result.ok ? 0 : 1, stdout: boundedJson(result) };
            const body = result.responses.map((response) => (typeof response === "string" ? response : JSON.stringify(response, null, 2))).join("\n");
            if (result.ok) return { exitCode: 0, stdout: bounded(body || "{}") };
            const detail = result.error ?? `${result.status.name}: ${result.status.message}`;
            const details = result.status.details.length > 0 ? `\ndetails: ${JSON.stringify(result.status.details)}` : "";
            return { exitCode: 1, stdout: body ? bounded(body) : undefined, stderr: `${detail}${details}` };
          },
        }),

        command: cliCommand({
          summary: "Print an equivalent grpcurl command (auth tokens stay as $(...) substitutions)",
          positionals: [
            { name: "endpoint", description: "Endpoint name", required: true },
            { name: "method", description: "pkg.Service/Method", required: true },
          ],
          options: { data: { type: "string", description: "Request JSON (default {})" }, source: sourceOption },
          async run({ positionals, options }) {
            const list = await services(positionals.endpoint, options.source, false);
            const method = findServiceMethod(list.services, positionals.method);
            if (method === undefined) throw new PluginCliError(`No unique method "${positionals.method}"`, { code: "not_found" });
            const command = await copyCommand({
              endpoint: positionals.endpoint,
              source: options.source,
              method: method.fullName,
              request: options.data ?? "{}",
              metadata: [],
            });
            return { exitCode: 0, stdout: command };
          },
        }),

        history: cliCommand({
          summary: "Show recent calls from the UI and CLI",
          options: { limit: { type: "integer", min: 1, max: 500, default: 20, description: "Entries to show (max 500)" }, json },
          async run({ options }) {
            const entries = history(options.limit);
            if (options.json) return { exitCode: 0, stdout: boundedJson({ entries }) };
            if (entries.length === 0) return { exitCode: 0, stdout: "No calls yet." };
            return {
              exitCode: 0,
              stdout: entries
                .map((entry) => `${new Date(entry.at).toISOString()}  ${entry.endpoint}  ${entry.method}  ${entry.status}  ${entry.durationMs}ms  (${entry.origin})`)
                .join("\n"),
            };
          },
        }),

        "auth reset": cliCommand({
          summary: "Forget cached auth tokens so the next call runs the profile commands again",
          async run() {
            return { exitCode: 0, stdout: `Cleared ${await resetAuth()} cached token(s).` };
          },
        }),

        "endpoint add": cliCommand({
          summary: "Add or replace a named endpoint",
          positionals: [{ name: "name", description: "Endpoint name, e.g. local, dev, staging, prod", required: true }],
          options: {
            target: { type: "string", required: true, description: "host:port of the gRPC server" },
            transport: { type: "enum", values: transportSchema.options, default: "tls", description: "tls (default), plaintext, or insecure (TLS without verification)" },
            source: { type: "string", description: "Default proto source" },
            auth: { type: "string", description: 'Auth profile for every method (overrides option rules), or "none"' },
            var: { type: "string", repeatable: true, description: "Placeholder value for auth commands, 'name=value' (repeatable)" },
            header: { type: "string", repeatable: true, description: "Static metadata 'name: value' (repeatable)" },
            arg: { type: "string", repeatable: true, description: "Extra grpcurl flag (repeatable; use --arg=-flag)" },
            protected: { type: "boolean", description: "Require confirmation before every call (for prod)" },
            description: { type: "string", description: "Free-form note shown in the UI" },
            replace,
          },
          async run({ positionals, options }) {
            const entry: Named = { name: positionals.name, target: options.target };
            if (options.transport !== "tls") entry.transport = options.transport;
            if (options.source !== undefined) entry.source = options.source;
            if (options.auth !== undefined) entry.auth = options.auth;
            if (options.var.length > 0) entry.vars = Object.fromEntries(options.var.map((raw) => parsePair(raw, "=")));
            if (options.header.length > 0) {
              entry.headers = Object.fromEntries(options.header.map((raw) => parsePair(raw, ":")).map(([name, value]) => [name.toLowerCase(), value]));
            }
            if (options.arg.length > 0) entry.args = options.arg;
            if (options.protected) entry.protected = true;
            if (options.description !== undefined) entry.description = options.description;
            const parsed = endpointSchema.safeParse(entry);
            if (!parsed.success) throw new PluginCliError(parsed.error.issues[0]?.message ?? "Invalid endpoint", { code: "invalid_value" });
            await editSetting<Named[]>("endpoints", upsert(positionals.name, entry, options.replace, "Endpoint"));
            return { exitCode: 0, stdout: `Saved endpoint ${positionals.name} → ${options.target}` };
          },
        }),

        "endpoint remove": cliCommand({
          summary: "Remove a named endpoint",
          positionals: [{ name: "name", description: "Endpoint name", required: true }],
          async run({ positionals }) {
            await editSetting<Named[]>("endpoints", remove(positionals.name, "endpoint"));
            return { exitCode: 0, stdout: `Removed endpoint ${positionals.name}` };
          },
        }),

        "source add": cliCommand({
          summary: "Add or replace a named proto source",
          positionals: [{ name: "name", description: "Source name", required: true }],
          options: {
            kind: { type: "enum", values: SOURCE_KINDS, required: true, description: "reflection, protoDir, protoFiles, protoset, or buf" },
            path: { type: "string", description: "protoDir root or buf input (absolute or ~/)" },
            file: { type: "string", repeatable: true, description: "protoFiles/protoset file (repeatable)" },
            "import-path": { type: "string", repeatable: true, description: "Import path (repeatable)" },
            scan: { type: "string", repeatable: true, description: "protoDir: only scan these root-relative subdirectories (repeatable)" },
            arg: { type: "string", repeatable: true, description: "buf: extra `buf build` flag (repeatable)" },
            replace,
          },
          async run({ positionals, options }) {
            const entry: Named = { name: positionals.name, kind: options.kind };
            if (options.path !== undefined) entry.path = options.path;
            if (options.file.length > 0) entry.files = options.file;
            if (options["import-path"].length > 0) entry.importPaths = options["import-path"];
            if (options.scan.length > 0) entry.scan = options.scan;
            if (options.arg.length > 0) entry.args = options.arg;
            const parsed = sourceSchema.safeParse(entry);
            if (!parsed.success) {
              const issue = parsed.error.issues[0];
              throw new PluginCliError(`${issue?.path.join(".") || "source"}: ${issue?.message ?? "invalid"}`, {
                code: "invalid_value",
                hint: "Run `bb grpc source add --help` for which options each kind takes.",
              });
            }
            await editSetting<Named[]>("sources", upsert(positionals.name, entry, options.replace, "Source"));
            return { exitCode: 0, stdout: `Saved source ${positionals.name} (${options.kind})` };
          },
        }),

        "source remove": cliCommand({
          summary: "Remove a named proto source",
          positionals: [{ name: "name", description: "Source name", required: true }],
          async run({ positionals }) {
            await editSetting<Named[]>("sources", remove(positionals.name, "source"));
            return { exitCode: 0, stdout: `Removed source ${positionals.name}` };
          },
        }),

        "profile add": cliCommand({
          summary: "Add or replace an auth profile (a command whose output becomes a header)",
          positionals: [{ name: "name", description: "Profile name, e.g. okta", required: true }],
          options: {
            command: { type: "string", required: true, description: "Shell command printing the header value; may use {{target}}, {{host}}, {{port}}, {{endpoint}} and vars" },
            "refresh-command": { type: "string", description: "Run when the command fails or prints an expired JWT" },
            header: { type: "string", default: "authorization", description: "Metadata key (default authorization)" },
            prefix: { type: "string", description: 'Prepended to the output, e.g. "Bearer "' },
            "refresh-seconds": { type: "integer", min: 1, max: 86_400, description: "Fixed cache lifetime (default: JWT exp, else 300)" },
            var: { type: "string", repeatable: true, description: "Default placeholder value 'name=value' (repeatable)" },
            replace,
          },
          async run({ positionals, options }) {
            const profile: Record<string, unknown> = { command: options.command };
            if (options.header !== "authorization") profile.header = options.header.toLowerCase();
            if (options["refresh-command"] !== undefined) profile.refreshCommand = options["refresh-command"];
            if (options.prefix !== undefined) profile.prefix = options.prefix;
            if (options["refresh-seconds"] !== undefined) profile.refreshSeconds = options["refresh-seconds"];
            if (options.var.length > 0) profile.vars = Object.fromEntries(options.var.map((raw) => parsePair(raw, "=")));
            const parsed = profileSchema.safeParse(profile);
            if (!parsed.success) throw new PluginCliError(parsed.error.issues[0]?.message ?? "Invalid profile", { code: "invalid_value" });
            await editSetting<{ profiles?: Record<string, unknown>; rules?: unknown[] }>("auth", (auth) => {
              if (auth.profiles?.[positionals.name] !== undefined && !options.replace) {
                throw new PluginCliError(`Profile "${positionals.name}" already exists`, { code: "exists", hint: "Pass --replace to overwrite it." });
              }
              return { ...auth, profiles: { ...auth.profiles, [positionals.name]: profile } };
            });
            await resetAuth().catch(() => 0);
            return { exitCode: 0, stdout: `Saved auth profile ${positionals.name}` };
          },
        }),

        "profile remove": cliCommand({
          summary: "Remove an auth profile",
          positionals: [{ name: "name", description: "Profile name", required: true }],
          async run({ positionals }) {
            await editSetting<{ profiles?: Record<string, unknown>; rules?: unknown[] }>("auth", (auth) => {
              if (auth.profiles?.[positionals.name] === undefined) throw new PluginCliError(`No profile named "${positionals.name}"`, { code: "not_found" });
              const { [positionals.name]: _removed, ...profiles } = auth.profiles;
              return { ...auth, profiles };
            });
            return { exitCode: 0, stdout: `Removed auth profile ${positionals.name}` };
          },
        }),
      },
    }),
  );
}
