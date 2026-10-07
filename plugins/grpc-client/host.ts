// Runs on the bb server's machine: builds and caches descriptor sets, runs
// auth commands, and invokes grpcurl.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import type { FileRegistry } from "@bufbuild/protobuf";
import { hostContract, type CallResult, type Launch, type MetadataEntry } from "./contract.js";
import {
  connectionArgs,
  descriptorCacheKey,
  jwtSecondsRemaining,
  renderTemplate,
  shellQuote,
  sourceArgs,
  type Endpoint,
  type Profile,
  type Source,
} from "./shared/config.js";
import {
  createRegistry,
  findMethod,
  listServices,
  parseDescriptorSets,
  resolveAuth,
  serializeDescriptorSet,
  typeClosure,
} from "./shared/descriptors.js";
import { headerEnvName, invokeArgs, parseErrorStatus, parseVerboseOutput, splitJsonArray } from "./shared/grpcurl.js";
import type { DescriptorState } from "./shared/schema.js";

const MAX_PROTO_FILES = 20_000;
// Well under macOS ARG_MAX (1 MiB including the environment).
const MAX_ARG_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;
const DESCRIPTOR_BUILD_TIMEOUT_MS = 120_000;
// Long enough for an interactive SSO login that a token command may open.
const AUTH_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_TOKEN_TTL_SECONDS = 300;
const JWT_EXPIRY_MARGIN_SECONDS = 30;
const UNAUTHENTICATED = 16;
const MASK = "***";

interface Loaded {
  key: string;
  configHash: string;
  fingerprint: string;
  protosetPath: string;
  registry: FileRegistry;
  loadedAt: number;
  fileCount: number;
}

interface CacheMeta {
  configHash: string;
  fingerprint: string;
  loadedAt: number;
  bin: string;
}

const descriptors = new Map<string, Loaded>();
const descriptorBuilds = new Map<string, Promise<Loaded>>();
const tokens = new Map<string, { profile: string; value: string; expiresAt: number }>();
const tokenRequests = new Map<string, Promise<string>>();

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout also kills grandchildren that hold the pipes open.
    const child = spawn(expandHome(command), args, {
      cwd: os.homedir(),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const onAbort = () => {
      killGroup();
      finish(() => reject(new Error(`${command} was cancelled`)));
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(() => reject(new Error(`${command} timed out after ${Math.round(options.timeoutMs / 1000)}s`)));
    }, options.timeoutMs);
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error) => {
      const hint = (error as NodeJS.ErrnoException).code === "ENOENT" ? ` (is "${command}" installed and on PATH?)` : "";
      finish(() => reject(new Error(`Could not run ${command}: ${error.message}${hint}`)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (stdoutBytes > MAX_STDOUT_BYTES) reject(new Error(`${command} printed more than ${MAX_STDOUT_BYTES / 1024 / 1024} MiB`));
        else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr });
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? nodePath.join(os.homedir(), path.slice(1)) : path;
}

function expandSource(source: Source): Source {
  switch (source.kind) {
    case "reflection":
      return source;
    case "buf":
      return { ...source, path: expandHome(source.path) };
    case "protoset":
      return { ...source, files: source.files.map(expandHome) };
    case "protoDir":
      return { ...source, path: expandHome(source.path), importPaths: source.importPaths.map(expandHome) };
    case "protoFiles":
      return { ...source, importPaths: source.importPaths.map(expandHome) };
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Recursive listing that follows symlinks (Bazel-style trees) without looping. */
async function walk(
  root: string,
  relative: string,
  accept: (name: string) => boolean,
  out: string[],
  limit: number,
  visited = new Set<string>(),
): Promise<void> {
  const dir = nodePath.join(root, relative);
  const real = await fs.realpath(dir);
  if (visited.has(real)) return;
  visited.add(real);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const target = await fs.stat(nodePath.join(root, child)).catch(() => null);
      isDirectory = target?.isDirectory() ?? false;
      isFile = target?.isFile() ?? false;
    }
    if (isDirectory) {
      await walk(root, child, accept, out, limit, visited);
    } else if (isFile && accept(entry.name)) {
      out.push(child);
      if (out.length > limit) throw new Error(`More than ${limit} files under ${root}`);
    }
    if (out.length > limit) return;
  }
}

