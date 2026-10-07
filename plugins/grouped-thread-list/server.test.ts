import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, {
  migrateFromThreadListPlugin,
  migrateFromUiPreferences,
} from "./server.js";
import { defaultPreferences } from "./shared/preferences.js";

const PLUGIN_ID = "grouped-thread-list";

interface RpcCall {
  pluginId: string;
  method: string;
  input?: unknown;
}

function setup(options: {
  uiPreferences?: Record<string, { revision: number; value: unknown }>;
  uiPreferencesFail?: boolean;
  pluginId?: string;
  threadListPreferences?: Record<string, unknown>;
  threadListFail?: boolean;
  rpcCalls?: RpcCall[];
} = {}) {
  return createFakePluginHost({
    pluginId: options.pluginId ?? PLUGIN_ID,
    sdk: {
      plugins: {
        callRpc: async ({ pluginId, method, input, outputSchema }) => {
          options.rpcCalls?.push({ pluginId, method, input });
          if (options.threadListFail) throw new Error("plugin not running");
          return outputSchema.parse({
            preferences: options.threadListPreferences ?? defaultPreferences(),
          });
        },
      },
      system: {
        uiPreferences: {
          list: async () => {
            if (options.uiPreferencesFail) throw new Error("offline");
            return { preferences: options.uiPreferences ?? {} };
          },
        },
      },
    },
  });
}

describe("thread-list preferences rpc", () => {
  it("lists defaults on a fresh install and round-trips a valid write", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.behavior.callRpc("listPreferences", null)).resolves.toEqual({
      preferences: defaultPreferences(),
    });
    expect(defaultPreferences().showProviderIcons).toBe(false);

    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "organizationMode",
        value: "machine",
      }),
    ).resolves.toEqual({ key: "organizationMode", value: "machine" });
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBe(
      "machine",
    );
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { organizationMode: string };
    };
    expect(listed.preferences.organizationMode).toBe("machine");
    expect(harness.realtimeSignals).toEqual([
      { channel: "preferences", payload: { key: "organizationMode", value: "machine" } },
    ]);
  });

  it("rejects a value that fails the preference's schema and leaves storage alone", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "organizationMode",
        value: "sideways",
      }),
    ).rejects.toThrow(/Invalid value for organizationMode/);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBeUndefined();
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "hiddenGroups",
        value: ["project:a", "bogus"],
      }),
    ).rejects.toThrow(/Invalid value for hiddenGroups/);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "showProviderIcons",
        value: "false",
      }),
    ).rejects.toThrow(/Invalid value for showProviderIcons/);
  });

  it("dedupes hidden groups and resets to the default", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "hiddenGroups",
        value: ["threads", "project:a", "project:a", "machine:m"],
      }),
    ).resolves.toEqual({
      key: "hiddenGroups",
      value: ["threads", "project:a", "machine:m"],
    });
    await expect(
      harness.behavior.callRpc("resetPreference", { key: "hiddenGroups" }),
    ).resolves.toEqual({ key: "hiddenGroups", value: [] });
    await expect(bb.storage.kv.get("preference:hiddenGroups")).resolves.toBeUndefined();
  });

  it("defaults row actions to archive, dedupes them, and rejects unknown or too many actions", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { rowActions: string[] };
    };
    expect(listed.preferences.rowActions).toEqual(["archive"]);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["pin", "archive", "pin"],
      }),
    ).resolves.toEqual({ key: "rowActions", value: ["pin", "archive"] });
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["archive", "delete"],
      }),
    ).rejects.toThrow(/Invalid value for rowActions/);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["archive", "pin", "read", "rename"],
      }),
    ).rejects.toThrow(/at most 3 row actions/);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["archive", "pin", "read", "pin"],
      }),
    ).resolves.toEqual({ key: "rowActions", value: ["archive", "pin", "read"] });
  });

  it("drops unknown stored row actions instead of resetting the rest", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("preference:rowActions", ["pin", "futureAction", "archive"]);
    await plugin(bb);
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { rowActions: string[] };
    };
    expect(listed.preferences.rowActions).toEqual(["pin", "archive"]);
  });

  it("falls back to the default when a stored value no longer parses", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("preference:chronologicalSort", "by-vibes");
    await plugin(bb);
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { chronologicalSort: string };
    };
    expect(listed.preferences.chronologicalSort).toBe("updated");
  });
});

describe("migration from bb's sidebar preferences", () => {
  it("copies non-default values once and never overwrites a value the plugin already has", async () => {
    const { bb } = setup({
      uiPreferences: {
        "sidebar.organizationMode": { revision: 3, value: "machine" },
        "sidebar.collapsedProjects": { revision: 1, value: ["proj_a"] },
        "sidebar.chronologicalSort": { revision: 0, value: "updated" },
        "sidebar.hiddenGroups": { revision: 2, value: ["not-a-group"] },
      },
    });
    await bb.storage.kv.set("preference:collapsedProjects", ["proj_mine"]);
    const first = await migrateFromUiPreferences(bb);
    expect(first.migrated).toEqual(["organizationMode"]);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBe(
      "machine",
    );
    await expect(bb.storage.kv.get("preference:collapsedProjects")).resolves.toEqual([
      "proj_mine",
    ]);
    await expect(bb.storage.kv.get("preference:chronologicalSort")).resolves.toBeUndefined();
    await expect(bb.storage.kv.get("preference:hiddenGroups")).resolves.toBeUndefined();

    await bb.storage.kv.delete("preference:organizationMode");
    const second = await migrateFromUiPreferences(bb);
    expect(second.migrated).toEqual([]);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBeUndefined();
  });

  it("skips the migration without marking it done when bb cannot be read", async () => {
    const { bb } = setup({ uiPreferencesFail: true });
    expect((await migrateFromUiPreferences(bb)).migrated).toEqual([]);
    await expect(bb.storage.kv.get("migration:ui-preferences:v1")).resolves.toBeUndefined();
  });
});

