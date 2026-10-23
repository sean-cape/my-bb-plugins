import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { ActivityEvent, Kind, StoredEvent, Summary, SummaryItem, SummaryQuery, TimelineBucket, TimelineQuery } from "../contract";

/** Append-only: the host records each statement's hash by index and refuses to load when a shipped one changes. */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    plugin TEXT,
    route TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    via TEXT,
    count INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS events_at ON events(at)`,
  `CREATE INDEX IF NOT EXISTS events_group ON events(kind, plugin, key)`,
  // Labels once kept a sample of a row's content (a thread's title); a structural key now reads as itself.
  `UPDATE events SET label = key WHERE kind = 'click' AND (key LIKE '% in %' OR key LIKE 'link %')`,
  // Keys of clicks logged before the content rules shipped (2026-10-22 12:47 EDT) held what controls showed: card titles, commands bb ran.
  `DELETE FROM events WHERE kind = 'click' AND at < 1792687678001`,
];

interface Row {
  id: number;
  at: number;
  kind: Kind;
  plugin: string | null;
  route: string;
  key: string;
  label: string;
  via: "pointer" | "keyboard" | null;
  count: number | null;
}

interface ItemRow {
  plugin: string | null;
  kind: Kind;
  key: string;
  label: string;
  count: number;
  pointer: number;
  keyboard: number;
  lastAt: number;
}

export interface Store {
  record(events: readonly ActivityEvent[]): void;
  summary(query: SummaryQuery): Summary;
  /** Events per time bucket in the range; buckets nobody used are left out. */
  timeline(query: TimelineQuery): TimelineBucket[];
  recent(limit: number): StoredEvent[];
  /** Deletes events before `beforeMs`; returns how many went. */
  prune(beforeMs: number): number;
}

/** The plugin's own sqlite file; "bb" in a query's `plugin` means bb's own UI, stored as null. */
export function createStore(bb: BbPluginApi): Store {
  const db: Database.Database = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const insert = db.prepare<[number, string, string | null, string, string, string, string | null, number | null]>(
    `INSERT INTO events (at, kind, plugin, route, key, label, via, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAll = db.transaction((events: readonly ActivityEvent[]) => {
    for (const event of events) insert.run(event.at, event.kind, event.plugin, event.route, event.key, event.label, event.via, event.count);
  });

  const where = (query: Pick<SummaryQuery, "sinceMs" | "untilMs" | "kind" | "plugin">): { sql: string; params: (number | string)[] } => {
    const clauses: string[] = [];
    const params: (number | string)[] = [];
    if (query.sinceMs !== null) {
      clauses.push("at >= ?");
      params.push(query.sinceMs);
    }
    if (query.untilMs !== null && query.untilMs !== undefined) {
      clauses.push("at < ?");
      params.push(query.untilMs);
    }
    if (query.kind !== null) {
      clauses.push("kind = ?");
      params.push(query.kind);
    }
    if (query.plugin !== null) {
      if (query.plugin === "bb") clauses.push("plugin IS NULL");
      else {
        clauses.push("plugin = ?");
        params.push(query.plugin);
      }
    }
    return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
  };

  return {
    record(events) {
      if (events.length > 0) insertAll(events);
    },
    summary(query) {
      const { sql, params } = where(query);
      const total = (db.prepare(`SELECT count(*) AS n FROM events${sql}`).get(...params) as { n: number }).n;
      const plugins = db.prepare(`SELECT plugin, count(*) AS count FROM events${sql} GROUP BY plugin ORDER BY count DESC`).all(...params) as Summary["plugins"];
      const items = db
        .prepare(
          `SELECT plugin, kind, key, max(label) AS label, count(*) AS count,
             sum(via = 'pointer') AS pointer, sum(via = 'keyboard') AS keyboard, max(at) AS lastAt
           FROM events${sql} GROUP BY plugin, kind, key ORDER BY count DESC, lastAt DESC LIMIT ?`,
        )
        .all(...params, query.limit) as ItemRow[];
      const first = db.prepare("SELECT min(at) AS at FROM events").get() as { at: number | null };
      return { total, plugins, items: items.map((item): SummaryItem => ({ ...item, pointer: item.pointer ?? 0, keyboard: item.keyboard ?? 0 })), firstAt: first.at };
    },
    timeline(query) {
      const { sql, params } = where(query);
      // Integer division floors at to its bucket; the offset shifts the boundaries to the client's local midnight.
      // Bound numbers arrive as REAL, so they are cast back or the division would not floor.
      return db
        .prepare(
          `SELECT ((at + CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) - CAST(? AS INTEGER) AS start, count(*) AS count
           FROM events${sql} GROUP BY start ORDER BY start`,
        )
        .all(query.offsetMs, query.bucketMs, query.bucketMs, query.offsetMs, ...params) as TimelineBucket[];
    },
    recent(limit) {
      return (db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((row) => ({ ...row }));
    },
    prune(beforeMs) {
      return db.prepare("DELETE FROM events WHERE at < ?").run(beforeMs).changes;
    },
  };
}
