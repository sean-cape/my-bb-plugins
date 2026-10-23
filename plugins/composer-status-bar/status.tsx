import {
  type ExperimentalProviderModelPickerValue,
  experimental_Icon as Icon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders,
  useComposer,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { cx, enter, exit, POP, speed, STAGGER, stagger, usePresence, NEAR } from "bb-motion";
import { GLYPH, Glyph, useNerdFont } from "bb-nerd-font";
import { type AnimationEventHandler, type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Arrival, arrive, type Shown } from "./arrival.js";
import { LandedBadge } from "./landed-badge.js";
import {
  ANCHOR_ATTRIBUTE,
  COMPOSER,
  type FooterSlots,
  PART_ATTRIBUTE,
  type PartName,
  PICKER_ATTRIBUTE,
  SLOT_ATTRIBUTE,
  ensureFooterSlots,
} from "./footer-style.js";
import {
  type CatalogModel,
  type ContextUsage,
  type RateLimitWindow,
  formatContext,
  rateLimitNotice,
  resolveModelName,
} from "./format.js";

const RUNNING_REFRESH_MS = 5000;

// The footer's text is 12px, so values move the small distance as they change.

type Sdk = ReturnType<typeof useSdk>;
type LimitNotice = NonNullable<ReturnType<typeof rateLimitNotice>>;

// Rendered as a hidden composer banner so it is bound to one composer in
// both layouts, then portalled into that composer's footer.
export function FooterStatus() {
  const composer = useComposer();
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const slots = useFooterSlots(anchor);
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const attributes = { [ANCHOR_ATTRIBUTE]: "" };
  return (
    <span ref={setAnchor} hidden {...attributes}>
      {threadId !== null ? <LandedBadge anchor={anchor} threadId={threadId} /> : null}
      {threadId !== null ? (
        <StatusSegments
          slots={slots}
          threadId={threadId}
          isRunning={composer.isRunning}
          providerId={composer.selection?.providerId ?? null}
          model={composer.selection?.model ?? null}
          reasoningLevel={composer.selection?.reasoningLevel ?? null}
          serviceTier={composer.selection?.serviceTier ?? null}
          onSelect={(value) => composer.setSelection(value)}
        />
      ) : null}
    </span>
  );
}

function sameSlots(a: FooterSlots, b: FooterSlots): boolean {
  return a.agent === b.agent && a.usage === b.usage && a.context === b.context;
}

function useFooterSlots(anchor: HTMLElement | null): FooterSlots {
  const [slots, setSlots] = useState<FooterSlots>({});
  useEffect(() => {
    const root = anchor?.closest(COMPOSER);
    if (!root) return;
    let current: FooterSlots = {};
    const sync = () => {
      const next = ensureFooterSlots(root);
      if (!sameSlots(next, current)) {
        current = next;
        setSlots(next);
      }
    };
    // bb re-renders the footer when the composer switches layout.
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      for (const slot of root.querySelectorAll(`[${SLOT_ATTRIBUTE}]`)) slot.remove();
      setSlots({});
    };
  }, [anchor]);
  return slots;
}

interface PartMotion {
  className?: string;
  style?: CSSProperties;
  onAnimationEnd?: AnimationEventHandler;
}

function Part(props: PartMotion & { name: PartName; title?: string; children: ReactNode; blocked?: boolean }) {
  const attributes = {
    [PART_ATTRIBUTE]: props.name,
    ...(props.blocked ? { "data-blocked": "" } : {}),
  };
  return (
    <span
      title={props.title}
      className={props.className}
      style={props.style}
      onAnimationEnd={props.onAnimationEnd}
      {...attributes}
    >
      {props.children}
    </span>
  );
}

function useArrival(key: string, rank = 0): Arrival {
  const shown = useRef<Shown | null>(null);
  shown.current = arrive(shown.current, key, rank);
  return shown.current.arrival;
}

// Segments cascade in when the footer shows them; a value that changes after
// that rises in when it grows and drops in when it shrinks.
function valueMotion(arrival: Arrival, index: number): PartMotion {
  if (arrival === "enter") return { className: cx(enter.fade, speed.fast, STAGGER), style: stagger(index) };
  return { className: cx(arrival === "up" ? enter.rise : enter.drop, speed.fast, NEAR) };
}

