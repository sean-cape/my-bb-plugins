import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub token",
      description:
        "Personal access token with repo read scope. Leave empty to use the token from `gh auth token`.",
      secret: true,
    },
    ghPath: {
      type: "string",
      label: "GitHub CLI binary",
      description:
        "Path to `gh`, used for `gh auth token` when no GitHub token is set. bb launched from the Dock doesn't see your shell's PATH, so point this at the full path, e.g. /opt/homebrew/bin/gh.",
      default: "gh",
    },
    jiraSiteUrl: {
      type: "string",
      label: "Jira site URL",
      description: "Your Jira Cloud site, e.g. https://your-org.atlassian.net. Needed only for Jira sources.",
      default: "",
    },
    jiraEmail: {
      type: "string",
      label: "Jira account email",
      description: "The Atlassian account the API token belongs to.",
      default: "",
    },
    jiraApiToken: {
      type: "string",
      label: "Jira API token",
      description: "Create one at id.atlassian.com → Security → API tokens.",
      secret: true,
    },
    syncIntervalMinutes: {
      type: "number",
      label: "GitHub sync interval (minutes)",
      experimental_schema: z.number().int().min(1).max(240),
      default: 5,
    },
    autoStartThreads: {
      type: "boolean",
      label: "Start a thread for each new pull request card",
      description:
        "When on, a thread is spawned in the matching project as soon as a PR card is created: one that reads your PR's status and waits, or one that reads a PR you were asked to review and waits for questions. Off, a review request gets its thread once the board's review of it is done (with the review as its brief), a PR from a bb thread's branch joins that thread, and t on a card starts one.",
      default: false,
    },
    autoCreateProjects: {
      type: "boolean",
      label: "Create a project for each new repository",
      description:
        "When a PR card's repository matches no project's git remote, clone it and create a project for it so threads, reviews and applies can run there.",
      default: true,
    },
    cloneDir: {
      type: "string",
      label: "Clone directory",
      description: "Where auto-created projects are cloned. Empty uses <bb data dir>/plugins/kanban/repos/<owner>/<repo>.",
      default: "",
    },
    defaultProject: {
      type: "project",
      label: "Fallback project",
      description:
        "The default project for ad hoc tickets and Jira issues. A PR card only runs in a project whose git remote is its repository, so it never falls back to this one.",
    },
    guessProjects: {
      type: "boolean",
      label: "Guess a card's project",
      description:
        "A card with no project defaults to the one Claude Haiku picks from its title, description and the cards already filed under each project, run through the Claude Code CLI. Off, it defaults to the fallback project.",
      default: true,
    },
    claudePath: {
      type: "string",
      label: "Claude Code CLI binary",
      description:
        "Path to `claude`, used to guess a card's project. bb launched from the Dock doesn't see your shell's PATH; when `claude` isn't found there, ~/.local/bin/claude is tried.",
      default: "claude",
    },
    hideVendored: {
      type: "boolean",
      label: "Hide vendored files in the changes view",
      description: "Leave files under vendor/, node_modules/, third_party/ and similar out of the changes view. Shown or not, they never get a structural diff.",
      default: true,
    },
    difftPath: {
      type: "string",
      label: "difftastic binary",
      description: "Path to `difft` for the structural diff view. Install with `brew install difftastic`.",
      default: "difft",
    },
    reviewTag: {
      type: "string",
      label: "Review tag",
      description: "New diff comments on PR cards carrying this tag default to going to the GitHub PR; elsewhere they default to local notes for an agent.",
      default: "pr-reviews",
    },
    monitorTags: {
      type: "string",
      label: "Monitor tags",
      description: "New cards carrying any of these comma-separated tags start monitored, running the review loop with the default gates. Only new cards; turning a card's monitoring off or on afterwards always wins.",
      default: "",
    },
    stageOnGithub: {
      type: "boolean",
      label: "Stage GitHub drafts in your pending review on GitHub",
      description:
        "A draft headed for the PR goes into your pending review on GitHub as soon as it is saved, and comments pending there come onto the board, so a review can be half written in each place and submitted from either. Off, drafts stay on the board until you submit.",
      default: true,
    },
    hideReviewThreads: {
      type: "boolean",
      label: "Keep code review threads out of the sidebar",
      description: "Threads the code review buttons start (reviews, applying findings or comments, tours, hunk explanations) run hidden, outside the project's thread list; open them from the card or the changes view.",
      default: true,
    },
    autoMoveOnActivity: {
      type: "boolean",
      label: "Move cards to In Progress when their thread starts working",
      default: true,
    },
  });
}

export type KanbanSettings = ReturnType<typeof defineSettings>;
export type KanbanSettingsValues = Awaited<ReturnType<KanbanSettings["get"]>>;
