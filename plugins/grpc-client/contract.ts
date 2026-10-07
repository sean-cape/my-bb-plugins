import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { authSchema, endpointSchema, headerNameSchema, sourceSchema } from "./shared/config.js";
import { descriptorStateSchema, serviceInfoSchema, typeClosureSchema } from "./shared/schema.js";

const metadataSchema = z.array(z.tuple([z.string(), z.string()]));

export const metadataEntrySchema = z.object({ name: headerNameSchema, value: z.string() });
export type MetadataEntry = z.infer<typeof metadataEntrySchema>;

export const launchSchema = z.object({
  endpoint: endpointSchema,
  source: sourceSchema,
  auth: authSchema,
  tools: z.object({ grpcurl: z.string().min(1), buf: z.string().min(1) }),
});
export type Launch = z.infer<typeof launchSchema>;

export const callInputSchema = launchSchema.extend({
  method: z.string().min(1),
  /** One JSON message, or for client-streaming methods a JSON array of messages. */
  request: z.string(),
  metadata: z.array(metadataEntrySchema),
  timeoutSeconds: z.number().min(0.1).max(3600),
});

export const callResultSchema = z.object({
  method: z.string(),
  ok: z.boolean(),
  status: z.object({ code: z.number(), name: z.string(), message: z.string(), details: z.array(z.unknown()) }),
  /** A failure before the server answered (bad request JSON, dial error, token command failed). */
  error: z.string().nullable(),
  responses: z.array(z.unknown()),
  headers: metadataSchema,
  trailers: metadataSchema,
  /** What was sent, with auth and endpoint header values masked. */
  requestMetadata: metadataSchema,
  auth: z.string().nullable(),
  durationMs: z.number(),
  stderr: z.string(),
});
export type CallResult = z.infer<typeof callResultSchema>;

export const hostContract = defineRpcContract({
  services: {
    input: launchSchema.extend({ reload: z.boolean() }),
    output: z.object({ state: descriptorStateSchema, services: z.array(serviceInfoSchema) }),
  },
  types: {
    input: launchSchema.extend({ typeName: z.string().min(1) }),
    output: typeClosureSchema,
  },
  invoke: {
    input: callInputSchema,
    output: callResultSchema,
  },
  command: {
    input: callInputSchema,
    output: z.object({ command: z.string() }),
  },
  resetAuth: {
    input: z.null(),
    output: z.object({ cleared: z.number() }),
  },
});
