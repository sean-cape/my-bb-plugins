import assert from "node:assert/strict";
import { test } from "node:test";
import { cycle, KEY_HELP, KEYMAP, listAction, type NavRow } from "./client-nav.ts";

// Shop (expanded) with GetOrder and ListOrders, then Users (collapsed).
const tree: NavRow[] = [
  { kind: "group", expanded: true, parent: null },
  { kind: "item", parent: 0 },
  { kind: "item", parent: 0 },
  { kind: "group", expanded: false, parent: null },
];
const results: NavRow[] = [
  { kind: "item", parent: null },
  { kind: "item", parent: null },
];
// A form: name, then an address section holding street and a nested geo section with lat, then age.
const form: NavRow[] = [
  { kind: "item", parent: null },
  { kind: "group", expanded: true, parent: null },
  { kind: "item", parent: 1 },
  { kind: "group", expanded: true, parent: 1 },
  { kind: "item", parent: 3 },
  { kind: "item", parent: null },
];

test("with no cursor, any motion lands on the start row, clamped to the list", () => {
  assert.deepEqual(listAction(tree, null, "down", 2), { kind: "focus", index: 2 });
  assert.deepEqual(listAction(tree, null, "open", 9), { kind: "focus", index: 3 });
  assert.deepEqual(listAction(tree, 7, "up", 0), { kind: "focus", index: 0 });
  assert.equal(listAction([], null, "down", 0), null);
});

test("j/k/gg/G move within the list and stop at its ends", () => {
  assert.deepEqual(listAction(tree, 0, "down", 0), { kind: "focus", index: 1 });
  assert.deepEqual(listAction(tree, 3, "down", 0), { kind: "focus", index: 3 });
  assert.deepEqual(listAction(tree, 0, "up", 0), { kind: "focus", index: 0 });
  assert.deepEqual(listAction(tree, 2, "top", 0), { kind: "focus", index: 0 });
  assert.deepEqual(listAction(tree, 0, "bottom", 0), { kind: "focus", index: 3 });
});

test("l expands a collapsed service, steps into an expanded one, and opens a method", () => {
  assert.deepEqual(listAction(tree, 3, "right", 0), { kind: "activate", index: 3 });
  assert.deepEqual(listAction(tree, 0, "right", 0), { kind: "focus", index: 1 });
  assert.deepEqual(listAction(tree, 2, "right", 0), { kind: "activate", index: 2 });
  assert.equal(listAction([{ kind: "group", expanded: true, parent: null }], 0, "right", 0), null);
});

test("h collapses an expanded service and climbs from a method to its service", () => {
  assert.deepEqual(listAction(tree, 0, "left", 0), { kind: "activate", index: 0 });
  assert.deepEqual(listAction(tree, 2, "left", 0), { kind: "focus", index: 0 });
  assert.equal(listAction(tree, 3, "left", 0), null);
  assert.equal(listAction(results, 1, "left", 0), null);
});

test("h climbs nested sections one level at a time and stops at the top level", () => {
  assert.deepEqual(listAction(form, 4, "left", 0), { kind: "focus", index: 3 });
  assert.deepEqual(listAction(form, 3, "left", 0), { kind: "activate", index: 3 });
  assert.deepEqual(listAction([...form.slice(0, 3), { kind: "group", expanded: false, parent: 1 }], 3, "left", 0), { kind: "focus", index: 1 });
  assert.equal(listAction(form, 5, "left", 0), null);
  assert.equal(listAction(form, 0, "left", 0), null);
});

test("l on a field edits it, and steps into an expanded section", () => {
  assert.deepEqual(listAction(form, 0, "right", 0), { kind: "activate", index: 0 });
  assert.deepEqual(listAction(form, 1, "right", 0), { kind: "focus", index: 2 });
});

test("o activates whatever row the cursor is on", () => {
  assert.deepEqual(listAction(tree, 3, "open", 0), { kind: "activate", index: 3 });
  assert.deepEqual(listAction(results, 1, "open", 0), { kind: "activate", index: 1 });
});

test("tabs cycle in both directions and wrap", () => {
  const tabs = ["body", "metadata", "options"] as const;
  assert.equal(cycle(tabs, "body", 1), "metadata");
  assert.equal(cycle(tabs, "options", 1), "body");
  assert.equal(cycle(tabs, "body", -1), "options");
});

test("every single key in the help is mapped", () => {
  const unmapped = new Set(["gg", "Enter", "Ctrl-d", "Ctrl-u", "⌘↵", "Esc"]);
  for (const { keys } of KEY_HELP) {
    for (const key of keys) if (!unmapped.has(key)) assert.ok(KEYMAP[key] !== undefined, `${key} is listed but not mapped`);
  }
});
