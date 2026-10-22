// Immutable set updates for React state.

/** `set` with every value in or out of it; the same set when that changes nothing, so React skips the render. */
export function withMembers<Value>(set: ReadonlySet<Value>, values: Iterable<Value>, present: boolean): ReadonlySet<Value> {
  const list = [...values];
  if (list.every((value) => set.has(value) === present)) return set;
  const next = new Set(set);
  for (const value of list) {
    if (present) next.add(value);
    else next.delete(value);
  }
  return next;
}

/** `set` with `value` taken out if it was in, else put in. */
export function flipped<Value>(set: ReadonlySet<Value>, value: Value): ReadonlySet<Value> {
  return withMembers(set, [value], !set.has(value));
}