const isProto = (name: string) => name.endsWith(".proto");

async function findProtoFiles(root: string, scan: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of scan.length === 0 ? [""] : scan) {
    const relative = dir.replace(/^\.?\/+|\/+$/g, "");
    if (relative.split("/").includes("..")) throw new Error(`scan entry "${dir}" must stay inside ${root}`);
    await walk(root, relative, isProto, files, MAX_PROTO_FILES);
  }
  return [...new Set(files)].sort();
}

/** Absolute paths of every .proto under some directories; a stand-in for "anything importable changed". */
async function protosUnder(dirs: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of dirs) {
    const files: string[] = [];
    try {
      await walk(dir, "", isProto, files, MAX_PROTO_FILES);
    } catch {
      // Unreadable or huge import paths only weaken invalidation; the build reports real problems.
    }
    paths.push(...files.map((file) => nodePath.join(dir, file)));
  }
  return paths;
}

async function statFingerprint(paths: string[]): Promise<string> {
  const parts = await Promise.all(
    [...new Set(paths)].sort().map(async (path) => {
      try {
        const stat = await fs.stat(path);
        return `${path}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${path}:missing`;
      }
    }),
  );
  return sha256(parts.join("\n"));
}

/** Changes whenever a file the source reads changes, so edited protos reload on the next request. */
async function sourceFingerprint(source: Source): Promise<string> {
  switch (source.kind) {
    case "reflection":
      return "";
    case "protoset":
      return statFingerprint(source.files);
    case "protoDir": {
      const files = await findProtoFiles(source.path, source.scan);
      return statFingerprint([...files.map((file) => nodePath.join(source.path, file)), ...(await protosUnder(source.importPaths))]);
    }
    case "protoFiles":
      return statFingerprint(await protosUnder(source.importPaths));
    case "buf": {
      const stat = await fs.stat(source.path).catch(() => null);
      if (stat === null || !stat.isDirectory()) return statFingerprint([source.path]);
      const files: string[] = [];
      await walk(source.path, "", (name) => isProto(name) || /^buf(\.work)?\.(yaml|lock)$/.test(name), files, MAX_PROTO_FILES).catch(() => {});
      return statFingerprint(files.map((file) => nodePath.join(source.path, file)));
    }
  }
}

function configHash(launch: Launch, source: Source): string {
  const endpoint = launch.endpoint;
  const reflection =
    source.kind === "reflection"
      ? { target: endpoint.target, transport: endpoint.transport, args: endpoint.args, headers: endpoint.headers, auth: endpoint.auth ?? null }
      : null;
  return sha256(JSON.stringify({ source, reflection }));
}

function headerEnv(entries: [string, string][]): { names: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  entries.forEach(([, value], index) => {
    env[headerEnvName(index)] = value;
  });
  return { names: entries.map(([name]) => name), env };
}

/** Splits -proto arguments into batches whose argv stays under MAX_ARG_BYTES. */
function protoBatches(files: string[]): string[][] {
  const batches: string[][] = [[]];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file) + 8;
    if (bytes + size > MAX_ARG_BYTES && batches[batches.length - 1]!.length > 0) {
      batches.push([]);
      bytes = 0;
    }
    batches[batches.length - 1]!.push(file);
    bytes += size;
  }
  return batches;
}