function ChangingPart(props: {
  name: PartName;
  value: string;
  rank?: number;
  index: number;
  title?: string;
  children: ReactNode;
}) {
  const arrival = useArrival(props.value, props.rank);
  return (
    <Part key={props.value} name={props.name} title={props.title} {...valueMotion(arrival, props.index)}>
      {props.children}
    </Part>
  );
}

// Rises in when a limit nears, pops once if it then escalates to blocked, and
// fades out when the window resets.
function UsageLimit(props: { slot: HTMLElement | undefined; limit: LimitNotice | null; nerdFont: boolean }) {
  const presence = usePresence(props.limit !== null);
  const last = useRef(props.limit);
  if (props.limit !== null) last.current = props.limit;
  if (!props.slot || !presence.mounted || last.current === null) return null;
  return createPortal(
    <LimitPart limit={last.current} nerdFont={props.nerdFont} exiting={presence.exiting} onAnimationEnd={presence.onAnimationEnd} />,
    props.slot,
  );
}

function LimitPart(props: { limit: LimitNotice; nerdFont: boolean; exiting: boolean; onAnimationEnd: AnimationEventHandler }) {
  const { limit } = props;
  const arrival = useArrival(limit.blocked ? "blocked" : "warning", limit.blocked ? 1 : 0);
  const motion: PartMotion = props.exiting
    ? { className: exit.fade }
    : arrival === "enter"
      ? { className: cx(enter.rise, speed.fast, NEAR) }
      : { className: arrival === "up" ? POP : cx(enter.fade, speed.fast) };
  return (
    <Part
      key={String(limit.blocked)}
      name="limit"
      title={limit.title}
      blocked={limit.blocked}
      onAnimationEnd={props.onAnimationEnd}
      {...motion}
    >
      {props.nerdFont ? (
        <Glyph glyph={limit.blocked ? GLYPH.timerSandFull : GLYPH.timerSand} className="text-[13px]" />
      ) : (
        <Icon name="AlertTriangle" className="size-3.5" aria-hidden />
      )}
      {limit.text}
    </Part>
  );
}

function StatusSegments(props: {
  slots: FooterSlots;
  threadId: string;
  isRunning: boolean;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
  onSelect: (value: ExperimentalProviderModelPickerValue) => Promise<unknown>;
}) {
  const { slots } = props;
  const nerdFont = useNerdFont();
  const modelName = useModelName(props.providerId, props.model);
  const effort = useEffortLabel(props.providerId, props.reasoningLevel);
  const environmentId = useThreadEnvironment(props.threadId);
  const pickerValue = pickerValueOf(props);
  const showsPicker = slots.agent !== undefined && pickerValue !== null;
  useEffect(() => {
    const composer = slots.agent?.closest(COMPOSER);
    if (!showsPicker || !composer) return;
    composer.setAttribute(PICKER_ATTRIBUTE, "");
    return () => composer.removeAttribute(PICKER_ATTRIBUTE);
  }, [showsPicker, slots.agent]);
  const usage = useThreadUsage(props.threadId, props.isRunning);
  const context = formatContext(usage.context);
  const limit = rateLimitNotice(usage.rateLimits, Date.now());
  const modelTitle =
    modelName === null ? undefined : effort === null ? `Model: ${modelName}` : `Model: ${modelName}, effort: ${effort}`;

  return (
    <>
      {showsPicker
        ? createPortal(
            <Part name="model-picker" {...valueMotion("enter", 0)}>
              <ProviderModelPicker
                value={pickerValue}
                onChange={(value) => void props.onSelect(value).catch(() => undefined)}
                routing={environmentId === null ? undefined : { kind: "environment", environmentId }}
                align="end"
              />
            </Part>,
            slots.agent!,
          )
        : slots.agent && modelName !== null
          ? createPortal(
              <span className="contents" title={modelTitle}>
                {/* Keyed on the selection, not the name, which resolves from the raw id a moment after mount. */}
                <ChangingPart name="model" value={props.model ?? modelName} index={0}>
                  {modelName}
                </ChangingPart>
                {effort === null ? null : (
                  <>
                    <Part name="effort-separator" {...valueMotion("enter", 1)}>
                      ·
                    </Part>
                    <ChangingPart name="effort" value={props.reasoningLevel ?? effort} index={2}>
                      {effort}
                    </ChangingPart>
                  </>
                )}
              </span>,
              slots.agent,
            )
          : null}
      <UsageLimit slot={slots.usage} limit={limit} nerdFont={nerdFont} />
      {slots.context && context !== null
        ? createPortal(
            <ChangingPart
              name="tokens-used"
              value={context.used}
              rank={usage.context?.usedTokens ?? 0}
              index={0}
              title={context.window === null ? undefined : `${context.used} of ${context.window} tokens`}
            >
              {context.used}
            </ChangingPart>,
            slots.context,
          )
        : null}
    </>
  );
}

