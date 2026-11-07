import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ACTIONS, SOURCES } from "./actions.js";

export const actionSchema = z.enum(ACTIONS);

export const resolvedSchema = z.object({
  threadId: z.string(),
  /**
   * False for threads the setting doesn't reach: ones a plugin started (kanban cards, automations, side chats), whose
   * owner decides what they commit, and Personal threads, which have no repository.
   */
  applies: z.boolean(),
  action: actionSchema,
  source: z.enum(SOURCES),
  projectDefault: actionSchema.nullable(),
});
export type Resolved = z.infer<typeof resolvedSchema>;

export const rpcContract = defineRpcContract({
  resolve: {
    input: z.object({ threadIds: z.array(z.string()).max(200) }).strict(),
    output: z.object({ threads: z.array(resolvedSchema) }),
  },
  /** A null action clears the thread's pick, so it follows its project's default again. */
  set: {
    input: z.object({ threadId: z.string(), action: actionSchema.nullable() }).strict(),
    output: resolvedSchema,
  },
  setProjectDefault: {
    input: z.object({ projectId: z.string(), action: actionSchema.nullable() }).strict(),
    output: z.object({ projectId: z.string(), action: actionSchema.nullable() }),
  },
});