async function buildDescriptorSet(launch: Launch, source: Source, output: string): Promise<void> {
  const grpcurl = launch.tools.grpcurl;
  const fail = (label: string, result: RunResult): never => {
    throw new Error(`${label} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim().slice(0, 2000)}`);
  };
  switch (source.kind) {
    case "protoset": {
      const buffers = await Promise.all(source.files.map((file) => fs.readFile(file)));
      await fs.writeFile(output, serializeDescriptorSet(parseDescriptorSets(buffers)));
      return;
    }
    case "buf": {
      const result = await run(launch.tools.buf, ["build", source.path, "-o", output, ...source.args], {
        timeoutMs: DESCRIPTOR_BUILD_TIMEOUT_MS,
      });
      if (result.code !== 0) fail("buf build", result);
      return;
    }
    case "protoDir":
    case "protoFiles": {
      const files = source.kind === "protoDir" ? await findProtoFiles(source.path, source.scan) : source.files;
      if (files.length === 0) throw new Error(`No .proto files found under ${source.kind === "protoDir" ? source.path : "the import paths"}`);
      const batches = protoBatches(files);
      const parts: Buffer[] = [];
      for (const [index, batch] of batches.entries()) {
        const part = batches.length === 1 ? output : `${output}.${index}`;
        const batchSource = source.kind === "protoDir" ? source : { ...source, files: batch };
        try {
          const result = await run(grpcurl, [...sourceArgs(batchSource, batch), "-protoset-out", part, "describe"], {
            timeoutMs: DESCRIPTOR_BUILD_TIMEOUT_MS,
          });
          if (result.code !== 0) fail("grpcurl describe", result);
          if (batches.length > 1) parts.push(await fs.readFile(part));
        } finally {
          if (batches.length > 1) await fs.rm(part, { force: true });
        }
      }
      if (batches.length > 1) await fs.writeFile(output, serializeDescriptorSet(parseDescriptorSets(parts)));
      return;
    }
    case "reflection": {
      const headers = await requestHeaders(launch, null, []);
      const { names, env } = headerEnv(headers.entries);
      const args = [
        ...connectionArgs(launch.endpoint),
        "-expand-headers",
        ...names.flatMap((name, index) => ["-H", `${name}: \${${headerEnvName(index)}}`]),
        "-protoset-out",
        output,
        "describe",
        launch.endpoint.target,
      ];
      const result = await run(grpcurl, args, { env, timeoutMs: DESCRIPTOR_BUILD_TIMEOUT_MS });
      if (result.code !== 0) fail("grpcurl reflection", result);
      return;
    }
  }
}

let dataDir: string | null = null;

async function cacheDir(): Promise<string> {
  if (dataDir === null) throw new Error("Host data directory is not known yet");
  const dir = nodePath.join(dataDir, "descriptors");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._@-]/g, "_");
}

async function readCached(dir: string, key: string, hash: string, fingerprint: string): Promise<Loaded | null> {
  try {
    const meta = JSON.parse(await fs.readFile(nodePath.join(dir, `${safeName(key)}.json`), "utf8")) as CacheMeta;
    if (meta.configHash !== hash || meta.fingerprint !== fingerprint || typeof meta.bin !== "string") return null;
    const protosetPath = nodePath.join(dir, nodePath.basename(meta.bin));
    const set = parseDescriptorSets([await fs.readFile(protosetPath)]);
    return { key, configHash: hash, fingerprint, protosetPath, registry: createRegistry(set), loadedAt: meta.loadedAt, fileCount: set.file.length };
  } catch {
    // Missing, stale or corrupt cache entries are rebuilt.
    return null;
  }
}

