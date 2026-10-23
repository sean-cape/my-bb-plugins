import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type Landed } from "./contract.js";
import { landedStatus } from "./landed.js";

export default async function plugin(bb: BbPluginApi) {
  /** A thread's branch against the merge base its changes bar shows. */
  async function landed({ threadId }: { threadId: string }): Promise<Landed> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) return { state: "none" };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const base = environment.mergeBaseBranch ?? environment.defaultBranch;
    // An environment on another machine has a path this server can't read.
    if (!environment.isGitRepo || base === null || environment.path === null || !existsSync(environment.path)) return { state: "none" };
    return landedStatus(environment.path, base);
  }

  bb.rpc.register(rpcContract, { landed });
}
