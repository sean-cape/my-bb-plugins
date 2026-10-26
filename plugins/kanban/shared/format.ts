/** The first seven characters of a commit sha; `?` for none. */
export function shortSha(sha: string | null): string {
  return sha === null ? "?" : sha.slice(0, 7);
}

/** `1 finding`, `3 findings`; `many` for a noun whose plural isn't an `s`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
