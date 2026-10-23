import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Whether a branch's commits have reached its merge-base branch, judged by content. bb's changes bar counts commits
 * since the merge base, so work landed by cherry-picking (new commits on the base, with other ids) reads as unmerged
 * there forever.
 */
export const landedSchema = z.discriminatedUnion("state", [
  /** Nothing to say: no commits beyond the base, not a git checkout, or a base git can't find. */
  z.object({ state: z.literal("none") }),
  /** `pushed` is whether the base's upstream has it too; null when the base has no upstream. */
  z.object({ state: z.literal("landed"), base: z.string(), pushed: z.boolean().nullable() }),
  /** `files` the branch would still change in the base; `conflicts` when merging it would conflict. */
  z.object({ state: z.literal("unlanded"), base: z.string(), files: z.number().int(), conflicts: z.boolean() }),
]);
export type Landed = z.infer<typeof landedSchema>;

export const rpcContract = defineRpcContract({
  landed: { input: z.object({ threadId: z.string() }).strict(), output: landedSchema },
});