async function build(launch: Launch, source: Source, key: string, hash: string, fingerprint: string, reload: boolean): Promise<Loaded> {
  const dir = await cacheDir();
  if (!reload) {
    const cached = await readCached(dir, key, hash, fingerprint);
    if (cached !== null) return cached;
  }
  const loadedAt = Date.now();
  // A fresh file per build: a reader of the previous meta never sees a half-written or mismatched set.
  const bin = `${safeName(key)}.${hash.slice(0, 12)}.${loadedAt}.binpb`;
  const protosetPath = nodePath.join(dir, bin);
  const temp = `${protosetPath}.tmp`;
  try {
    await buildDescriptorSet(launch, source, temp);
    const set = parseDescriptorSets([await fs.readFile(temp)]);
    const registry = createRegistry(set);
    await fs.rename(temp, protosetPath);
    const metaPath = nodePath.join(dir, `${safeName(key)}.json`);
    const previous = await fs
      .readFile(metaPath, "utf8")
      .then((text) => (JSON.parse(text) as Partial<CacheMeta>).bin ?? null)
      .catch(() => null);
    const meta: CacheMeta = { configHash: hash, fingerprint, loadedAt, bin };
    await fs.writeFile(`${metaPath}.tmp`, JSON.stringify(meta));
    await fs.rename(`${metaPath}.tmp`, metaPath);
    if (typeof previous === "string" && previous !== bin) {
      // grpcurl calls already running against the old file keep their open handle.
      await fs.rm(nodePath.join(dir, nodePath.basename(previous)), { force: true });
    }
    return { key, configHash: hash, fingerprint, protosetPath, registry, loadedAt, fileCount: set.file.length };
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function loadDescriptors(launch: Launch, reload: boolean): Promise<Loaded & { fromCache: boolean }> {
  const source = expandSource(launch.source);
  const key = descriptorCacheKey(launch.endpoint, source);
  const hash = configHash(launch, source);
  const fingerprint = await sourceFingerprint(source);
  const current = descriptors.get(key);
  if (!reload && current !== undefined && current.configHash === hash && current.fingerprint === fingerprint) {
    return { ...current, fromCache: true };
  }
  const buildKey = JSON.stringify([key, hash, fingerprint, reload]);
  let pending = descriptorBuilds.get(buildKey);
  if (pending === undefined) {
    pending = build(launch, source, key, hash, fingerprint, reload).then((loaded) => {
      descriptors.set(key, loaded);
      return loaded;
    });
    descriptorBuilds.set(buildKey, pending);
    const settled = pending;
    void settled.finally(() => descriptorBuilds.delete(buildKey)).catch(() => {});
  }
  return { ...(await pending), fromCache: false };
}

async function runShell(command: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const result = await run("/bin/sh", ["-c", command], { timeoutMs: AUTH_COMMAND_TIMEOUT_MS });
    const value = result.stdout.trim();
    if (result.code !== 0) return { ok: false, error: `\`${command}\` exited with ${result.code}: ${result.stderr.trim().slice(-500)}` };
    if (value === "") return { ok: false, error: `\`${command}\` printed nothing` };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isExpired(value: string): boolean {
  const remaining = jwtSecondsRemaining(value, Date.now());
  return remaining !== null && remaining <= JWT_EXPIRY_MARGIN_SECONDS;
}

/** Fixed lifetime when configured, capped by the JWT's own expiry when the value is one. */
function tokenTtlSeconds(profile: Profile, output: string): number {
  const remaining = jwtSecondsRemaining(output, Date.now());
  const jwtTtl = remaining === null ? Number.POSITIVE_INFINITY : remaining - JWT_EXPIRY_MARGIN_SECONDS;
  const ttl = Math.min(profile.refreshSeconds ?? (remaining === null ? DEFAULT_TOKEN_TTL_SECONDS : Number.POSITIVE_INFINITY), jwtTtl);
  return Math.max(5, ttl);
}

async function profileValue(name: string, profile: Profile, endpoint: Endpoint): Promise<string> {
  const command = renderTemplate(profile.command, endpoint, profile);
  const refresh = profile.refreshCommand === undefined ? undefined : renderTemplate(profile.refreshCommand, endpoint, profile);
  const key = JSON.stringify([name, profile.header, profile.prefix, command, refresh ?? null]);
  const cached = tokens.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
  const inflight = tokenRequests.get(key);
  if (inflight !== undefined) return inflight;

  const request = (async () => {
    let result = await runShell(command);
    if (refresh !== undefined && (!result.ok || isExpired(result.value))) {
      const refreshed = await runShell(refresh);
      if (!refreshed.ok) throw new Error(`Auth profile "${name}": refresh failed: ${refreshed.error}`);
      result = await runShell(command);
    }
    if (!result.ok) throw new Error(`Auth profile "${name}": ${result.error}`);
    const value = profile.prefix + result.value;
    tokens.set(key, { profile: name, value, expiresAt: Date.now() + tokenTtlSeconds(profile, result.value) * 1000 });
    return value;
  })();
  tokenRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (tokenRequests.get(key) === request) tokenRequests.delete(key);
  }
}

function forgetProfile(name: string): void {
  for (const [key, entry] of tokens) if (entry.profile === name) tokens.delete(key);
}

interface ResolvedHeaders {
  entries: [string, string][];
  /** Header names whose values come from config or auth and are masked in results. */
  masked: Set<string>;
}

/** Endpoint headers, then the auth profile's header, then per-call metadata, later entries winning. */
async function requestHeaders(launch: Launch, authProfile: string | null, metadata: MetadataEntry[]): Promise<ResolvedHeaders> {
  const merged = new Map<string, string>();
  const masked = new Set<string>();
  for (const [name, value] of Object.entries(launch.endpoint.headers)) {
    merged.set(name, value);
    masked.add(name);
  }
  const overridden = new Set(metadata.map(({ name }) => name));
  const profileName = authProfile ?? (launch.endpoint.auth !== undefined && launch.endpoint.auth !== "none" ? launch.endpoint.auth : null);
  if (profileName !== null) {
    const profile = launch.auth.profiles[profileName];
    if (profile === undefined) throw new Error(`Unknown auth profile "${profileName}"`);
    if (!overridden.has(profile.header)) {
      merged.set(profile.header, await profileValue(profileName, profile, launch.endpoint));
      masked.add(profile.header);
    }
  }
  for (const { name, value } of metadata) {
    merged.set(name, value);
    masked.delete(name);
  }
  return { entries: [...merged.entries()], masked };
}

/**
 * grpcurl reads a stream of concatenated JSON messages; a JSON array means one
 * message per element. The original text is forwarded, never re-serialized,
 * so 64-bit integers written as bare numbers keep every digit.
 */
function requestBody(request: string, clientStreams: boolean): string {
  const text = request.trim() === "" ? "{}" : request.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (clientStreams && Array.isArray(parsed)) {
    const elements = splitJsonArray(text);
    if (parsed.some((element) => typeof element !== "object" || element === null || Array.isArray(element))) {
      throw new Error("Each streamed message must be a JSON object");
    }
    return elements.join("\n");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(clientStreams ? "Request must be a JSON object or an array of objects" : "Request must be a JSON object");
  }
  return text;
}

function failure(method: string, auth: string | null, startedAt: number, error: string, stderr = ""): CallResult {
  return {
    method,
    ok: false,
    status: { code: 2, name: "Unknown", message: error, details: [] },
    error,
    responses: [],
    headers: [],
    trailers: [],
    requestMetadata: [],
    auth,
    durationMs: Date.now() - startedAt,
    stderr,
  };
}

function doubleQuoted(text: string): string {
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function envVarFor(header: string): string {
  return header.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function unknownMethod(method: string, source: Source): Error {
  const hint = source.kind === "reflection" ? " (reflection descriptors are cached: reload protos if the server changed)" : "";
  return new Error(`Unknown method ${method}${hint}`);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async services(input, context) {
      dataDir = context.experimental_paths.dataDir;
      const loaded = await loadDescriptors(input, input.reload);
      const state: DescriptorState = {
        key: loaded.key,
        loadedAt: loaded.loadedAt,
        fileCount: loaded.fileCount,
        fromCache: loaded.fromCache,
        warnings: [],
      };
      return { state, services: listServices(loaded.registry, input.auth.rules, input.endpoint) };
    },

    async types(input, context) {
      dataDir = context.experimental_paths.dataDir;
      const loaded = await loadDescriptors(input, false);
      return typeClosure(loaded.registry, input.typeName);
    },

    async invoke(input, context) {
      dataDir = context.experimental_paths.dataDir;
      const startedAt = Date.now();
      let auth: string | null = null;
      let loaded: Loaded;
      let body: string;
      let headers: ResolvedHeaders;
      try {
        loaded = await loadDescriptors(input, false);
        const method = findMethod(loaded.registry, input.method);
        if (method === undefined) throw unknownMethod(input.method, input.source);
        auth = resolveAuth(loaded.registry, method, input.auth.rules, input.endpoint).auth;
        const streams = method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming";
        body = requestBody(input.request, streams);
        headers = await requestHeaders(input, auth, input.metadata);
      } catch (error) {
        return failure(input.method, auth, startedAt, error instanceof Error ? error.message : String(error));
      }

      const { names, env } = headerEnv(headers.entries);
      const args = invokeArgs({
        protoset: loaded.protosetPath,
        connection: connectionArgs(input.endpoint),
        headerNames: names,
        timeoutSeconds: input.timeoutSeconds,
        target: input.endpoint.target,
        method: input.method,
      });
      let result: RunResult;
      try {
        result = await run(input.tools.grpcurl, args, {
          env,
          stdin: body,
          timeoutMs: (input.timeoutSeconds + 15) * 1000,
          signal: context.signal,
        });
      } catch (error) {
        return failure(input.method, auth, startedAt, error instanceof Error ? error.message : String(error));
      }

      const parsed = parseVerboseOutput(result.stdout);
      const requestMetadata = parsed.requestMetadata.map(([name, value]): [string, string] => [
        name,
        headers.masked.has(name.toLowerCase()) ? MASK : value,
      ]);
      const status = result.code === 0 ? { code: 0, name: "OK", message: "", details: [] } : parseErrorStatus(result.stderr, result.code);
      // A rejected token is probably revoked or from another account; the next call fetches a new one.
      if (status?.code === UNAUTHENTICATED && auth !== null) forgetProfile(auth);
      const stderr = result.stderr.trim();
      return {
        method: input.method,
        ok: result.code === 0,
        status: status ?? { code: 2, name: "Unknown", message: stderr, details: [] },
        error: status === null ? stderr || `grpcurl exited with ${result.code}` : null,
        responses: parsed.responses,
        headers: parsed.headers,
        trailers: parsed.trailers,
        requestMetadata,
        auth,
        durationMs: Date.now() - startedAt,
        stderr: status === null ? stderr : "",
      };
    },

    async command(input, context) {
      dataDir = context.experimental_paths.dataDir;
      const loaded = await loadDescriptors(input, false);
      const method = findMethod(loaded.registry, input.method);
      if (method === undefined) throw unknownMethod(input.method, input.source);
      const auth = resolveAuth(loaded.registry, method, input.auth.rules, input.endpoint).auth;
      const streams = method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming";
      const parts = ["grpcurl", "-protoset", shellQuote(loaded.protosetPath), ...connectionArgs(input.endpoint).map(shellQuote)];
      const overridden = new Set(input.metadata.map(({ name }) => name));
      const headerArgs = new Map<string, string>();
      // Endpoint header values may be secrets, so the command reads them from the environment.
      for (const name of Object.keys(input.endpoint.headers)) headerArgs.set(name, `"${name}: \${${envVarFor(name)}:?}"`);
      if (auth !== null) {
        const profile = input.auth.profiles[auth];
        if (profile === undefined) throw new Error(`Unknown auth profile "${auth}"`);
        if (!overridden.has(profile.header)) {
          // The token command stays a live $(...) substitution so the copied command never embeds a token.
          const command = renderTemplate(profile.command, input.endpoint, profile);
          headerArgs.set(profile.header, `${doubleQuoted(`${profile.header}: ${profile.prefix}`).slice(0, -1)}$(${command})"`);
        }
      }
      for (const { name, value } of input.metadata) headerArgs.set(name, doubleQuoted(`${name}: ${value}`));
      for (const arg of headerArgs.values()) parts.push("-H", arg);
      parts.push("-d", shellQuote(requestBody(input.request, streams)), shellQuote(input.endpoint.target), input.method);
      return { command: parts.join(" ") };
    },

    resetAuth() {
      const cleared = tokens.size + tokenRequests.size;
      tokens.clear();
      tokenRequests.clear();
      return { cleared };
    },
  },
});
