import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_SidebarNavigationIcon as NavigationIcon,
  experimental_useSidebarNavigation,
  type ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk/app";
import { cx, enter, exit, OPACITY_TRANSITION, PRESS, speed, TRANSFORM_TRANSITION, usePresence, NEAR } from "bb-motion";
import {
  nextIndicator,
  railItemOffset,
  type IndicatorState,
} from "./indicator.js";
import { publishRail, railSlotLabel } from "./slots.js";

/** Space between a rail button and the tooltip or menu beside it. */
const POPOVER_GAP_PX = 8;

const BUTTON_CLASS = cx(
  "relative flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/80 outline-none hover:text-sidebar-foreground hover:[transform:translate3d(0,var(--bbm-lift),0)] focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50",
  PRESS,
);

// Moving along the rail shows one tooltip after another; only the first eases
// in, or every step would replay the entrance.
const TOOLTIP_WARM_MS = 300;
let lastTooltipHiddenAt = Number.NEGATIVE_INFINITY;

function useAnchorRect(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    setRect(open ? (anchor.current?.getBoundingClientRect() ?? null) : null);
  }, [anchor, open]);
  return rect;
}

function Tooltip({
  anchor,
  open,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  children: ReactNode;
}) {
  const rect = useAnchorRect(anchor, open);
  const warm = useMemo(
    () => open && performance.now() - lastTooltipHiddenAt < TOOLTIP_WARM_MS,
    [open],
  );
  // A layout effect, so the leaving tooltip's timestamp is in place before
  // the next button's tooltip renders.
  useLayoutEffect(() => {
    if (!open) return;
    return () => {
      lastTooltipHiddenAt = performance.now();
    };
  }, [open]);
  if (rect === null) return null;
  // The outer box only positions; the entrance moves the inner one, so it
  // can't fight the vertical centering.
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[70] -translate-y-1/2"
      style={{
        left: rect.right + POPOVER_GAP_PX,
        top: rect.top + rect.height / 2,
      }}
    >
      <div
        className={cx(
          "flex items-center gap-2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
          !warm && enter.slideLeft,
          !warm && speed.fast,
          !warm && NEAR,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function RailButton({
  label,
  shortcuts = [],
  active = false,
  disabled = false,
  onActivate,
  children,
}: {
  label: string;
  shortcuts?: readonly string[];
  active?: boolean;
  disabled?: boolean;
  onActivate: (openInSplit: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        disabled={disabled}
        // The active fill is the rail's sliding indicator, not the button's.
        className={cx(
          BUTTON_CLASS,
          active ? "text-sidebar-foreground" : "hover:bg-sidebar-accent",
        )}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={(event) => {
          setHover(false);
          onActivate(event.metaKey || event.ctrlKey);
        }}
      >
        {children}
      </button>
      <Tooltip anchor={ref} open={hover}>
        <span>{label}</span>
        {shortcuts.map((shortcut) => (
          <kbd key={shortcut} className="font-sans text-muted-foreground">
            {shortcut}
          </kbd>
        ))}
      </Tooltip>
    </>
  );
}

// After bb's shortcut pill on its navigation and thread rows, but opaque and smaller so it reads over an icon.
const SHORTCUT_PILL_CLASS =
  "pointer-events-none absolute -bottom-1 -right-1.5 inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm border border-border bg-popover px-1 py-0.5 font-sans text-[10px] font-normal leading-none tabular-nums text-muted-foreground shadow-sm";

function ItemButton({
  item,
  slotLabel,
  showShortcut,
  active,
  onActivate,
}: {
  item: ExperimentalSidebarNavigationItem;
  slotLabel: string | null;
  /** True while the shortcut modifier is held, when bb's rows reveal their shortcuts. */
  showShortcut: boolean;
  active: boolean;
  onActivate: (openInSplit: boolean) => void;
}) {
  const heldLabel = slotLabel ?? item.shortcut?.label ?? null;
  const Accessory = item.experimental_Accessory;
  const shortcuts = [item.shortcut?.label, slotLabel].filter(
    (shortcut): shortcut is string => Boolean(shortcut),
  );
  return (
    <RailButton
      label={item.label}
      shortcuts={shortcuts}
      active={active}
      disabled={item.isDisabled || item.isLoading}
      onActivate={onActivate}
    >
      <NavigationIcon icon={item.icon} className="size-[18px]" />
      {Accessory ? (
        <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 origin-top-right scale-[0.8] items-center justify-center overflow-hidden rounded-full bg-sidebar-accent px-0.5 text-[10px] leading-none text-sidebar-foreground">
          <Accessory />
        </span>
      ) : null}
      {showShortcut && heldLabel !== null ? (
        <kbd aria-hidden className={cx(SHORTCUT_PILL_CLASS, enter.fade, speed.fast)}>
          {heldLabel}
        </kbd>
      ) : null}
    </RailButton>
  );
}

function MoreMenu({
  hidden,
  onActivate,
  onCustomize,
}: {
  hidden: readonly ExperimentalSidebarNavigationItem[];
  onActivate: (item: ExperimentalSidebarNavigationItem) => void;
  onCustomize: () => void;
}) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(anchor, presence.mounted);
  // The exiting menu goes inert, which would drop focus held inside it to
  // the document body.
  const closeToTrigger = () => {
    if (menu.current?.contains(document.activeElement)) {
      anchor.current?.querySelector("button")?.focus();
    }
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menu.current?.contains(target) &&
        !anchor.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeToTrigger();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  const choose = (run: () => void) => {
    closeToTrigger();
    run();
  };
  return (
    <div ref={anchor}>
      <RailButton label="More" onActivate={() => setOpen((value) => !value)}>
        <Icon name="MoreHorizontal" className="size-[18px]" />
      </RailButton>
      {rect
        ? createPortal(
            <div
              ref={menu}
              role="menu"
              aria-label="More navigation"
              aria-hidden={presence.exiting || undefined}
              inert={presence.exiting}
              className={cx(
                "fixed z-[70] min-w-44 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg",
                presence.exiting ? exit.fade : cx(enter.scale, speed.fast),
              )}
              // Portalled outside the plugin root, where only bb's own
              // utilities apply, so the origin is set inline.
              style={{
                left: rect.right + POPOVER_GAP_PX,
                top: rect.top,
                transformOrigin: "top left",
              }}
              onAnimationEnd={presence.onAnimationEnd}
            >
              {hidden.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={item.isDisabled || item.isLoading}
                  className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-state-hover disabled:opacity-50"
                  onClick={() => choose(() => onActivate(item))}
                >
                  <NavigationIcon icon={item.icon} className="size-4" />
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
              {hidden.length > 0 ? (
                <div className="my-1 border-t border-border" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-state-hover"
                onClick={() => choose(onCustomize)}
              >
                <Icon name="Settings" className="size-4" />
                Customize sidebar
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function useIndicator(activeIndex: number): IndicatorState {
  const last = useRef<{ activeIndex: number; state: IndicatorState } | null>(
    null,
  );
  if (last.current?.activeIndex !== activeIndex) {
    last.current = {
      activeIndex,
      state: nextIndicator(last.current?.state ?? null, activeIndex),
    };
  }
  return last.current.state;
}

/** The active item's fill, sliding between rail items as the route changes. */
function ActiveIndicator({ activeIndex }: { activeIndex: number }) {
  const { index, visible, slide } = useIndicator(activeIndex);
  return (
    <span
      aria-hidden
      className={cx(
        "pointer-events-none absolute left-1/2 top-0 -ml-[1.125rem] size-9 rounded-md bg-sidebar-accent",
        TRANSFORM_TRANSITION,
        OPACITY_TRANSITION,
      )}
      style={{
        transform: `translate3d(0, ${railItemOffset(index)}, 0)`,
        opacity: visible ? 1 : 0,
        transitionProperty: slide ? undefined : "opacity",
      }}
    />
  );
}

export function SlimNavigation() {
  const { items, activeItemId, isShortcutModifierHeld, actions } =
    experimental_useSidebarNavigation();
  const visible = items.filter((item) => item.isVisible);
  const hidden = items.filter((item) => !item.isVisible);
  const isActive = (item: ExperimentalSidebarNavigationItem) =>
    item.id === activeItemId && item.action.kind !== "new-thread";
  const slotKey = visible
    .map((item) => `${item.id}:${item.isDisabled || item.isLoading ? 0 : 1}`)
    .join(",");
  useEffect(
    () =>
      publishRail(
        visible.map((item) => ({
          id: item.id,
          enabled: !item.isDisabled && !item.isLoading,
        })),
        (itemId) => actions.activate(itemId, { openInSplit: false }),
      ),
    // Republish only when the rail's order or enablement changes, not on every render.
    [slotKey, actions],
  );
  return (
    <div
      className="relative flex flex-col items-center gap-1 py-2"
      data-testid="slim-sidebar-navigation"
    >
      <ActiveIndicator activeIndex={visible.findIndex(isActive)} />
      {visible.map((item, index) => (
        <ItemButton
          key={item.id}
          item={item}
          slotLabel={railSlotLabel(index, navigator.platform)}
          showShortcut={isShortcutModifierHeld}
          active={isActive(item)}
          onActivate={(openInSplit) =>
            actions.activate(item.id, { openInSplit })
          }
        />
      ))}
      <MoreMenu
        hidden={hidden}
        onActivate={(item) => actions.activate(item.id, { openInSplit: false })}
        onCustomize={() => actions.openCustomize()}
      />
    </div>
  );
}
