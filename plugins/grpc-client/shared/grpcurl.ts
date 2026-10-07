export const STATUS_CODES = [
  "OK",
  "Canceled",
  "Unknown",
  "InvalidArgument",
  "DeadlineExceeded",
  "NotFound",
  "AlreadyExists",
  "PermissionDenied",
  "ResourceExhausted",
  "FailedPrecondition",
  "Aborted",
  "OutOfRange",
  "Unimplemented",
  "Internal",
  "Unavailable",
  "DataLoss",
  "Unauthenticated",
] as const;

export function statusName(code: number): string {
  return STATUS_CODES[code] ?? `Code(${code})`;
}

/** grpcurl exits with 64 + the gRPC status code when the server returns a non-OK status. */
export const STATUS_EXIT_OFFSET = 64;

export type Metadata = [name: string, value: string][];

export interface VerboseOutput {
  requestMetadata: Metadata;
  headers: Metadata;
  trailers: Metadata;
  /** Parsed JSON per response message; raw text when a block is not JSON. */
  responses: unknown[];
  summary: string | null;
}

const SECTION_HEADERS: Record<string, "descriptor" | "request" | "headers" | "contents" | "trailers"> = {
  "Resolved method descriptor:": "descriptor",
  "Request metadata to send:": "request",
  "Response headers received:": "headers",
  "Response contents:": "contents",
  "Response trailers received:": "trailers",
};
const SUMMARY_PATTERN = /^Sent \d+ requests? and received \d+ responses?$/;

function parseMetadata(lines: string[]): Metadata {
  const metadata: Metadata = [];
  for (const line of lines) {
    if (line.trim() === "" || line.trim() === "(empty)") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    metadata.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return metadata;
}

function parseContents(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Parses the stdout of `grpcurl -v -format json`. */
export function parseVerboseOutput(stdout: string): VerboseOutput {
  const output: VerboseOutput = { requestMetadata: [], headers: [], trailers: [], responses: [], summary: null };
  let section: (typeof SECTION_HEADERS)[string] | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (section === "request") output.requestMetadata = parseMetadata(buffer);
    if (section === "headers") output.headers = parseMetadata(buffer);
    if (section === "trailers") output.trailers = parseMetadata(buffer);
    if (section === "contents" && text !== "") output.responses.push(parseContents(text));
    buffer = [];
  };
  for (const line of stdout.split(/\r?\n/)) {
    const header = SECTION_HEADERS[line];
    if (header !== undefined) {
      flush();
      section = header;
      continue;
    }
    if (SUMMARY_PATTERN.test(line)) {
      flush();
      section = null;
      output.summary = line;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return output;
}

export interface CallStatus {
  code: number;
  name: string;
  message: string;
  details: unknown[];
}

/** Reads the status grpcurl prints to stderr with `-format-error -format json`. */
export function parseErrorStatus(stderr: string, exitCode: number): CallStatus | null {
  if (exitCode < STATUS_EXIT_OFFSET) return null;
  const code = exitCode - STATUS_EXIT_OFFSET;
  const start = stderr.indexOf("{");
  if (start !== -1) {
    try {
      const parsed = JSON.parse(stderr.slice(start, stderr.lastIndexOf("}") + 1)) as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
      };
      const parsedCode = typeof parsed.code === "number" ? parsed.code : code;
      return {
        code: parsedCode,
        name: statusName(parsedCode),
        message: typeof parsed.message === "string" ? parsed.message : "",
        details: Array.isArray(parsed.details) ? parsed.details : [],
      };
    } catch {
      // Fall through to the raw text.
    }
  }
  return { code, name: statusName(code), message: stderr.trim(), details: [] };
}

/** Header values are passed through the environment so tokens never appear in argv. */
export function headerEnvName(index: number): string {
  return `BB_GRPC_HEADER_${index}`;
}

export function invokeArgs(input: {
  protoset: string;
  connection: string[];
  headerNames: string[];
  timeoutSeconds: number;
  target: string;
  method: string;
}): string[] {
  return [
    "-v",
    "-format",
    "json",
    "-emit-defaults",
    "-format-error",
    "-expand-headers",
    "-protoset",
    input.protoset,
    ...input.connection,
    ...input.headerNames.flatMap((name, index) => ["-H", `${name}: \${${headerEnvName(index)}}`]),
    "-max-time",
    String(input.timeoutSeconds),
    "-d",
    "@",
    input.target,
    input.method,
  ];
}

/**
 * Source text of each element of a top-level JSON array. Splitting the text,
 * rather than re-serializing parsed values, keeps 64-bit integers exact.
 */
export function splitJsonArray(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) throw new Error("Expected a JSON array");
  const elements: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 1 && start === -1) start = index;
    } else if (char === "[" || char === "{") {
      if (depth === 1 && start === -1) start = index;
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (start !== -1) elements.push(trimmed.slice(start, index).trim());
        break;
      }
    } else if (char === "," && depth === 1) {
      if (start !== -1) elements.push(trimmed.slice(start, index).trim());
      start = -1;
    } else if (depth === 1 && start === -1 && !/\s/.test(char ?? "")) {
      start = index;
    }
  }
  return elements;
}
