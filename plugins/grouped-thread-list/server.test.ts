import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { defaultPreferences } from "./shared/preferences.js";

function setup(pluginId = "grouped-thread-list") {
  return createFakePluginHost({ pluginId });
}

describe("preferences rpc", () => {
  it("lists defaults, round-trips the active project, and broadcasts it", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("listPreferences", null),
    ).resolves.toEqual({ preferences: { activeProject: null } });

    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "activeProject",
        value: "proj_a",
      }),
    ).resolves.toEqual({ key: "activeProject", value: "proj_a" });
    await expect(bb.storage.kv.get("preference:activeProject")).resolves.toBe(
      "proj_a",
    );
    expect(harness.realtimeSignals).toEqual([
      {
        channel: "preferences",
        payload: { key: "activeProject", value: "proj_a" },
      },
    ]);

    await expect(
      harness.behavior.callRpc("resetPreference", { key: "activeProject" }),
    ).resolves.toEqual({ key: "activeProject", value: null });
    await expect(
      bb.storage.kv.get("preference:activeProject"),
    ).resolves.toBeUndefined();
  });

  it("rejects an invalid value and leaves storage alone", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "activeProject",
        value: "",
      }),
    ).rejects.toThrow(/Invalid value for activeProject/);
    await expect(
      bb.storage.kv.get("preference:activeProject"),
    ).resolves.toBeUndefined();
  });

  it("falls back to the default when a stored value no longer parses", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("preference:activeProject", 42);
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("listPreferences", null),
    ).resolves.toEqual({ preferences: { activeProject: null } });
  });
});

describe("prefs CLI", () => {
  it("names the CLI after the plugin id", async () => {
    const builtIn = setup();
    await plugin(builtIn.bb);
    expect(builtIn.harness.inspection.registrations.cli?.name).toBe(
      "grouped-thread-list",
    );
    const copy = setup("my-switcher");
    await plugin(copy.bb);
    expect(copy.harness.inspection.registrations.cli?.name).toBe("my-switcher");
  });

  it("lists, gets, sets, and resets", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    const listed = await harness.behavior.runCli(["prefs", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(defaultPreferences());

    const set = await harness.behavior.runCli([
      "prefs",
      "set",
      "activeProject",
      "proj_app",
    ]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toBe('activeProject = "proj_app"');
    const got = await harness.behavior.runCli([
      "prefs",
      "get",
      "activeProject",
    ]);
    expect(got.stdout).toBe('"proj_app"');

    const bad = await harness.behavior.runCli([
      "prefs",
      "set",
      "activeProject",
      '""',
    ]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/Invalid value for activeProject/);

    const unknown = await harness.behavior.runCli(["prefs", "get", "colour"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toMatch(/Unknown preference: colour/);

    const reset = await harness.behavior.runCli([
      "prefs",
      "reset",
      "activeProject",
      "--json",
    ]);
    expect(JSON.parse(reset.stdout)).toEqual({
      key: "activeProject",
      value: null,
    });
  });
});

describe("automation runs", () => {
  async function loaded() {
    const host = createFakePluginHost({
      pluginId: "grouped-thread-list",
      sdk: {
        threads: {
          markRead: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId }),
        },
      },
    });
    await plugin(host.bb);
    const run = (id: string, extra: Record<string, unknown> = {}) =>
      makeThreadResponse({ id, originPluginId: "automations", ...extra });
    const marked = () =>
      (
        host.harness.inspection.sdk.callsTo("threads.markRead") as Array<
          [{ threadId: string }]
        >
      ).map(([args]) => args.threadId);
    return { host, run, marked };
  }

  it("marks the run's own turn read when it ends, but not a later turn the user starts", async () => {
    const { host, run, marked } = await loaded();
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: run("thr_run", { activeBackgroundAgentCount: 1 }),
      lastAssistantText: null,
    });
    expect(marked()).toEqual([]);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: run("thr_run"),
      lastAssistantText: "Wrote the summary.",
    });
    expect(marked()).toEqual(["thr_run"]);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: run("thr_run"),
      lastAssistantText: "Answered.",
    });
    expect(marked()).toEqual(["thr_run"]);
  });

  it("leaves a failed run, and threads the user started, unread", async () => {
    const { host, run, marked } = await loaded();
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: run("thr_failed"),
      error: "Turn failed",
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: run("thr_failed"),
      lastAssistantText: "Retried.",
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_mine" }),
      lastAssistantText: "Done.",
    });
    expect(marked()).toEqual([]);
  });
});
