import { z } from "zod";

export const nameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Names use letters, digits, '.', '_' or '-' (max 64)");

export const headerNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "Header names are lowercase letters, digits, '_', '.' or '-'");

const absolutePath = z.string().refine((path) => path.startsWith("/") || path.startsWith("~/"), {
  message: "Use an absolute path (or one starting with ~/)",
});

export const transportSchema = z.enum(["tls", "plaintext", "insecure"]);
export type Transport = z.infer<typeof transportSchema>;

const varsSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());

export const endpointSchema = z
  .object({
    name: nameSchema,
    /** host:port of the gRPC server. */
    target: z.string().min(1),
    transport: transportSchema.default("tls"),
    description: z.string().optional(),
    /** Proto source used when none is picked; falls back to `defaultSource`. */
    source: nameSchema.optional(),
    /** Static metadata sent with every call. */
    headers: z.record(headerNameSchema, z.string()).default({}),
    /** Auth profile applied to every method, overriding option-based rules. "none" disables auth. */
    auth: z.string().min(1).optional(),
    /** Values for {{placeholders}} in auth profile commands. */
    vars: varsSchema.default({}),
    /** Extra grpcurl flags, e.g. ["-authority", "api.example.com"]. */
    args: z.array(z.string()).default([]),
    /** Calls need explicit confirmation (UI dialog, `--yes` on the CLI). */
    protected: z.boolean().default(false),
  })
  .strict();
export type Endpoint = z.infer<typeof endpointSchema>;

const sourceBase = { name: nameSchema };

export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ ...sourceBase, kind: z.literal("reflection") }).strict(),
  z
    .object({
      ...sourceBase,
      kind: z.literal("protoDir"),
      /** Root directory; also the first import path. */
      path: absolutePath,
      /** Root-relative subdirectories to scan; empty scans the whole root. */
      scan: z.array(z.string().min(1)).default([]),
      importPaths: z.array(absolutePath).default([]),
    })
    .strict(),
  z
    .object({
      ...sourceBase,
      kind: z.literal("protoFiles"),
      /** Paths relative to an import path. */
      files: z.array(z.string().min(1)).min(1),
      importPaths: z.array(absolutePath).min(1),
    })
    .strict(),
  z
    .object({
      ...sourceBase,
      kind: z.literal("protoset"),
      files: z.array(absolutePath).min(1),
    })
    .strict(),
  z
    .object({
      ...sourceBase,
      kind: z.literal("buf"),
      /** Directory containing buf.yaml / buf.work.yaml, or any input `buf build` accepts. */
      path: z.string().min(1),
      args: z.array(z.string()).default([]),
    })
    .strict(),
]);
export type Source = z.infer<typeof sourceSchema>;
export type SourceKind = Source["kind"];
export const SOURCE_KINDS = ["reflection", "protoDir", "protoFiles", "protoset", "buf"] as const;

export const REFLECTION_SOURCE: Source = { name: "reflection", kind: "reflection" };

export const profileSchema = z
  .object({
    /** Metadata key the value is sent as. */
    header: headerNameSchema.default("authorization"),
    /** Run with /bin/sh -c; trimmed stdout is the value. */
    command: z.string().min(1),
    /** Run when `command` fails or prints an expired JWT, then `command` runs again. */
    refreshCommand: z.string().min(1).optional(),
    /** Prepended to the command output, e.g. "Bearer ". */
    prefix: z.string().default(""),
    /** Fixed cache lifetime. Without it a JWT's exp is used, else 5 minutes. */
    refreshSeconds: z.number().int().min(1).max(86_400).optional(),
    /** Defaults for {{placeholders}}; endpoint vars override them. */
    vars: varsSchema.default({}),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;

export const authRuleSchema = z
  .object({
    /** Fully-qualified extension on google.protobuf.MethodOptions. */
    methodOption: z.string().min(1).optional(),
    /** Fully-qualified extension on google.protobuf.ServiceOptions, used when the method has none. */
    serviceOption: z.string().min(1).optional(),
    /** Field of the option message whose value selects the profile (proto or JSON name). */
    field: z.string().min(1),
    /** Option value (enum value name, or the scalar as a string) → profile name, or null for no auth. */
    profiles: z.record(z.string(), z.string().nullable()),
  })
  .strict()
  .refine((rule) => rule.methodOption !== undefined || rule.serviceOption !== undefined, {
    message: "A rule needs methodOption or serviceOption",
  });
export type AuthRule = z.infer<typeof authRuleSchema>;

export const authSchema = z
  .object({
    profiles: z.record(nameSchema, profileSchema).default({}),
    rules: z.array(authRuleSchema).default([]),
  })
  .strict();
export type AuthConfig = z.infer<typeof authSchema>;

function uniqueNames<T extends { name: string }>(label: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.name)) {
        ctx.addIssue({ code: "custom", path: [index, "name"], message: `Duplicate ${label} "${item.name}"` });
      }
      seen.add(item.name);
    }
  };
}

