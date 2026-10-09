/** Whether every space-separated word of `query` appears in `text`, ignoring case. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/**
 * Where `query` occurs in `text`, as vim's smartcase finds it: ignoring case unless the query
 * has a capital letter. Matches don't overlap.
 */
export function findMatches(text: string, query: string): number[] {
  if (query === "") return [];
  const caseSensitive = query !== query.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const offsets: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) offsets.push(at);
  return offsets;
}
