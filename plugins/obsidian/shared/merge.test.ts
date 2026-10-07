import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeText } from "./merge.ts";

describe("mergeText", () => {
  const base = "# Day\n\n## Inbox\n- 09:00 a\n\n## Work Log\n- did x\n";

  it("combines an inbox append with an edit elsewhere", () => {
    const theirs = base.replace("- 09:00 a\n", "- 09:00 a\n- 10:00 b\n");
    const mine = base.replace("- did x", "- did x and y");
    assert.equal(mergeText(mine, base, theirs), "# Day\n\n## Inbox\n- 09:00 a\n- 10:00 b\n\n## Work Log\n- did x and y\n");
  });

  it("reports overlapping edits", () => {
    assert.equal(mergeText(base.replace("did x", "mine"), base, base.replace("did x", "theirs")), null);
  });

  it("short-circuits identical sides", () => {
    assert.equal(mergeText(base, base, "new"), "new");
    assert.equal(mergeText("mine", base, base), "mine");
  });
});
