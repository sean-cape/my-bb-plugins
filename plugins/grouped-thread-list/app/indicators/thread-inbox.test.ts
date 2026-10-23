import { describe, expect, it } from "vitest";
import { createThreadProjectResolver } from "../model/active-project.js";
import { makeSidebarThread } from "../model/fixtures.js";
import {
  buildThreadInbox,
  describeInbox,
  formatBadgeCount,
} from "./thread-inbox.js";

const read = { lastReadAt: 10, latestAttentionAt: 10 };

function inbox(threads: ReturnType<typeof makeSidebarThread>[]) {
  const result = buildThreadInbox(threads, createThreadProjectResolver(threads));
  return {
    needsYou: result.needsYou.map((thread) => thread.id),
    running: result.running.map((thread) => thread.id),
    pinned: result.pinned.map((thread) => thread.id),
  };
}

describe("buildThreadInbox", () => {
  it("splits unread and running threads the way the picker's Unread list does", () => {
    expect(
      inbox([
        makeSidebarThread({ id: "thr_unread", latestAttentionAt: 5, lastReadAt: 1 }),
        makeSidebarThread({
          id: "thr_running",
          providerId: "claude-code",
          status: "active",
          runtimeStatus: "active",
          ...read,
        }),
        makeSidebarThread({
          id: "thr_asking",
          providerId: "claude-code",
          status: "active",
          runtimeStatus: "active",
          hasPendingInteraction: true,
          ...read,
        }),
        makeSidebarThread({ id: "thr_quiet", ...read }),
      ]),
    ).toEqual({
      needsYou: ["thr_asking", "thr_unread"],
      running: ["thr_running"],
      pinned: [],
    });
  });

  it("lists an unread automation run like any thread, and leaves out hidden threads", () => {
    expect(
      inbox([
        makeSidebarThread({ id: "thr_automation", originPluginId: "automations" }),
        makeSidebarThread({ id: "thr_hidden", isHidden: true }),
      ]),
    ).toEqual({ needsYou: ["thr_automation"], running: [], pinned: [] });
  });

  it("lists pinned roots in pin order, without their children", () => {
    expect(
      inbox([
        makeSidebarThread({ id: "thr_second", pinnedAt: 1, pinSortKey: "b", ...read }),
        makeSidebarThread({ id: "thr_first", pinnedAt: 2, pinSortKey: "a", ...read }),
        makeSidebarThread({ id: "thr_child", parentThreadId: "thr_first", ...read }),
      ]).pinned,
    ).toEqual(["thr_first", "thr_second"]);
  });
});

describe("labels", () => {
  it("caps badge counts", () => {
    expect(formatBadgeCount(7)).toBe("7");
    expect(formatBadgeCount(100)).toBe("99+");
  });

  it("names both counts", () => {
    expect(describeInbox(1, 0)).toBe("1 thread needs you, 0 running");
    expect(describeInbox(2, 3)).toBe("2 threads need you, 3 running");
  });
});
