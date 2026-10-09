// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  extractEntries,
  findEntryElement,
  markTerms,
  pageEntry,
  searchEntries,
  type SettingEntry,
} from "./settings-index.js";

const row = (label: string, description?: string) => `
  <div data-control-placement="inline">
    <div class="min-w-0 flex-1">
      <div class="flex"><p class="min-w-0 text-sm font-normal">${label}</p></div>
      ${description ? `<p class="mt-0.5 text-xs leading-snug">${description}</p>` : ""}
    </div>
    <div><button role="switch" aria-label="${label}"><p class="text-sm">Not a label</p></button></div>
  </div>`;

function viewport(html: string): Element {
  document.body.innerHTML = `<div data-page-scroll-viewport>${html}</div>`;
  return document.querySelector("[data-page-scroll-viewport]")!;
}

const general = { href: "/settings", title: "General" };

describe("extractEntries", () => {
  it("reads each setting's label, description, and section", () => {
    const entries = extractEntries(
      viewport(`
        <section><h2>Threads &amp; editing</h2>${row("Navigate to threads on creation")}</section>
        <section><h2>Git</h2>${row("New branch prefix", "bb puts this in front of every branch.")}</section>`),
      general,
    );
    expect(entries).toEqual([
      expect.objectContaining({ kind: "heading", label: "Threads & editing", section: null }),
      expect.objectContaining({
        kind: "setting",
        label: "Navigate to threads on creation",
        section: "Threads & editing",
        description: null,
      }),
      expect.objectContaining({ kind: "heading", label: "Git" }),
      expect.objectContaining({
        kind: "setting",
        href: "/settings",
        page: "General",
        label: "New branch prefix",
        section: "Git",
        description: "bb puts this in front of every branch.",
      }),
    ]);
  });

  it("leaves out the page's own title and text inside controls", () => {
    const entries = extractEntries(
      viewport(`<h2>Appearance</h2>${row("Theme")}<a href="/x"><p class="text-sm">A link</p></a>`),
      { href: "/settings/appearance", title: "Appearance" },
    );
    expect(entries.map((entry) => entry.label)).toEqual(["Theme"]);
    expect(entries[0]!.section).toBeNull();
  });

  it("files rows under an h3 only while they sit inside its group", () => {
    const entries = extractEntries(
      viewport(`
        <h2>Configuration</h2>
        ${row("Allow faster service tiers")}
        <div class="mt-4">
          <div><h3>Collapse finished turns</h3><p class="mt-0.5 text-xs">Fold finished work.</p></div>
          <div>${row("Claude Code")}</div>
        </div>
        ${row("After the group")}`),
      { href: "/settings/providers", title: "Providers" },
    );
    const byLabel = Object.fromEntries(entries.map((entry) => [entry.label, entry]));
    expect(byLabel["Allow faster service tiers"]!.section).toBe("Configuration");
    expect(byLabel["Collapse finished turns"]).toMatchObject({
      kind: "heading",
      section: "Configuration",
      description: "Fold finished work.",
    });
    expect(byLabel["Claude Code"]!.section).toBe("Collapse finished turns");
    expect(byLabel["After the group"]!.section).toBe("Configuration");
  });

  it("finds a repeated label again by its position on the page", () => {
    const page = viewport(`<h2>Claude</h2>${row("Model")}<h2>Codex</h2>${row("Model")}`);
    const second = extractEntries(page, general).filter((entry) => entry.label === "Model")[1]!;
    expect(second).toMatchObject({ section: "Codex", occurrence: 1 });
    const element = findEntryElement(page, second);
    expect(element?.closest("[data-control-placement]")).toBe(
      page.querySelectorAll("[data-control-placement]")[1],
    );
  });
});

describe("searchEntries", () => {
  const entry = (label: string, more: Partial<SettingEntry> = {}): SettingEntry => ({
    kind: "setting",
    href: "/settings",
    page: "General",
    section: null,
    label,
    description: null,
    occurrence: 0,
    ...more,
  });

  it("ranks label word starts over label text, page or section, and descriptions", () => {
    const entries = [
      entry("Notes", { description: "Shown as a theme preview." }),
      entry("Dark theme"),
      entry("Palette", { section: "Theme" }),
      entry("Retheme"),
    ];
    expect(searchEntries(entries, "theme").map((found) => found.label)).toEqual([
      "Dark theme",
      "Retheme",
      "Palette",
      "Notes",
    ]);
  });

  it("needs every term to match somewhere", () => {
    const entries = [
      entry("New branch prefix", { section: "Git" }),
      entry("Branch colors"),
    ];
    expect(searchEntries(entries, "git branch").map((found) => found.label)).toEqual(["New branch prefix"]);
  });

  it("puts a page whose name matches ahead of settings that mention it", () => {
    const entries = [entry("Vim keys in the browser"), pageEntry({ href: "/settings/browser", title: "Browser" })];
    expect(searchEntries(entries, "browser")[0]).toMatchObject({ kind: "page", label: "Browser" });
  });

  it("finds nothing for a blank query", () => {
    expect(searchEntries([entry("Theme")], "   ")).toEqual([]);
  });
});

describe("markTerms", () => {
  it("flags every match of every term, case-insensitively", () => {
    expect(markTerms("New branch prefix", ["branch", "pre"])).toEqual([
      { text: "New ", hit: false },
      { text: "branch", hit: true },
      { text: " ", hit: false },
      { text: "pre", hit: true },
      { text: "fix", hit: false },
    ]);
  });
});