describe("migration from the thread-list plugin", () => {
  it("copies non-default values once and keeps values this plugin already has", async () => {
    const rpcCalls: RpcCall[] = [];
    const { bb } = setup({
      rpcCalls,
      threadListPreferences: {
        ...defaultPreferences(),
        organizationMode: "project",
        collapsedProjects: ["proj_a"],
        sectionOrder: ["pinned", "project:proj_b", "project:proj_a", "threads"],
        hiddenGroups: ["not-a-group"],
        unknownKey: true,
      },
    });
    await bb.storage.kv.set("preference:collapsedProjects", ["proj_mine"]);

    const first = await migrateFromThreadListPlugin(bb);
    expect(rpcCalls).toEqual([
      { pluginId: "thread-list", method: "listPreferences", input: null },
    ]);
    expect(first.migrated).toEqual(["organizationMode", "sectionOrder"]);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBe(
      "project",
    );
    await expect(bb.storage.kv.get("preference:collapsedProjects")).resolves.toEqual([
      "proj_mine",
    ]);
    await expect(bb.storage.kv.get("preference:hiddenGroups")).resolves.toBeUndefined();

    await bb.storage.kv.delete("preference:organizationMode");
    expect((await migrateFromThreadListPlugin(bb)).migrated).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
  });

  it("retries on a later load when the thread-list plugin cannot be reached", async () => {
    const { bb } = setup({ threadListFail: true });
    expect((await migrateFromThreadListPlugin(bb)).migrated).toEqual([]);
    await expect(
      bb.storage.kv.get("migration:thread-list-plugin:v1"),
    ).resolves.toBeUndefined();
  });

  it("does not copy from itself when loaded as the thread-list plugin", async () => {
    const rpcCalls: RpcCall[] = [];
    const { bb } = setup({ pluginId: "thread-list", rpcCalls });
    expect((await migrateFromThreadListPlugin(bb)).migrated).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("takes the thread-list plugin's values ahead of bb's legacy settings", async () => {
    const { bb } = setup({
      threadListPreferences: {
        ...defaultPreferences(),
        organizationMode: "project",
      },
      uiPreferences: {
        "sidebar.organizationMode": { revision: 3, value: "machine" },
      },
    });
    await plugin(bb);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBe(
      "project",
    );
  });
});

describe("bb grouped-thread-list prefs", () => {
  it("names the CLI after the plugin id", async () => {
    const builtIn = setup();
    await plugin(builtIn.bb);
    expect(builtIn.harness.inspection.registrations.cli?.name).toBe(
      "grouped-thread-list",
    );

    const copy = createFakePluginHost({ pluginId: "my-sidebar" });
    await plugin(copy.bb);
    expect(copy.harness.inspection.registrations.cli?.name).toBe("my-sidebar");
  });

  it("lists, gets, sets, and resets through the CLI", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    const listed = await harness.behavior.runCli(["prefs", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(defaultPreferences());

    const set = await harness.behavior.runCli([
      "prefs",
      "set",
      "manualSectionOrder",
      '["threads","pinned","sections"]',
    ]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toBe('manualSectionOrder = ["threads","pinned","sections"]');

    const bare = await harness.behavior.runCli(["prefs", "set", "organizationMode", "project"]);
    expect(bare.exitCode).toBe(0);

    const got = await harness.behavior.runCli(["prefs", "get", "organizationMode"]);
    expect(got.stdout).toBe('"project"');

    const iconsOn = await harness.behavior.runCli([
      "prefs", "set", "showProviderIcons", "true",
    ]);
    expect(iconsOn.exitCode).toBe(0);
    expect(iconsOn.stdout).toBe("showProviderIcons = true");
    await expect(bb.storage.kv.get("preference:showProviderIcons")).resolves.toBe(true);
    const resetIcons = await harness.behavior.runCli([
      "prefs", "reset", "showProviderIcons", "--json",
    ]);
    expect(JSON.parse(resetIcons.stdout)).toEqual({
      key: "showProviderIcons",
      value: false,
    });

    const bad = await harness.behavior.runCli(["prefs", "set", "organizationMode", "nope"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/Invalid value for organizationMode/);

    const unknown = await harness.behavior.runCli(["prefs", "get", "colour"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toMatch(/Unknown preference: colour/);

    const reset = await harness.behavior.runCli(["prefs", "reset", "organizationMode", "--json"]);
    expect(JSON.parse(reset.stdout)).toEqual({
      key: "organizationMode",
      value: "chronological",
    });
  });
});

it("validates lifecycle selection through CLI and RPC and broadcasts it", async () => {
  const { bb, harness } = setup();
  await plugin(bb);
  expect((await harness.behavior.runCli(["prefs", "set", "threadLifecycles", '["archived"]'])).exitCode).toBe(0);
  await expect(bb.storage.kv.get("preference:threadLifecycles")).resolves.toEqual(["archived"]);
  for (const value of [[], ["archived", "archived"], ["deleted"]]) {
    await expect(harness.behavior.callRpc("setPreference", { key: "threadLifecycles", value })).rejects.toThrow(/Invalid value/);
  }
  await expect(bb.storage.kv.get("preference:threadLifecycles")).resolves.toEqual(["archived"]);
  expect(harness.realtimeSignals).toContainEqual({
    channel: "preferences", payload: { key: "threadLifecycles", value: ["archived"] },
  });
});
