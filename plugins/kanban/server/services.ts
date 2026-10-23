import { createBoardStore } from "./board";
import { createCardThreads } from "./card-threads";
import { createCodeReviewThreads } from "./code-review-threads";
import { createDiffComments } from "./comments/diff-comments";
import { createPendingReview } from "./comments/pending-review";
import { createPrComments } from "./comments/pr-comments";
import { createPrConversation } from "./comments/pr-conversation";
import type { KanbanContext } from "./context";
import { createChanges } from "./diff/changes";
import { createDiffSubjects } from "./diff/subjects";
import { createViewedMarks } from "./diff/viewed";
import { createDiffDelta } from "./diff/delta";
import { createSuggestions } from "./diff/suggestions";
import { createDumps } from "./dumps";
import { createLoop } from "./loop/loop";
import { createProjectSettings } from "./project-settings";
import { createProjects } from "./projects";
import { createReviewResume } from "./reviews/resume";
import { createReviews } from "./reviews/reviews";
import { createSpend } from "./spend/spend";
import { createSubtasks } from "./subtasks";
import { createSourceSync } from "./sync";
import { createTour } from "./tour";

/** Builds every feature in dependency order; each one only sees the features it is handed. */
export function createServices(ctx: KanbanContext) {
  const spend = createSpend(ctx);
  const board = createBoardStore(ctx, { spend });
  const projectSettings = createProjectSettings(ctx);
  const subjects = createDiffSubjects(ctx, { board });
  const threads = createCardThreads(ctx, { board });
  const projects = createProjects(ctx, { threads });
  const codeReviewThreads = createCodeReviewThreads(ctx);
  const changes = createChanges(ctx);
  const viewed = createViewedMarks(ctx, { changes });
  const deltas = createDiffDelta(ctx, { changes, viewed });
  const prComments = createPrComments(ctx, { board, threads, projects, codeReviewThreads });
  const prConversation = createPrConversation(ctx, { board });
  const pendingReview = createPendingReview(ctx, { board, changes });
  const diffComments = createDiffComments(ctx, { board, subjects, changes, prComments, pendingReview });
  const reviews = createReviews(ctx, { board, threads, projects, codeReviewThreads });
  const tour = createTour(ctx, { changes, threads, projects, codeReviewThreads });
  const dumps = createDumps(ctx, { board, threads });
  const subtasks = createSubtasks(ctx, { board, threads, projects });
  const sourceSync = createSourceSync(ctx, { board, threads, projects, prComments, pendingReview, reviews, tour });
  const loop = createLoop(ctx, { board, threads, codeReviewThreads, projectSettings, reviews, diffComments, prComments, changes, viewed, tour });
  const reviewResume = createReviewResume(ctx, { reviews, loop });
  const suggestions = createSuggestions(ctx, { prComments });
  return { spend, board, projectSettings, loop, reviewResume, subjects, threads, projects, codeReviewThreads, changes, viewed, deltas, prComments, prConversation, pendingReview, diffComments, reviews, tour, dumps, subtasks, sourceSync, suggestions };
}

export type Services = ReturnType<typeof createServices>;
