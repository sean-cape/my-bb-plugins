import type { Attention, AttentionLevel, ClassifiedFile, PathRule } from "../../shared/loop";

export interface AttentionSignals {
  /** The classify thread's file scores; null when classifying failed. */
  files: ClassifiedFile[] | null;
  pathRules: PathRule[];
  /** Automatic fix rounds the loop ran. */
  rounds: number;
  disputes: number;
  checkFailures: number;
  /** What the final review says neither the checks nor it could check. */
  notCovered: number;
  openScopeFindings: number;
  deferredCritical: number;
}

const RANK: Record<AttentionLevel, number> = { glance: 0, read: 1, scrutinize: 2 };

/** Lines added and removed past which a change needs a closer look. */
const READ_LINES = 300;
const SCRUTINIZE_LINES = 1000;
/** A change this small with ordinary logic at most reads at a glance, since a quick review covers it. */
const SMALL_LINES = 100;

function riskLevel(risk: number): AttentionLevel {
  return risk >= 5 ? "scrutinize" : risk >= 3 ? "read" : "glance";
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** `**` crosses directories, `*` and `?` don't; a glob without a slash matches a file name in any directory. */
export function globMatches(glob: string, path: string): boolean {
  const pattern = glob
    .split(/(\*\*\/?|\*|\?)/u)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  const regex = new RegExp(`^${pattern}$`, "u");
  return regex.test(path) || (!glob.includes("/") && regex.test(path.split("/").at(-1)!));
}

/** How hard the user should look at the change, and why: every signal can only raise the level. */
export function attentionLevel(signals: AttentionSignals): Attention {
  const raised: Array<{ level: AttentionLevel; reason: string }> = [];
  const { files } = signals;
  if (files === null) {
    raised.push({ level: "read", reason: "the files' risk wasn't classified" });
  } else if (files.length > 0) {
    const riskiest = files.reduce((top, file) => (file.risk > top.risk ? file : top));
    const lines = files.reduce((sum, file) => sum + file.lines, 0);
    const level = riskiest.risk === 3 && lines < SMALL_LINES ? "glance" : riskLevel(riskiest.risk);
    raised.push({ level, reason: `risk ${riskiest.risk}${level === "glance" && riskiest.risk === 3 ? ` in ${plural(lines, "line")}` : ""}: ${riskiest.note === "" ? riskiest.path : `${riskiest.note} (${riskiest.path})`}` });
    if (lines > READ_LINES) raised.push({ level: lines > SCRUTINIZE_LINES ? "scrutinize" : "read", reason: `${lines} lines changed` });
    for (const rule of signals.pathRules) {
      const matched = files.find((file) => globMatches(rule.glob, file.path));
      if (matched !== undefined) raised.push({ level: rule.level, reason: `${matched.path} matches the path rule ${rule.glob}` });
    }
  }
  if (signals.rounds >= 2) raised.push({ level: "read", reason: `took ${signals.rounds} rounds` });
  if (signals.disputes > 0) raised.push({ level: "read", reason: plural(signals.disputes, "disputed finding") });
  if (signals.checkFailures > 0) raised.push({ level: "read", reason: `checks failed ${signals.checkFailures === 1 ? "once" : `${signals.checkFailures} times`}` });
  if (signals.notCovered > 0) raised.push({ level: "read", reason: `${plural(signals.notCovered, "thing")} the checks don't cover` });
  if (signals.openScopeFindings > 0) raised.push({ level: "read", reason: plural(signals.openScopeFindings, "open scope finding") });
  if (signals.deferredCritical > 0) raised.push({ level: "read", reason: plural(signals.deferredCritical, "deferred critical finding") });
  const level = raised.reduce<AttentionLevel>((top, entry) => (RANK[entry.level] > RANK[top] ? entry.level : top), "glance");
  return { level, reasons: raised.map((entry) => entry.reason) };
}
