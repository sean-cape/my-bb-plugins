import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActivityEvent, Summary, TimelineBucket } from "./contract";
import plugin from "./server";

type Host = ReturnType<typeof createFakePluginHost>;
let host: Host;

const NOW = Date.UTC(2026, 9, 21, 12);
const DAY = 86_400_000;

const event = (overrides: Partial<ActivityEvent>): ActivityEvent => ({
  at: NOW,
  kind: "click",
  plugin: "kanban",
  route: "/plugins/kanban/board",
  key: "Refresh board",
  label: "Refresh board",
  via: "pointer",
  count: null,
  ...overrides,
});

beforeEach(async () => {
  host = createFakePluginHost({ pluginId: "activity" });
  await plugin(host.bb);
});

afterEach(async () => {
  await host.harness.lifecycle.dispose();
});

async function seed() {
  await host.harness.behavior.callRpc("record", {
    events: [
      event({}),
      event({ at: NOW - 60_000, via: "keyboard" }),
      event({ at: NOW - 2 * DAY, key: "Submit review", label: "Submit review" }),
      event({ kind: "command", plugin: "kanban", key: "gg", label: "gg", via: null }),
      event({ kind: "command", plugin: "obsidian", route: "/plugins/obsidian/vault", key: "j", label: "j", via: null, count: 5 }),
      event({ kind: "key", plugin: null, route: "/threads/*", key: "<D-k>", label: "<D-k>", via: null }),
      event({ kind: "route", plugin: null, route: "/threads/*", key: "/threads/*", label: "/threads/*", via: null, at: NOW - 40 * DAY }),
    ],
  });
}

