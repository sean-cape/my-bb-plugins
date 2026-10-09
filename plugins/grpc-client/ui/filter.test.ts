import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesQuery } from "./filter.ts";

test("every word of the query must appear, in any order and case", () => {
  assert.ok(matchesQuery("RELEASE_STATE_NOT_SUPPORTED", "not supp"));
  assert.ok(matchesQuery("RELEASE_STATE_NOT_SUPPORTED", "supported NOT"));
  assert.ok(!matchesQuery("RELEASE_STATE_SUPPORTED", "not supp"));
});

test("an empty or blank query matches everything", () => {
  assert.ok(matchesQuery("anything", ""));
  assert.ok(matchesQuery("anything", "   "));
});
