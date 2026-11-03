import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Column, JiraIssue, PullRequest, Source, SyncStatus } from "../shared/board";
import { reviewDepthSchema, type ReviewDepth } from "../shared/review";
import { doneColumn, initialColumn, type BoardStore } from "./board";
import type { CardThreads } from "./card-threads";
import type { PrComments } from "./comments/pr-comments";
import type { PendingReview } from "./comments/pending-review";
import type { KanbanContext } from "./context";
import type { TicketRow } from "./db/rows";
import { fetchPrHeads, github, prStateOf, repoFromRepositoryUrl, resolveToken, searchPulls, type GithubPull } from "./github";
import { JIRA_FIELDS, adfToText, jira, jiraConfig, searchJira, toJiraIssue, type JiraConfig, type JiraSearchIssue } from "./jira";
import type { ProjectGuesser } from "./project-guess";
import type { Projects } from "./projects";
import type { Reviews } from "./reviews/reviews";
import type { Tour } from "./tour";
import type { KanbanSettingsValues } from "./settings";
import { errorMessage, normalizeTags, parseStringArray } from "./util";

type GithubSource = Extract<Source, { kind: "github-search" }>;
type JiraSource = Extract<Source, { kind: "jira-jql" }>;

/** What one sync run shares across its sources. */
interface SyncPass {
  columns: Column[];
  autoStartThreads: boolean;
  now: number;
  sourceById: Map<string, Source>;
  /** Cards created this run that get a thread once the board is saved. */
  toSpawn: string[];
  /** Per-source failures, reported together when the run ends. */
  problems: string[];
  signal: AbortSignal | undefined;
}

/** One item can appear in several sources: it gets every source's tags, and the first source owns it. */
function groupBySource<S extends Source, T>(results: Array<{ source: S; items: T[] }>, keyOf: (item: T) => string): Map<string, { item: T; sources: S[] }> {
  const seen = new Map<string, { item: T; sources: S[] }>();
  for (const { source, items } of results) {
    for (const item of items) {
      const key = keyOf(item);
      const entry = seen.get(key);
      if (entry === undefined) seen.set(key, { item, sources: [source] });
      else entry.sources.push(source);
    }
  }
  return seen;
}

/** The deepest review any of the item's sources asks for, or null when none reviews new PRs. */
function autoReviewDepth(sources: GithubSource[]): ReviewDepth | null {
  const depths = new Set(sources.map((source) => source.reviewNewPrs));
  return [...reviewDepthSchema.options].reverse().find((depth) => depths.has(depth)) ?? null;
}

export async function loadSyncStatus(bb: BbPluginApi): Promise<SyncStatus> {
  return {
    lastSyncAt: (await bb.storage.kv.get<number>("lastSyncAt")) ?? null,
    lastError: null,
    login: (await bb.storage.kv.get<string>("login")) ?? null,
    tokenSource: "none",
    jiraSite: null,
    inProgress: false,
  };
}

