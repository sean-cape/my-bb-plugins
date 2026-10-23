import { experimental_Icon as Icon, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { cx, enter, speed } from "bb-motion";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Landed, rpcContract } from "./contract.js";
import { COMPOSER, LANDED_ATTRIBUTE, LANDED_HOST_ATTRIBUTE } from "./footer-style.js";
import { landedLabel } from "./landed-label.js";

// bb's changes bar ("Committed · 8 files, +208 -24") toggles the composer's git section; no plugin contract names it.
const GIT_TOGGLE = "#thread-prompt-banner-git-toggle";
// Work lands from other threads and checkouts, which change nothing this composer sees.
const REFRESH_MS = 15_000;

/** A slot right after the changes bar's label, and that label, whose stats change as the branch does. */
function useChangesBar(anchor: HTMLElement | null): { slot: HTMLElement | null; label: string | null } {
  const [bar, setBar] = useState<{ slot: HTMLElement | null; label: string | null }>({ slot: null, label: null });
  useEffect(() => {
    const root = anchor?.closest(COMPOSER);
    if (!root) return;
    let slot: HTMLElement | null = null;
    const sync = () => {
      const toggle = root.querySelector<HTMLElement>(GIT_TOGGLE);
      if (toggle === null) {
        slot?.remove();
        slot = null;
      } else if (slot === null || slot.previousElementSibling !== toggle) {
        slot?.remove();
        slot = document.createElement("span");
        slot.setAttribute(LANDED_ATTRIBUTE, "");
        toggle.setAttribute(LANDED_HOST_ATTRIBUTE, "");
        toggle.after(slot);
      }
      const label = toggle?.textContent ?? null;
      setBar((current) => (current.slot === slot && current.label === label ? current : { slot, label }));
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    sync();
    return () => {
      observer.disconnect();
      slot?.remove();
      root.querySelector(GIT_TOGGLE)?.removeAttribute(LANDED_HOST_ATTRIBUTE);
      setBar({ slot: null, label: null });
    };
  }, [anchor]);
  return bar;
}

/** Re-checked whenever the bar's stats change, the thread changes, and every so often for work landed elsewhere. */
function useLanded(threadId: string, label: string | null): Landed | null {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [landed, setLanded] = useState<Landed | null>(null);
  useEffect(() => {
    if (label === null) return;
    let cancelled = false;
    const load = () =>
      rpc.call("landed", { threadId }).then(
        (value) => {
          if (!cancelled) setLanded(value);
        },
        // A failed check keeps the last answer; the next one retries.
        () => undefined,
      );
    void load();
    const unsubscribe = sdk.subscribe({ event: "thread:changed", threadId, callback: () => void load() });
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, [rpc, sdk, threadId, label]);
  return landed;
}

/** Says beside bb's changes bar whether the branch's commits are on its merge base, which the bar itself can't tell. */
export function LandedBadge(props: { anchor: HTMLElement | null; threadId: string }) {
  const { slot, label } = useChangesBar(props.anchor);
  const landed = useLanded(props.threadId, label);
  const text = landed === null ? null : landedLabel(landed);
  if (slot === null || text === null) return null;
  return createPortal(
    <span key={text.text} data-tone={text.tone} title={text.title} className={cx(enter.fade, speed.fast)}>
      {text.tone === "landed" ? <Icon name="Check" className="size-3.5" aria-hidden /> : null}
      {text.text}
    </span>,
    slot,
  );
}
