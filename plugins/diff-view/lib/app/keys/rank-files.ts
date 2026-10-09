import type { DiffFile } from "../../types";

/** Characters of `query` in order within `path`, case-insensitively; matches on the file name rank first. */
export function rankFiles(files: readonly DiffFile[], query: string): DiffFile[] {
  const needle = query.toLowerCase().replace(/\s+/gu, "");
  if (needle === "") return [...files];
  const subsequence = (haystack: string) => {
    let at = 0;
    for (const char of haystack) if (char === needle[at]) at += 1;
    return at === needle.length;
  };
  const scored = files.flatMap((file) => {
    const path = file.path.toLowerCase();
    if (!subsequence(path)) return [];
    const name = path.slice(path.lastIndexOf("/") + 1);
    return [{ file, score: name.includes(needle) ? 0 : path.includes(needle) ? 1 : subsequence(name) ? 2 : 3 }];
  });
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.file);
}
