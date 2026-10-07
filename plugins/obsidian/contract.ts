import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Vault-relative POSIX path. The host re-validates confinement on every call. */
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "Path must be relative to the vault",
  });

const vaultPath = z.string().min(1).max(1024);

export const fileEntrySchema = z.object({
  path: z.string(),
  mtimeMs: z.number(),
  size: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const treeSchema = z.object({
  files: z.array(fileEntrySchema),
  folders: z.array(z.string()),
});
export type VaultTree = z.infer<typeof treeSchema>;

export const noteSchema = z.object({
  content: z.string(),
  sha256: z.string(),
  mtimeMs: z.number(),
});
export type NoteContent = z.infer<typeof noteSchema>;

export const writeResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written"), sha256: z.string() }),
  z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
]);
export type WriteResult = z.infer<typeof writeResultSchema>;

export const lineMatchSchema = z.object({ line: z.number(), text: z.string() });

export const backlinksSchema = z.object({
  backlinks: z.array(
    z.object({ path: z.string(), matches: z.array(lineMatchSchema) }),
  ),
});
export type Backlinks = z.infer<typeof backlinksSchema>;

export const searchSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      nameMatch: z.boolean(),
      matches: z.array(lineMatchSchema),
    }),
  ),
  truncated: z.boolean(),
});
export type SearchResults = z.infer<typeof searchSchema>;

export const moveResultSchema = z.object({
  path: z.string(),
  updatedNotes: z.array(z.string()),
  /** Notes that link to a moved file but couldn't be rewritten (edited meanwhile, too large, unreadable). */
  skippedNotes: z.array(z.string()),
});

export const hostContract = defineRpcContract({
  checkVault: {
    input: z.object({ vaultPath }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },
  watch: {
    input: z.object({ vaultPath }).strict(),
    output: z.object({ started: z.boolean() }),
  },
  tree: {
    input: z.object({ vaultPath }).strict(),
    output: treeSchema,
  },
  read: {
    input: z.object({ vaultPath, path: relativePath }).strict(),
    output: noteSchema,
  },
  write: {
    input: z
      .object({
        vaultPath,
        path: relativePath,
        content: z.string().max(25 * 1024 * 1024),
        // undefined = unconditional, null = create-only, string = compare-and-swap
        expectedSha256: z.string().nullable().optional(),
      })
      .strict(),
    output: writeResultSchema,
  },
  mkdir: {
    input: z.object({ vaultPath, path: relativePath }).strict(),
    output: z.object({ path: z.string() }),
  },
  move: {
    input: z
      .object({ vaultPath, from: relativePath, to: relativePath, updateLinks: z.boolean() })
      .strict(),
    output: moveResultSchema,
  },
  trash: {
    input: z.object({ vaultPath, path: relativePath }).strict(),
    output: z.object({ trashedTo: z.string() }),
  },
  backlinks: {
    input: z.object({ vaultPath, path: relativePath }).strict(),
    output: backlinksSchema,
  },
  search: {
    input: z.object({ vaultPath, query: z.string().min(1).max(500), limit: z.number().int().min(1).max(500) }).strict(),
    output: searchSchema,
  },
});

export const hostSignals = {
  changed: {
    payload: z
      .object({
        vaultPath: z.string(),
        paths: z.array(z.string()),
        structural: z.boolean(),
      })
      .strict(),
  },
} satisfies ExperimentalHostSignals;

/** Realtime channel the server publishes on after any vault change. */
export const VAULT_CHANGED = "vault-changed";
export interface VaultChangedPayload {
  paths: string[];
  structural: boolean;
}
