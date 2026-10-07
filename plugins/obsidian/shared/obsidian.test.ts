import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResolver, parseHeadings, parseLinks, relativeMarkdownUrl, rewriteLinks } from "./obsidian.ts";

describe("parseLinks", () => {
  it("parses wikilinks with subpaths, aliases, and embeds", () => {
    const links = parseLinks("See [[Projects/Plan#Goals|the plan]] and ![[diagram.png]].");
    assert.equal(links.length, 2);
    assert.deepEqual(
      links.map(({ kind, embed, target, subpath, alias }) => ({ kind, embed, target, subpath, alias })),
      [
        { kind: "wiki", embed: false, target: "Projects/Plan", subpath: "Goals", alias: "the plan" },
        { kind: "wiki", embed: true, target: "diagram.png", subpath: null, alias: null },
      ],
    );
    const source = "See [[Projects/Plan#Goals|the plan]]";
    assert.equal(source.slice(links[0]!.targetFrom, links[0]!.targetTo), "Projects/Plan");
  });

  it("parses relative markdown links and skips external URLs", () => {
    const content = "[a](../Other%20Note.md#Top) [b](https://example.com) [c](#local)";
    const links = parseLinks(content);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.target, "../Other Note.md");
    assert.equal(links[0]!.subpath, "Top");
    assert.equal(content.slice(links[0]!.targetFrom, links[0]!.targetTo), "../Other%20Note.md");
  });

  it("ignores links in code fences and inline code but reads frontmatter", () => {
    const content = "---\nrelated: \"[[Alpha]]\"\n---\n`[[Beta]]`\n```\n[[Gamma]]\n```\n[[Delta]]";
    assert.deepEqual(parseLinks(content).map((link) => link.target), ["Alpha", "Delta"]);
  });

  it("only closes a fence on a bare marker and sees fences nested in lists", () => {
    const content = "```\n```js\n[[InCode]]\n```\n[[After]]\n- item\n    ```\n    [[Nested]]\n    ```";
    assert.deepEqual(parseLinks(content).map((link) => link.target), ["After"]);
  });

  it("treats escaped pipes in tables as alias separators", () => {
    assert.equal(parseLinks("| [[Note\\|Alias]] |")[0]!.alias, "Alias");
  });
});

describe("parseHeadings", () => {
  it("skips frontmatter and fenced code", () => {
    const content = "---\ntitle: x\n---\n# One\n```\n# not a heading\n```\n## Two ##";
    assert.deepEqual(parseHeadings(content).map(({ level, text, line }) => ({ level, text, line })), [
      { level: 1, text: "One", line: 3 },
      { level: 2, text: "Two", line: 7 },
    ]);
  });
});

describe("createResolver", () => {
  const resolver = createResolver(["Inbox.md", "Projects/Plan.md", "Archive/Plan.md", "assets/diagram.png", "Projects/Sub/Deep.md"]);

  it("resolves by basename case-insensitively", () => {
    assert.equal(resolver.resolve("inbox", "Projects/Plan.md"), "Inbox.md");
    assert.equal(resolver.resolve("diagram.png", "Inbox.md"), "assets/diagram.png");
  });

  it("prefers the candidate in the source folder for ambiguous names", () => {
    assert.equal(resolver.resolve("Plan", "Archive/Other.md"), "Archive/Plan.md");
    assert.equal(resolver.resolve("Plan", "Projects/Sub/Deep.md"), "Projects/Plan.md");
    assert.equal(resolver.resolve("Plan", "Inbox.md"), "Archive/Plan.md");
  });

  it("resolves path-qualified and relative targets", () => {
    assert.equal(resolver.resolve("Projects/Plan", "Inbox.md"), "Projects/Plan.md");
    assert.equal(resolver.resolve("Sub/Deep", "Inbox.md"), "Projects/Sub/Deep.md");
    assert.equal(resolver.resolve("../Plan.md", "Projects/Sub/Deep.md", "markdown"), "Projects/Plan.md");
    assert.equal(resolver.resolve("../../../etc/passwd", "Inbox.md", "markdown"), null);
    assert.equal(createResolver(["Plan.md", "Projects/Plan.md"]).resolve("/Plan.md", "Projects/Other.md", "markdown"), "Plan.md");
  });

  it("uses the shortest unambiguous link text", () => {
    assert.equal(resolver.linkTextFor("Inbox.md"), "Inbox");
    assert.equal(resolver.linkTextFor("Projects/Plan.md"), "Projects/Plan");
  });
});

describe("rewriteLinks", () => {
  it("rewrites links that no longer resolve after a rename and leaves the rest", () => {
    const before = ["Inbox.md", "Projects/Plan.md", "Daily.md"];
    const remap = new Map([["Projects/Plan.md", "Projects/Roadmap.md"]]);
    const after = before.map((path) => remap.get(path) ?? path);
    const result = rewriteLinks({
      content: "[[Plan#Goals|goals]] [[Inbox]] [x](Projects/Plan.md)",
      oldSourcePath: "Daily.md",
      newSourcePath: "Daily.md",
      oldResolver: createResolver(before),
      newResolver: createResolver(after),
      remap,
    });
    assert.equal(result, "[[Roadmap#Goals|goals]] [[Inbox]] [x](Projects/Roadmap.md)");
  });

  it("keeps basename links valid when a uniquely named note moves folders", () => {
    const remap = new Map([["Plan.md", "Archive/Plan.md"]]);
    const result = rewriteLinks({
      content: "[[Plan]]",
      oldSourcePath: "Daily.md",
      newSourcePath: "Daily.md",
      oldResolver: createResolver(["Plan.md", "Daily.md"]),
      newResolver: createResolver(["Archive/Plan.md", "Daily.md"]),
      remap,
    });
    assert.equal(result, null);
  });

  it("fixes relative markdown links inside a note that moved", () => {
    const remap = new Map([["Notes/Sub/A.md", "Notes/A.md"]]);
    const result = rewriteLinks({
      content: "[b](../B.md)",
      oldSourcePath: "Notes/Sub/A.md",
      newSourcePath: "Notes/A.md",
      oldResolver: createResolver(["Notes/Sub/A.md", "Notes/B.md"]),
      newResolver: createResolver(["Notes/A.md", "Notes/B.md"]),
      remap,
    });
    assert.equal(result, "[b](B.md)");
  });
});

describe("relativeMarkdownUrl", () => {
  it("percent-encodes segments", () => {
    assert.equal(relativeMarkdownUrl("A/B/note.md", "A/C/My Note.md"), "../C/My%20Note.md");
  });
});
