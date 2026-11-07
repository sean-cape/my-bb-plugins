import { definePluginApp, experimental_Icon as Icon, experimental_THREAD_ACTION_GROUPS, useComposer, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { ACTION_ICON, ACTION_LABEL, ACTION_SHORT_LABEL, ACTIONS, isAction } from "./actions.js";
import type { Resolved, rpcContract } from "./contract.js";
import { bindRpc, cached, cycle, load, makeProjectDefault, pick, useResolved, useResolvedMap } from "./store.js";

const CYCLE_HINT = "⌥D";

function useBoundRpc(): void {
  const rpc = useRpc<typeof rpcContract>();
  bindRpc(rpc);
}

/** Beside the send button: what happens to the finished change, and a click to step to the next option. */
function ComposerChip() {
  useBoundRpc();
  const composer = useComposer();
  const sdk = useSdk();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const resolved = useResolved(threadId ?? "");

  useEffect(() => {
    if (threadId === null) return;
    const refresh = () => void load([threadId], true).catch(() => undefined);
    refresh();
    // The agent or the CLI can change the pick too.
    return sdk.subscribe({ event: "thread:changed", threadId, callback: refresh });
  }, [sdk, threadId]);

  if (threadId === null || resolved === undefined || !resolved.applies) return null;
  const label = ACTION_LABEL[resolved.action];
  const title = `When done: ${label}${resolved.source === "thread" ? "" : " (project default)"}. Click or ${CYCLE_HINT} to change.`;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-finish-action={resolved.action}
      onClick={() => void cycle(threadId, 1)}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name={ACTION_ICON[resolved.action]} className="size-3.5" aria-hidden />
      <span>{ACTION_SHORT_LABEL[resolved.action]}</span>
    </button>
  );
}

function menuItems(resolved: Resolved) {
  const fallback = resolved.projectDefault ?? "none";
  return [
    ...ACTIONS.map((action) => ({
      id: action,
      label: ACTION_LABEL[action],
      icon: ACTION_ICON[action],
      selected: resolved.source === "thread" && resolved.action === action,
    })),
    { id: "default", label: `Project default (${ACTION_LABEL[fallback]})`, selected: resolved.source !== "thread" },
  ];
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "finish-action",
    scopes: ["thread"],
    actions: [{ id: "chip", component: ComposerChip }],
  });

  app.composer.experimental_registerCommand({
    id: "cycle-next",
    title: "When done: next option",
    defaultShortcut: { key: "d", alt: true },
    run: ({ composer }) => {
      if (composer.scope.kind === "thread") void cycle(composer.scope.threadId, 1);
    },
  });
  app.composer.experimental_registerCommand({
    id: "cycle-previous",
    title: "When done: previous option",
    defaultShortcut: { key: "d", alt: true, shift: true },
    run: ({ composer }) => {
      if (composer.scope.kind === "thread") void cycle(composer.scope.threadId, -1);
    },
  });

  const applies = (threadId: string | null) => threadId !== null && cached(threadId)?.applies === true;
  for (const action of ACTIONS) {
    app.commands.register({
      id: `pick-${action}`,
      title: `When done: ${ACTION_LABEL[action]}`,
      isAvailable: ({ threadId }) => applies(threadId),
      run: ({ threadId }) => {
        if (threadId !== null) void pick(threadId, action);
      },
    });
  }
  app.commands.register({
    id: "make-project-default",
    title: "When done: make this thread's choice the project default",
    isAvailable: ({ threadId }) => applies(threadId),
    run: ({ threadId, projectId }) => {
      if (threadId !== null && projectId !== null) void makeProjectDefault(threadId, projectId);
    },
  });

  app.slots.experimental_threadAction<ReadonlyMap<string, Resolved>>({
    id: "when-done",
    title: "When done",
    icon: "GitMerge",
    group: experimental_THREAD_ACTION_GROUPS.settings,
    useData: ({ threadIds }) => {
      useBoundRpc();
      return useResolvedMap(threadIds);
    },
    item: ({ thread, data }) => {
      const resolved = data.get(thread.id);
      if (resolved === undefined || !resolved.applies) return null;
      return {
        label: "When done",
        detail: ACTION_LABEL[resolved.action],
        icon: ACTION_ICON[resolved.action],
        choices: {
          heading: "When the agent finishes",
          hint: "Read by the agent each time it finishes a change, so a switch mid-thread applies to its next one.",
          items: menuItems(resolved),
        },
        run: ({ value }) => {
          if (value === "default") return pick(thread.id, null);
          if (isAction(value)) return pick(thread.id, value);
        },
      };
    },
  });
});
