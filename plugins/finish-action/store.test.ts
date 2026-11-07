import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinishAction } from "./actions.js";
import type { Resolved } from "./contract.js";
import { bindRpc, cached, cycle, load, makeProjectDefault, pick, resetStore } from "./store.js";

/** An RPC server holding thread picks and project defaults, resolved the way the plugin's server does. */
function fakeServer(threads: Record<string, { projectId: string; applies?: boolean; pick?: FinishAction }>) {
  const defaults = new Map<string, FinishAction>();
  const resolve = (threadId: string): Resolved => {
    const thread = threads[threadId]!;
    const projectDefault = defaults.get(thread.projectId) ?? null;
    const action = thread.pick ?? projectDefault ?? "none";
    const source = thread.pick !== undefined ? "thread" : projectDefault !== null ? "project" : "default";
    return { threadId, applies: thread.applies ?? true, action, source, projectDefault };
  };
  const call = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === "resolve") return { threads: (input.threadIds as string[]).map(resolve) };
    if (method === "set") {
      const thread = threads[input.threadId as string]!;
      thread.pick = (input.action as FinishAction | null) ?? undefined;
      return resolve(input.threadId as string);
    }
    if (method === "setProjectDefault") {
      defaults.set(input.projectId as string, input.action as FinishAction);
      return input;
    }
    throw new Error(method);
  });
  bindRpc({ call } as unknown as Parameters<typeof bindRpc>[0]);
  return call;
}

afterEach(resetStore);

describe("store", () => {
  it("loads only threads it hasn't cached unless asked to refresh", async () => {
    const call = fakeServer({ a: { projectId: "p" }, b: { projectId: "p" } });
    await load(["a"]);
    await load(["a", "b"]);
    expect(call.mock.calls.map(([, input]) => input)).toEqual([{ threadIds: ["a"] }, { threadIds: ["b"] }]);
    await load(["a"], true);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("cycles from the resolved action, so a thread on its project default steps to the next one", async () => {
    fakeServer({ a: { projectId: "p", pick: "land" } });
    await cycle("a", 1);
    expect(cached("a")).toMatchObject({ action: "commit", source: "thread" });
    await cycle("a", -1);
    await cycle("a", -1);
    expect(cached("a")?.action).toBe("none");
  });

  it("leaves a thread the setting doesn't apply to alone", async () => {
    const call = fakeServer({ k: { projectId: "p", applies: false } });
    await cycle("k", 1);
    expect(call.mock.calls.map(([method]) => method)).toEqual(["resolve"]);
  });

  it("clears a pick so the thread follows its project again", async () => {
    fakeServer({ a: { projectId: "p", pick: "commit" } });
    await pick("a", null);
    expect(cached("a")).toMatchObject({ action: "none", source: "default" });
  });

  it("makes a thread's action its project's default and refreshes the project's other threads", async () => {
    fakeServer({ a: { projectId: "p", pick: "land" }, b: { projectId: "p" } });
    await load(["a", "b"]);
    await makeProjectDefault("a", "p");
    expect(cached("b")).toMatchObject({ action: "land", source: "project", projectDefault: "land" });
  });

  it("does nothing before a surface has bound the RPC client", async () => {
    await expect(pick("a", "land")).resolves.toBeUndefined();
    expect(cached("a")).toBeUndefined();
  });
});