describe("activity server", () => {
  it("ranks what was recorded, by plugin and by control, within a range", async () => {
    await seed();
    const all = (await host.harness.behavior.callRpc("summary", { sinceMs: null, kind: null, plugin: null, limit: 100 })) as Summary;
    expect(all.total).toBe(7);
    expect(all.plugins).toEqual([
      { plugin: "kanban", count: 4 },
      { plugin: null, count: 2 },
      { plugin: "obsidian", count: 1 },
    ]);
    expect(all.items[0]).toEqual({ plugin: "kanban", kind: "click", key: "Refresh board", label: "Refresh board", count: 2, pointer: 1, keyboard: 1, lastAt: NOW });
    expect(all.firstAt).toBe(NOW - 40 * DAY);

    const week = (await host.harness.behavior.callRpc("summary", { sinceMs: NOW - 7 * DAY, kind: null, plugin: null, limit: 100 })) as Summary;
    expect(week.total).toBe(6);

    const bbKeys = (await host.harness.behavior.callRpc("summary", { sinceMs: null, kind: "key", plugin: "bb", limit: 100 })) as Summary;
    expect(bbKeys.items.map((item) => item.key)).toEqual(["<D-k>"]);

    const window = (await host.harness.behavior.callRpc("summary", { sinceMs: NOW - 3 * DAY, untilMs: NOW - DAY, kind: null, plugin: null, limit: 100 })) as Summary;
    expect(window.items.map((item) => item.key)).toEqual(["Submit review"]);

    const commands = (await host.harness.behavior.callRpc("summary", { sinceMs: null, kind: "command", plugin: null, limit: 100 })) as Summary;
    expect(commands.items.map((item) => [item.plugin, item.key])).toEqual([
      ["kanban", "gg"],
      ["obsidian", "j"],
    ]);
  });

  it("buckets events over time, with day boundaries at the client's midnight", async () => {
    await seed();
    const buckets = (await host.harness.behavior.callRpc("timeline", { sinceMs: NOW - 7 * DAY, untilMs: null, kind: null, plugin: null, bucketMs: DAY, offsetMs: 0 })) as TimelineBucket[];
    expect(buckets).toEqual([
      { start: NOW - 2 * DAY - 12 * 3_600_000, count: 1 },
      { start: NOW - 12 * 3_600_000, count: 5 },
    ]);
    // Six hours east of UTC, noon UTC is 18:00 local and the day started at 06:00 UTC.
    const east = (await host.harness.behavior.callRpc("timeline", { sinceMs: NOW - DAY, untilMs: null, kind: "click", plugin: null, bucketMs: DAY, offsetMs: 6 * 3_600_000 })) as TimelineBucket[];
    expect(east).toEqual([{ start: NOW - 18 * 3_600_000, count: 2 }]);
    const hours = (await host.harness.behavior.callRpc("timeline", { sinceMs: NOW - DAY, untilMs: null, kind: null, plugin: "kanban", bucketMs: 3_600_000, offsetMs: 0 })) as TimelineBucket[];
    expect(hours).toEqual([
      { start: NOW - 3_600_000, count: 1 },
      { start: NOW, count: 2 },
    ]);
  });

  it("scrubs content out of labels that structural keys once carried", async () => {
    await host.harness.behavior.callRpc("record", { events: [event({ key: "option in Unread threads", label: "MB the sizing seems wrong" }), event({ key: "link /threads/*", label: "Fix the login bug" }), event({ key: "View changes", label: "View changes" })] });
    // The host runs migrations on load; a database with rows from before the scrub meets it on the next load.
    host.bb.storage.database().prepare("DELETE FROM _bb_migrations WHERE id = 3").run();
    host = await host.harness.lifecycle.reload(plugin);
    const all = (await host.harness.behavior.callRpc("summary", { sinceMs: null, kind: null, plugin: null, limit: 10 })) as Summary;
    expect(all.items.map((item) => item.label).sort()).toEqual(["View changes", "link /threads/*", "option in Unread threads"]);
  });

  it("drops clicks logged before the content rules, keeping keys and later clicks", async () => {
    const shipped = 1792687678001;
    await host.harness.behavior.callRpc("record", {
      events: [
        event({ at: shipped - 1, key: "<button> in Fix the widget cache", label: "<button> in Fix the widget cache" }),
        event({ at: shipped - 1, kind: "key", key: "j", label: "j", via: null }),
        event({ at: shipped, key: "View changes", label: "View changes" }),
      ],
    });
    host.bb.storage.database().prepare("DELETE FROM _bb_migrations WHERE id = 4").run();
    host = await host.harness.lifecycle.reload(plugin);
    const all = (await host.harness.behavior.callRpc("summary", { sinceMs: null, kind: null, plugin: null, limit: 10 })) as Summary;
    expect(all.items.map((item) => item.key).sort()).toEqual(["View changes", "j"]);
  });

  it("refuses a batch over the limit or with a bad shape", async () => {
    await expect(host.harness.behavior.callRpc("record", { events: [{ ...event({}), kind: "hover" }] })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("record", { events: Array.from({ length: 501 }, () => event({})) })).rejects.toThrow();
  });

  it("answers bb activity top, plugins, recent, and prune", async () => {
    await seed();
    const top = await host.harness.behavior.runCli(["top", "--since", "all", "--limit", "3"]);
    expect(top.exitCode).toBe(0);
    expect(String(top.stdout)).toContain("7 events");
    expect(String(top.stdout)).toContain("Refresh board");
    expect(String(top.stdout)).toContain("1 mouse / 1 keys");

    const clicks = await host.harness.behavior.runCli(["top", "--kind", "click", "--plugin", "kanban", "--json"]);
    const parsed = JSON.parse(String(clicks.stdout)) as Summary;
    expect(parsed.items.map((item) => item.key)).toEqual(["Refresh board", "Submit review"]);

    const plugins = await host.harness.behavior.runCli(["plugins", "--since", "all"]);
    expect(String(plugins.stdout).split("\n")).toEqual(["count  plugin", "4      kanban", "2      bb", "1      obsidian"]);

    const recent = await host.harness.behavior.runCli(["recent", "--limit", "2", "--json"]);
    const events = JSON.parse(String(recent.stdout)) as ActivityEvent[];
    expect(events.map((row) => row.key)).toEqual(["/threads/*", "<D-k>"]);

    const bad = await host.harness.behavior.runCli(["top", "--since", "soon"]);
    expect(bad.exitCode).not.toBe(0);

    const pruned = await host.harness.behavior.runCli(["prune", "--before", "30d"]);
    expect(String(pruned.stdout)).toBe("Deleted 1 events.");
    const after = (await host.harness.behavior.callRpc("summary", { sinceMs: null, kind: null, plugin: null, limit: 1 })) as Summary;
    expect(after.total).toBe(6);
  });
});
