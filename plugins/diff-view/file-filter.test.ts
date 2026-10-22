import { describe, expect, it } from "vitest";
import {
  NO_EXTENSION,
  NO_FILE_FILTER,
  changeTypeOf,
  extensionOf,
  fileFilterActive,
  filterFiles,
  filterOptions,
  pruneFileFilter,
  readFileFilter,
  toggleChangeType,
  toggleExtension,
  writeFileFilter,
  type FileMarks,
} from "./lib/app/file-filter";
import { REVIEW_KEYMAP } from "./lib/app/keys/keymap";
import { COMMENTS_KEYMAP } from "./lib/app/comments/comments-keymap";
import { NARRATIVE_KEYMAP } from "./lib/app/narrative/narrative-keymap";
import { runReviewCommand } from "./lib/app/keys/review-commands";
import { reviewEnv } from "./test-helpers";

const file = (path: string, status = "modified") => ({ path, status });

const FILES = [
  file("src/a.ts"),
  file("src/b.TS", "added"),
  file("README.md", "renamed"),
  file("Makefile", "removed"),
  file(".gitignore", "copied"),
  file("src/old.ts", "deleted"),
];

const NO_MARKS: FileMarks = { viewed: new Set(), withComments: new Set(), withFindings: new Set() };
const paths = (files: readonly { path: string }[]) => files.map((entry) => entry.path);

describe("file filter", () => {
  it("groups files by lower-cased extension, with dotfiles and bare names under no extension", () => {
    expect(FILES.map((entry) => extensionOf(entry.path))).toEqual([".ts", ".ts", ".md", NO_EXTENSION, NO_EXTENSION, ".ts"]);
    expect(extensionOf("dir.v2/file")).toBe(NO_EXTENSION);
    expect(extensionOf("trailing.")).toBe(NO_EXTENSION);
  });

  it("maps git statuses onto GitHub's four change types", () => {
    expect(FILES.map(changeTypeOf)).toEqual(["modified", "added", "renamed", "deleted", "renamed", "deleted"]);
  });

  it("lists each extension present alphabetically with no extension last, and only the change types present", () => {
    const options = filterOptions(FILES.slice(0, 4));
    expect(options.extensions).toEqual([
      { value: ".md", count: 1 },
      { value: ".ts", count: 2 },
      { value: NO_EXTENSION, count: 1 },
    ]);
    expect(options.changeTypes.map((option) => option.value)).toEqual(["added", "modified", "renamed", "deleted"]);
    expect(filterOptions([file("a.ts")]).changeTypes).toEqual([{ value: "modified", count: 1 }]);
  });

  it("leaves the list alone with no filter on", () => {
    expect(fileFilterActive(NO_FILE_FILTER)).toBe(false);
    expect(filterFiles(FILES, NO_FILE_FILTER, NO_MARKS)).toBe(FILES);
  });

  it("drops unticked extensions and change types, keeping diff order", () => {
    const noTs = toggleExtension(NO_FILE_FILTER, ".ts");
    expect(paths(filterFiles(FILES, noTs, NO_MARKS))).toEqual(["README.md", "Makefile", ".gitignore"]);
    expect(paths(filterFiles(FILES, toggleExtension(noTs, NO_EXTENSION), NO_MARKS))).toEqual(["README.md"]);
    expect(toggleExtension(noTs, ".ts")).toEqual(NO_FILE_FILTER);
    expect(paths(filterFiles(FILES, toggleChangeType(NO_FILE_FILTER, "deleted"), NO_MARKS))).toEqual(["src/a.ts", "src/b.TS", "README.md", ".gitignore"]);
  });

  it("hides viewed files, and keeps only files with comments or findings, all together", () => {
    const marks: FileMarks = { viewed: new Set(["src/a.ts"]), withComments: new Set(["src/a.ts", "README.md"]), withFindings: new Set(["README.md", "Makefile"]) };
    expect(paths(filterFiles(FILES, { ...NO_FILE_FILTER, hideViewed: true }, marks))).toEqual(["src/b.TS", "README.md", "Makefile", ".gitignore", "src/old.ts"]);
    expect(paths(filterFiles(FILES, { ...NO_FILE_FILTER, onlyComments: true }, marks))).toEqual(["src/a.ts", "README.md"]);
    expect(paths(filterFiles(FILES, { ...NO_FILE_FILTER, onlyFindings: true }, marks))).toEqual(["README.md", "Makefile"]);
    expect(paths(filterFiles(FILES, { ...NO_FILE_FILTER, hideViewed: true, onlyComments: true, onlyFindings: true }, marks))).toEqual(["README.md"]);
  });

  it("drops unticked choices the files no longer have, rather than keeping a filter that leaves nothing out", () => {
    const filter = toggleChangeType(toggleExtension(NO_FILE_FILTER, ".md"), "added");
    expect(pruneFileFilter(filter, FILES)).toBe(filter);
    expect(pruneFileFilter(filter, [file("a.ts")])).toBe(NO_FILE_FILTER);
    const kept = pruneFileFilter({ ...filter, hideViewed: true }, [file("a.md")]);
    expect([...kept.hiddenExtensions, ...kept.hiddenChangeTypes, kept.hideViewed]).toEqual([".md", true]);
  });

  it("keeps a filter per view instance, and forgets a cleared one", () => {
    const filter = toggleExtension(NO_FILE_FILTER, ".md");
    writeFileFilter("view-a", filter);
    expect(readFileFilter("view-a")).toBe(filter);
    expect(readFileFilter("view-b")).toBe(NO_FILE_FILTER);
    writeFileFilter("view-a", toggleExtension(filter, ".md"));
    expect(readFileFilter("view-a")).toBe(NO_FILE_FILTER);
  });
});

describe("file filter keys", () => {
  it("opens the menu on gf in the files view; the narrative and the comments view keep their own gf", () => {
    expect(REVIEW_KEYMAP.gf).toEqual({ kind: "fileFilter" });
    expect(NARRATIVE_KEYMAP.gf).toEqual({ kind: "openInFiles" });
    expect(COMMENTS_KEYMAP.gf).toEqual({ kind: "openInFiles" });
  });

  it("opens the menu before there is a line, even with every file filtered out", () => {
    const opened: string[] = [];
    const { env } = reviewEnv({ openOverlay: (kind: string) => opened.push(kind) });
    runReviewCommand({ kind: "fileFilter" }, 1, env);
    expect(opened).toEqual(["fileFilter"]);
  });
});
