import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeTurns, type Row } from "../timeline.ts";

const prompt = (id: string, text: string): Row => ({
  kind: "conversation",
  role: "user",
  id,
  text,
  turnId: null,
  createdAt: 1,
});

test("wraps a finished turn with the prompt before it and the reply after it", () => {
  const rows: Row[] = [
    prompt("p1", "Fix the bug"),
    { kind: "system", turnId: null },
    {
      kind: "turn",
      turnId: "t1",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
      children: [{ kind: "work", workKind: "command", turnId: "t1" }],
    },
    { kind: "conversation", role: "assistant", turnId: "t1", text: "Done" },
  ];
  const turns = normalizeTurns(rows, false);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.status, "completed");
  assert.deepEqual(
    turns[0]!.children.map((row) => row.role ?? row.workKind),
    ["user", "command", "assistant"],
  );
});

test("groups a live turn's flat rows and keeps only the newest pending", () => {
  const rows: Row[] = [
    { kind: "work", workKind: "tool", turnId: "t1", startedAt: 5 },
    { kind: "work", workKind: "tool", turnId: "t2", startedAt: 9 },
    { kind: "work", workKind: "command", turnId: "t2" },
  ];
  const turns = normalizeTurns(rows, true);
  assert.deepEqual(
    turns.map((turn) => [turn.turnId, turn.status, turn.children.length]),
    [
      ["t1", "completed", 1],
      ["t2", "pending", 2],
    ],
  );
  assert.equal(turns[0]!.startedAt, 5);
});

test("turns a trailing prompt into a pending turn only while running", () => {
  const rows = [prompt("p9", "Next question")];
  assert.equal(normalizeTurns(rows, false).length, 0);
  const [turn] = normalizeTurns(rows, true);
  assert.equal(turn!.status, "pending");
  assert.equal(turn!.children[0]!.text, "Next question");
});

test("never mutates the input rows", () => {
  const children = [{ kind: "work", turnId: "t1" }];
  const rows: Row[] = [{ kind: "turn", turnId: "t1", status: "completed", children }];
  normalizeTurns(rows, false);
  assert.equal(children.length, 1);
});