const modelCatalogs = new Map<string, Promise<readonly CatalogModel[]>>();

function loadModelCatalog(sdk: Sdk, providerId: string): Promise<readonly CatalogModel[]> {
  let catalog = modelCatalogs.get(providerId);
  if (catalog === undefined) {
    catalog = sdk.providers.models({ providerId }).then(
      (result) => result.models,
      (error: unknown) => {
        modelCatalogs.delete(providerId);
        throw error;
      },
    );
    modelCatalogs.set(providerId, catalog);
  }
  return catalog;
}

function useModelName(providerId: string | null, model: string | null): string | null {
  const sdk = useSdk();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    setName(model);
    if (providerId === null || model === null) return;
    let cancelled = false;
    loadModelCatalog(sdk, providerId).then(
      (catalog) => {
        if (!cancelled) setName(resolveModelName(catalog, model));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, providerId, model]);
  return name;
}

function useEffortLabel(providerId: string | null, level: string | null): string | null {
  const { providers } = experimental_useProviders();
  if (level === null) return null;
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider?.reasoningLevels?.find((candidate) => candidate.id === level)?.label ?? level;
}

/** The picker needs a complete selection; until the composer has one the footer shows the plain text. */
function pickerValueOf(selection: {
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
}): ExperimentalProviderModelPickerValue | null {
  if (selection.providerId === null || selection.model === null || selection.reasoningLevel === null) return null;
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: selection.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(selection.serviceTier === null ? {} : { serviceTier: selection.serviceTier }),
  };
}

// Some providers' model catalogs depend on the workspace, so the picker routes through the thread's environment.
function useThreadEnvironment(threadId: string): string | null {
  const sdk = useSdk();
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    sdk.threads.get({ threadId }).then(
      (thread) => {
        if (!cancelled) setEnvironmentId(thread.environmentId ?? null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId]);
  return environmentId;
}

interface ThreadUsage {
  context: ContextUsage | null;
  rateLimits: readonly RateLimitWindow[];
}

function useThreadUsage(threadId: string, isRunning: boolean): ThreadUsage {
  const sdk = useSdk();
  const [usage, setUsage] = useState<ThreadUsage>({ context: null, rateLimits: [] });
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [contextRows, limitRows] = await Promise.all([
          sdk.threads.events.list({
            threadId,
            types: ["thread/contextWindowUsage/updated"],
            order: "desc",
            limit: "1",
            signal: controller.signal,
          }),
          sdk.threads.events.list({
            threadId,
            types: ["provider/rateLimits/updated"],
            order: "desc",
            limit: "1",
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) return;
        const contextRow = contextRows[0];
        const limitRow = limitRows[0];
        setUsage({
          context:
            contextRow?.type === "thread/contextWindowUsage/updated"
              ? contextRow.data.contextWindowUsage
              : null,
          rateLimits:
            limitRow?.type === "provider/rateLimits/updated"
              ? limitRow.data.rateLimits.windows
              : [],
        });
      } catch {
        // A failed refresh keeps the last values; the next change retries.
      } finally {
        inFlight = false;
      }
    };
    void load();
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: () => void load(),
    });
    // Usage events don't change the thread record, so poll while a turn runs.
    const timer = isRunning ? setInterval(() => void load(), RUNNING_REFRESH_MS) : undefined;
    return () => {
      controller.abort();
      unsubscribe();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [sdk, threadId, isRunning]);
  return usage;
}