/** Pulls every enabled source into the board: new cards, state refreshes, and cards that left their source. */
export function createSourceSync(
  ctx: KanbanContext,
  {
    board,
    threads,
    projects,
    projectGuess,
    prComments,
    pendingReview,
    reviews,
    tour,
  }: { board: BoardStore; threads: CardThreads; projects: Projects; projectGuess: ProjectGuesser; prComments: PrComments; pendingReview: PendingReview; reviews: Reviews; tour: Tour },
) {
  const { bb, settings, stmts, sync, publish } = ctx;
  const { getTicket, getColumns, getSources, createTicket, moveTicket } = board;
  const { spawnThreadForTicket } = threads;
  const { fallbackProject, resolveProjectForRepo, adoptProjectForRepo } = projects;
  const { syncPrComments } = prComments;

  let syncPromise: Promise<void> | null = null;

  function runSync(signal?: AbortSignal): Promise<void> {
    if (syncPromise !== null) return syncPromise;
    sync.inProgress = true;
    syncPromise = syncOnce(signal)
      .then(
        () => {
          sync.lastError = null;
        },
        (error: unknown) => {
          sync.lastError = errorMessage(error);
          bb.log.warn(`GitHub sync failed: ${sync.lastError}`);
        },
      )
      .finally(() => {
        sync.inProgress = false;
        syncPromise = null;
        publish();
      });
    return syncPromise;
  }

  async function syncOnce(signal?: AbortSignal): Promise<void> {
    const sources = (await getSources()).filter((source) => source.enabled);
    const githubSources = sources.filter((source): source is GithubSource => source.kind === "github-search");
    const jiraSources = sources.filter((source): source is JiraSource => source.kind === "jira-jql");

    const auth = await resolveToken(settings);
    sync.tokenSource = auth?.source ?? "none";
    if (auth !== null && sync.login === null) {
      const me = await github<{ login: string }>("/user", auth.token, signal);
      sync.login = me.login;
      await bb.storage.kv.set("login", me.login);
    }
    const jiraAuth = await jiraConfig(settings);
    sync.jiraSite = jiraAuth?.site ?? null;

    const pass: SyncPass = {
      columns: await getColumns(),
      autoStartThreads: (await settings.get()).autoStartThreads,
      now: Date.now(),
      sourceById: new Map(sources.map((source) => [source.id, source])),
      toSpawn: [],
      problems: [],
      signal,
    };

    if (githubSources.length > 0 && auth === null) {
      pass.problems.push("No GitHub token: set the GitHub token setting, or sign in with `gh auth login` on the BB server machine and check the GitHub CLI binary setting points at `gh`.");
    }
    // Runs with no GitHub sources too: tracked PRs still get refreshed and finished.
    if (auth !== null) await syncGithub(pass, auth.token, githubSources);

    if (jiraSources.length > 0 && jiraAuth === null) {
      pass.problems.push("Jira sources need the Jira site URL, account email, and API token settings.");
    }
    if (jiraAuth !== null && jiraSources.length > 0) await syncJira(pass, jiraAuth, jiraSources);

    sync.lastSyncAt = pass.now;
    await bb.storage.kv.set("lastSyncAt", pass.now);
    publish();

    for (const ticketId of pass.toSpawn) {
      const ticket = getTicket(ticketId);
      if (ticket.projectId === null) continue;
      try {
        await spawnThreadForTicket(ticketId, ticket.projectId);
      } catch (error) {
        bb.log.warn(`could not start a thread for ticket ${ticketId}: ${String(error)}`);
      }
    }

    // After the card threads start, so each review and narrative thread is a child of its card's thread.
    await startAutoReviews(pass);
    await startAutoNarratives(pass);

    if (pass.problems.length > 0) throw new Error(pass.problems.join(" · "));
  }

  /**
   * Reviews a source asked for. A card waits while its project is still being cloned, while it is a draft, or while
   * another review of it runs; a monitored card's loop runs its own reviews instead.
   */
  async function startAutoReviews(pass: SyncPass): Promise<void> {
    for (const row of stmts.pendingAutoReviews.all()) {
      const ticket = getTicket(row.id);
      if (ticket.loop?.monitored === true) {
        stmts.setAutoReview.run(null, row.id);
        continue;
      }
      if (stmts.latestReview.get(row.id)?.status === "running") continue;
      stmts.setAutoReview.run(null, row.id);
      try {
        await reviews.startReview(row.id, null, "incremental", row.auto_review_depth!);
      } catch (error) {
        pass.problems.push(`Could not start the review of ${row.pr_repo}#${row.pr_number}: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Narratives a source asked for, with the same waits as reviews. One still current is left alone; one the code has
   * moved past gets an update chapter.
   */
  async function startAutoNarratives(pass: SyncPass): Promise<void> {
    for (const row of stmts.pendingAutoNarratives.all()) {
      const ticket = getTicket(row.id);
      if (ticket.loop?.monitored === true) {
        stmts.setAutoNarrative.run(0, row.id);
        continue;
      }
      if (stmts.latestNarrative.get(row.id)?.status === "running") continue;
      stmts.setAutoNarrative.run(0, row.id);
      try {
        await tour.ensureNarrative(ticket);
      } catch (error) {
        pass.problems.push(`Could not start the narrative of ${row.pr_repo}#${row.pr_number}: ${errorMessage(error)}`);
      }
    }
  }

  /** Runs every source's search; a failed source is reported and counts as having returned nothing. */
  async function searchEach<S extends Source, T>(
    pass: SyncPass,
    sources: S[],
    search: (source: S) => Promise<T[]>,
  ): Promise<{ results: Array<{ source: S; items: T[] }>; anyFailed: boolean }> {
    let anyFailed = false;
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          return { source, items: await search(source) };
        } catch (error) {
          pass.problems.push(`${source.name}: ${errorMessage(error)}`);
          anyFailed = true;
          return { source, items: [] as T[] };
        }
      }),
    );
    return { results, anyFailed };
  }

  function mergeTags(pass: SyncPass, row: TicketRow, sourceTags: string[]): void {
    const currentTags = parseStringArray(row.tags);
    if (sourceTags.some((tag) => !currentTags.includes(tag))) {
      stmts.setTags.run(JSON.stringify(normalizeTags([...currentTags, ...sourceTags])), pass.now, row.id);
    }
  }

  function finish(pass: SyncPass, row: TicketRow, finished: boolean): void {
    if (finished && row.column_id !== doneColumn(pass.columns)) moveTicket(row.id, doneColumn(pass.columns), null);
  }

  function goneFromDoneSource(pass: SyncPass, row: TicketRow): boolean {
    return row.source_id !== null && pass.sourceById.get(row.source_id)?.doneWhenGone === true;
  }

  async function syncGithub(pass: SyncPass, token: string, sources: GithubSource[]): Promise<void> {
    const { signal, now } = pass;
    const { results, anyFailed } = await searchEach(pass, sources, (source) => searchPulls(source.query, token, signal));
    const seenPrs = groupBySource(results, (item) => `${repoFromRepositoryUrl(item.repository_url)}#${item.number}`);
    const roleOf = (author: string): PullRequest["role"] => (author === sync.login ? "authored" : "other");
    const untracked = [...seenPrs.values()]
      .map(({ item }) => ({ repo: repoFromRepositoryUrl(item.repository_url), number: item.number }))
      .filter((pr) => stmts.byPr.get(pr.repo, pr.number) === undefined);
    const untrackedHeads = await fetchPrHeads(untracked, token, signal, (message) => bb.log.warn(`could not read PR branches and checks: ${message}`));
    for (const { item, sources: itemSources } of seenPrs.values()) {
      const repo = repoFromRepositoryUrl(item.repository_url);
      const pr: PullRequest = {
        repo,
        number: item.number,
        url: item.html_url,
        role: roleOf(item.user?.login ?? ""),
        state: prStateOf({ state: item.state, draft: item.draft, merged: item.pull_request?.merged_at != null }),
        author: item.user?.login ?? "",
        updatedAt: item.updated_at,
        headRef: null,
        checks: null,
        checksUrl: null,
        body: item.body ?? null,
      };
      const sourceTags = itemSources.flatMap((source) => source.tags);
      const existing = stmts.byPr.get(repo, item.number);
      if (existing === undefined) {
        const threadId = /-(thr_[a-z0-9]+)$/u.exec(untrackedHeads.get(`${repo}#${item.number}`)?.headRef ?? "")?.[1];
        const threadCard = threadId === undefined ? undefined : stmts.byThread.get(threadId);
        if (threadCard?.kind === "adhoc" && threadCard.pr_repo === null) {
          stmts.attachPr.run(repo, item.number, pr.url, pr.state, pr.role, pr.author, pr.updatedAt, pr.body, itemSources[0]!.id, now, threadCard.id);
          mergeTags(pass, threadCard, sourceTags);
          continue;
        }
        const projectId = await resolveProjectForRepo(repo, itemSources[0]!.projectId);
        const ticket = createTicket({
          title: item.title,
          description: "",
          columnId: initialColumn(pass.columns, pr),
          kind: "pr",
          tags: sourceTags,
          sourceId: itemSources[0]!.id,
          threadId: null,
          projectId,
          pr,
        });
        const depth = autoReviewDepth(itemSources);
        if (depth !== null) stmts.setAutoReview.run(depth, ticket.id);
        if (itemSources.some((source) => source.narrateNewPrs)) stmts.setAutoNarrative.run(1, ticket.id);
        if (pass.autoStartThreads && projectId !== null) pass.toSpawn.push(ticket.id);
        continue;
      }
      stmts.setPr.run(item.title, item.html_url, pr.state, pr.role, pr.author, item.updated_at, pr.body, now, existing.id);
      mergeTags(pass, existing, sourceTags);
      if (existing.left_source === 1) {
        stmts.setLeftSource.run(0, existing.id);
        // Back in a source after leaving it, such as a re-requested review: it needs you again.
        if ((pr.state === "open" || pr.state === "draft") && existing.column_id === doneColumn(pass.columns)) {
          moveTicket(existing.id, initialColumn(pass.columns, pr), null);
        }
        const depth = autoReviewDepth(itemSources);
        if (depth !== null && (pr.state === "open" || pr.state === "draft")) stmts.setAutoReview.run(depth, existing.id);
        if (itemSources.some((source) => source.narrateNewPrs) && (pr.state === "open" || pr.state === "draft")) stmts.setAutoNarrative.run(1, existing.id);
      }
    }
    // Cards still without a project (created before auto-creation, or whose clone failed): try again each sync.
    const unprojectedRepos = new Set(stmts.openPrs.all().filter((row) => row.project_id === null && row.pr_repo !== null).map((row) => row.pr_repo!));
    for (const repo of unprojectedRepos) {
      void resolveProjectForRepo(repo)
        .then((projectId) => (projectId === null ? undefined : adoptProjectForRepo(repo, projectId)))
        .catch((error: unknown) => bb.log.warn(`could not find a project for ${repo}: ${String(error)}`));
    }
    // Comments: refetch when the PR's updated_at moved (comments bump it) or never fetched.
    for (const row of stmts.openPrs.all()) {
      if (row.comments_synced_for !== null && row.comments_synced_for === row.pr_updated_at) continue;
      try {
        await syncPrComments(row, token, signal);
      } catch (error) {
        bb.log.warn(`could not sync comments for ${row.pr_repo}#${row.pr_number}: ${String(error)}`);
      }
    }
    // The user's pending review is theirs alone, so nothing about it moves the PR's updated_at: every pass looks.
    for (const row of stmts.openPrs.all()) {
      try {
        await pendingReview.pull(row, token, syncPrComments, signal);
      } catch (error) {
        bb.log.warn(`could not pull the pending review for ${row.pr_repo}#${row.pr_number}: ${String(error)}`);
      }
    }
    // Tracked PRs that left every source: merged, closed, or gone from a source that treats that as done.
    for (const row of stmts.openPrs.all()) {
      if (anyFailed || row.pr_repo === null || row.pr_number === null) continue;
      if (seenPrs.has(`${row.pr_repo}#${row.pr_number}`)) continue;
      // A disabled or removed source says nothing about whether the PR still wants you.
      if (row.left_source === 0 && row.source_id !== null && pass.sourceById.has(row.source_id)) stmts.setLeftSource.run(1, row.id);
      let pull: GithubPull;
      try {
        pull = await github<GithubPull>(`/repos/${row.pr_repo}/pulls/${row.pr_number}`, token, signal);
      } catch (error) {
        bb.log.warn(`could not refresh ${row.pr_repo}#${row.pr_number}: ${String(error)}`);
        continue;
      }
      const state = prStateOf(pull);
      const author = pull.user?.login ?? row.pr_author ?? "";
      stmts.setPr.run(pull.title, pull.html_url, state, roleOf(author), author, pull.updated_at, pull.body ?? null, now, row.id);
      finish(pass, row, state === "merged" || state === "closed" || goneFromDoneSource(pass, row));
    }
    await syncPrHeads(pass, token);
  }

  /** Every pass for every open PR: a CI run finishing does not move the PR's updated_at. Merged and closed PRs keep their last values. */
  async function syncPrHeads(pass: SyncPass, token: string): Promise<void> {
    const rows = stmts.openPrs.all().filter((row) => row.pr_repo !== null && row.pr_number !== null);
    const heads = await fetchPrHeads(
      rows.map((row) => ({ repo: row.pr_repo!, number: row.pr_number! })),
      token,
      pass.signal,
      (message) => bb.log.warn(`could not read PR branches and checks: ${message}`),
    );
    for (const row of rows) {
      const head = heads.get(`${row.pr_repo}#${row.pr_number}`);
      if (head === undefined || (head.headRef === row.pr_head_ref && head.checks === row.pr_checks && head.checksUrl === row.pr_checks_url)) continue;
      stmts.setPrHead.run(head.headRef, head.checks, head.checksUrl, row.id);
    }
  }

  async function syncJira(pass: SyncPass, jiraAuth: JiraConfig, sources: JiraSource[]): Promise<void> {
    const { signal } = pass;
    const { results, anyFailed } = await searchEach(pass, sources, (source) => searchJira(jiraAuth, source.jql, signal));
    const seenIssues = groupBySource(results, (issue) => issue.key);
    for (const { item: issue, sources: itemSources } of seenIssues.values()) {
      const jiraIssue = toJiraIssue(jiraAuth.site, issue);
      const sourceTags = itemSources.flatMap((source) => source.tags);
      const existing = stmts.byJira.get(issue.key);
      if (existing === undefined) {
        const projectId = await fallbackProject(itemSources[0]!.projectId);
        const ticket = createTicket({
          title: issue.fields.summary,
          description: adfToText(issue.fields.description).trim(),
          columnId: initialColumn(pass.columns, null, jiraIssue),
          kind: "jira",
          tags: sourceTags,
          sourceId: itemSources[0]!.id,
          threadId: null,
          projectId,
          pr: null,
          jira: jiraIssue,
        });
        if (pass.autoStartThreads && projectId !== null) pass.toSpawn.push(ticket.id);
        else projectGuess.prefetch(ticket.id);
        continue;
      }
      updateJira(pass, existing.id, issue, jiraIssue);
      mergeTags(pass, existing, sourceTags);
      if (jiraIssue.statusCategory === "done") finish(pass, existing, true);
    }
    for (const row of stmts.openJira.all()) {
      if (anyFailed || row.jira_key === null || seenIssues.has(row.jira_key)) continue;
      let issue: JiraSearchIssue;
      try {
        issue = await jira<JiraSearchIssue>(jiraAuth, `/rest/api/3/issue/${encodeURIComponent(row.jira_key)}?fields=${JIRA_FIELDS}`, signal);
      } catch (error) {
        bb.log.warn(`could not refresh ${row.jira_key}: ${String(error)}`);
        continue;
      }
      const jiraIssue = toJiraIssue(jiraAuth.site, issue);
      updateJira(pass, row.id, issue, jiraIssue);
      finish(pass, row, jiraIssue.statusCategory === "done" || goneFromDoneSource(pass, row));
    }
  }

  function updateJira(pass: SyncPass, ticketId: string, issue: JiraSearchIssue, jiraIssue: JiraIssue): void {
    stmts.setJira.run(
      issue.fields.summary,
      jiraIssue.url,
      jiraIssue.status,
      jiraIssue.statusCategory,
      jiraIssue.issueType,
      jiraIssue.priority,
      jiraIssue.assignee,
      jiraIssue.updatedAt,
      pass.now,
      ticketId,
    );
  }

  function registerService(): void {
    bb.background.service("github-sync", {
      async start(signal) {
        while (!signal.aborted) {
          await runSync(signal);
          const { syncIntervalMinutes } = await settings.get();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, syncIntervalMinutes * 60_000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      },
    });
  }

  function onSettingsChange(next: KanbanSettingsValues, prev: KanbanSettingsValues): void {
    if (next.githubToken !== prev.githubToken || next.ghPath !== prev.ghPath) {
      sync.login = null;
      void bb.storage.kv.delete("login");
      void runSync();
    } else if (
      next.jiraSiteUrl !== prev.jiraSiteUrl ||
      next.jiraEmail !== prev.jiraEmail ||
      next.jiraApiToken !== prev.jiraApiToken
    ) {
      void runSync();
    }
  }

  return { runSync, registerService, onSettingsChange };
}

export type SourceSync = ReturnType<typeof createSourceSync>;
