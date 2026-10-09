import { describe, expect, it, vi } from "vitest";
import { crawlPages } from "./crawler.js";

const pages = [
  { href: "/settings/a", title: "A" },
  { href: "/settings/b", title: "B" },
  { href: "/settings/c", title: "C" },
];

describe("crawlPages", () => {
  it("skips a page that fails to load and keeps going", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    await crawlPages(
      pages,
      async (page) => {
        if (page.href === "/settings/b") throw new Error("boom");
        return [];
      },
      (page) => seen.push(page.href),
      new AbortController().signal,
    );
    expect(seen).toEqual(["/settings/a", "/settings/c"]);
  });

  it("stops at the page in flight when aborted", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    await crawlPages(
      pages,
      async () => {
        controller.abort();
        return [];
      },
      (page) => seen.push(page.href),
      controller.signal,
    );
    expect(seen).toEqual([]);
  });
});
