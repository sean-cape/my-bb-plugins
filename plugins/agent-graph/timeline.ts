// Pure helpers for reading bb thread timelines. No SDK imports, so they are
// easy to unit test (see tests/).

/** A timeline row read loosely, so new row kinds never break the graph. */
export type Row = Record<string, unknown>;

export interface NormalizedTurn {
  turnId: string;
  /** Timeline row status: "pending" | "completed" | "error" | "interrupted". */
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  /** The user's prompt (if known), then the turn's work and reply rows. */
  children: Row[];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Group a thread's top-level timeline rows into turns.
 *
 * Finished turns arrive as a "turn" row with work children, preceded by the
 * user's prompt (no turnId) and followed by the reply (with the turnId). The
 * live turn arrives as flat rows sharing a turnId. A prompt with nothing
 * after it yet becomes a pending turn while the thread runs. Returns fresh
 * records; the input rows (which may be cached) are never mutated.
 */
export function normalizeTurns(rows: Row[], threadRunning: boolean): NormalizedTurn[] {
  const turns: NormalizedTurn[] = [];
  const byId = new Map<string, NormalizedTurn>();
  let pendingPrompt: Row | null = null;

  const turnFor = (turnId: string, source: Row | null): NormalizedTurn => {
    let turn = byId.get(turnId);
    if (turn === undefined) {
      turn = {
        turnId,
        status: str(source?.status) ?? (threadRunning ? "pending" : "completed"),
        startedAt: num(source?.startedAt),
        completedAt: num(source?.completedAt),
        children: pendingPrompt ? [pendingPrompt] : [],
      };
      pendingPrompt = null;
      byId.set(turnId, turn);
      turns.push(turn);
    }
    return turn;
  };

  for (const row of rows) {
    const turnId = str(row.turnId);
    if (row.kind === "turn" && turnId !== null) {
      const turn = turnFor(turnId, row);
      if (Array.isArray(row.children)) turn.children.push(...(row.children as Row[]));
      continue;
    }
    if (turnId === null) {
      if (row.kind === "conversation" && row.role === "user") pendingPrompt = row;
      continue;
    }
    const turn = turnFor(turnId, null);
    if (turn.startedAt === null) turn.startedAt = num(row.startedAt);
    turn.children.push(row);
  }

  const trailingPrompt = pendingPrompt as Row | null;
  if (trailingPrompt !== null && threadRunning) {
    turns.push({
      turnId: `pending-${str(trailingPrompt.id) ?? "prompt"}`,
      status: "pending",
      startedAt: num(trailingPrompt.createdAt),
      completedAt: null,
      children: [trailingPrompt],
    });
  }

  // Only the newest turn can still be live.
  turns.forEach((turn, index) => {
    if (index < turns.length - 1 && turn.status === "pending") turn.status = "completed";
  });
  return turns;
}
