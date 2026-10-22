import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { migrate } from "./db/migrations";
import type { KanbanDatabase } from "./db/statements";

function statements(): string[] {
  let captured: string[] = [];
  const bb = { storage: { migrate: (_db: unknown, list: string[]) => (captured = list) } } as unknown as BbPluginApi;
  migrate(bb, null as unknown as KanbanDatabase);
  return captured;
}

/** Where b927548 shipped its brain-dump integration statements; the host checks each statement's hash by index. */
const INTEGRATIONS_AT = 84;

/** The statements as b927548 shipped them, byte for byte. */
const SHIPPED = [
  `CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      dump_id TEXT NOT NULL UNIQUE,
      ticket_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      commit_sha TEXT,
      check_exit_code INTEGER,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS integrations_ticket ON integrations(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS integrations_thread ON integrations(thread_id)`,
  `CREATE TABLE IF NOT EXISTS integration_members (
      integration_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      head_sha TEXT,
      branch TEXT,
      outcome TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (integration_id, ticket_id)
    )`,
  `CREATE INDEX IF NOT EXISTS integration_members_ticket ON integration_members(ticket_id)`,
];

describe("kanban migrations", () => {
  it("keep the reverted brain-dump statements where b927548 shipped them", () => {
    expect(statements().slice(INTEGRATIONS_AT, INTEGRATIONS_AT + SHIPPED.length)).toEqual(SHIPPED);
  });

  it("drop those tables after them, before the comment hunk columns", () => {
    const list = statements();
    const after = INTEGRATIONS_AT + SHIPPED.length;
    expect(list.slice(after, after + 2)).toEqual([`DROP TABLE IF EXISTS integration_members`, `DROP TABLE IF EXISTS integrations`]);
    expect(list.slice(after + 2, after + 5)).toEqual([
      `ALTER TABLE pr_comments ADD COLUMN diff_hunk TEXT`,
      `ALTER TABLE pr_comments ADD COLUMN original_line INTEGER`,
      `ALTER TABLE pr_comments ADD COLUMN original_start_line INTEGER`,
    ]);
  });
});