export const endpointsSchema = z.array(endpointSchema).superRefine(uniqueNames<Endpoint>("endpoint"));
export const sourcesSchema = z.array(sourceSchema).superRefine(uniqueNames<Source>("source"));

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseJsonSetting<T>(raw: string, schema: z.ZodType<T>, label: string, empty = "[]"): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw.trim() === "" ? empty : raw);
  } catch (error) {
    return { ok: false, error: `${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return { ok: false, error: `${label}${where}: ${issue?.message ?? "invalid value"}` };
}

/** Validator for the settings form; reports the first problem under the field. */
export function jsonSettingValidator<T>(schema: z.ZodType<T>, label: string, empty = "[]") {
  return z.string().superRefine((raw, ctx) => {
    const result = parseJsonSetting(raw, schema, label, empty);
    if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
  });
}

/** Configured sources plus the implicit "reflection" one, unless the user redefined it. */
export function withBuiltinSources(sources: Source[]): Source[] {
  return sources.some((source) => source.name === REFLECTION_SOURCE.name) ? sources : [REFLECTION_SOURCE, ...sources];
}

export function resolveSourceName(endpoint: Endpoint, requested: string | undefined, defaultSource: string): string {
  return requested ?? endpoint.source ?? defaultSource;
}

/** Reflection descriptors depend on the server, so they are cached per endpoint; files only per source. */
export function descriptorCacheKey(endpoint: Endpoint, source: Source): string {
  return source.kind === "reflection" ? `reflection@${endpoint.name}` : `source@${source.name}`;
}

/**
 * Expands {{name}} placeholders. Built-ins: endpoint, target, host, port.
 * Var values may themselves use the built-ins (e.g. "authAddress": "{{target}}").
 */
export function renderTemplate(template: string, endpoint: Endpoint, profile: Profile): string {
  const colon = endpoint.target.lastIndexOf(":");
  const builtins: Record<string, string> = {
    endpoint: endpoint.name,
    target: endpoint.target,
    host: colon === -1 ? endpoint.target : endpoint.target.slice(0, colon),
    port: colon === -1 ? "" : endpoint.target.slice(colon + 1),
  };
  const substitute = (text: string, values: Record<string, string>) =>
    text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`Unknown placeholder {{${name}}} (set it in the endpoint's "vars")`);
      return value;
    });
  const vars: Record<string, string> = { ...builtins };
  for (const [name, value] of Object.entries({ ...profile.vars, ...endpoint.vars })) vars[name] = substitute(value, builtins);
  return substitute(template, vars);
}

/** Connection flags shared by every grpcurl invocation for an endpoint. */
export function connectionArgs(endpoint: Endpoint): string[] {
  const args: string[] = [];
  if (endpoint.transport === "plaintext") args.push("-plaintext");
  if (endpoint.transport === "insecure") args.push("-insecure");
  args.push(...endpoint.args);
  return args;
}

/** grpcurl flags that load descriptors straight from a source (used to build the descriptor cache). */
export function sourceArgs(source: Source, protoFiles: string[]): string[] {
  switch (source.kind) {
    case "reflection":
    case "buf":
      return [];
    case "protoset":
      return source.files.flatMap((file) => ["-protoset", file]);
    case "protoDir":
    case "protoFiles": {
      const importPaths = source.kind === "protoDir" ? [source.path, ...source.importPaths] : source.importPaths;
      const files = source.kind === "protoDir" ? protoFiles : source.files;
      return [...importPaths.flatMap((path) => ["-import-path", path]), ...files.flatMap((file) => ["-proto", file])];
    }
  }
}

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Seconds until a JWT (optionally "Bearer "-prefixed) expires, or null when the value is not one. */
export function jwtSecondsRemaining(value: string, nowMs: number): number | null {
  const token = value.replace(/^bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp - nowMs / 1000 : null;
  } catch {
    return null;
  }
}
