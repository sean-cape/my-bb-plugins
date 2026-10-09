import assert from "node:assert/strict";
import { test } from "node:test";
import { findMatches, matchesQuery } from "./filter.ts";

test("every word of the query must appear, in any order and case", () => {
  assert.ok(matchesQuery("RELEASE_STATE_NOT_SUPPORTED", "not supp"));
  assert.ok(matchesQuery("RELEASE_STATE_NOT_SUPPORTED", "supported NOT"));
  assert.ok(!matchesQuery("RELEASE_STATE_SUPPORTED", "not supp"));
});

test("an empty or blank query matches everything", () => {
  assert.ok(matchesQuery("anything", ""));
  assert.ok(matchesQuery("anything", "   "));
});

test("search ignores case for a lowercase query and respects it once the query has a capital", () => {
  assert.deepEqual(findMatches("Role role ROLE", "role"), [0, 5, 10]);
  assert.deepEqual(findMatches("Role role ROLE", "Role"), [0]);
});

test("matches don't overlap, and an empty query finds nothing", () => {
  assert.deepEqual(findMatches("aaaa", "aa"), [0, 2]);
  assert.deepEqual(findMatches("anything", ""), []);
});
