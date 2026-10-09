import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/rpc-contract";
import { errorMessage } from "../shared/common";
import type { DescriptorState, MethodInfo, ServiceInfo, TypeClosure } from "../shared/schema";

/** Width of an element that may mount after the first render (hence a callback ref). */
export function useWidth(): [(node: HTMLDivElement | null) => void, number, HTMLDivElement | null] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (node === null) return;
    setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width, node];
}

/** Closes an open panel on a pointer press outside `root`, or on Escape. */
export function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, onOpenChange: (open: boolean) => void): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [root, open, onOpenChange]);
}

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Makes a panel inert while it plays its exit, first handing focus inside it
 * back to the trigger (the first focusable in `root` outside the panel).
 * `inert` is set here rather than in JSX so focus moves before inert would
 * drop it to the body.
 */
export function useInertWhileClosing(root: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, closing: boolean): void {
  useLayoutEffect(() => {
    const node = panel.current;
    if (node === null) return;
    if (closing && node.contains(document.activeElement)) {
      const trigger = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((element) => !node.contains(element));
      trigger?.focus();
    }
    node.inert = closing;
  }, [root, panel, closing]);
}

interface ServiceData {
  services: ServiceInfo[];
  state: DescriptorState;
}

type ServicesState =
  | { key: string; status: "loading"; data: ServiceData | null }
  | { key: string; status: "ready"; data: ServiceData }
  | { key: string; status: "error"; error: string; data: ServiceData | null };

/** Services for an "endpoint|source" key; a failed reload keeps the last good data. */
export function useServices(servicesKey: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [services, setServices] = useState<ServicesState | null>(null);
  // Responses for a key the user has since navigated away from are dropped.
  const latestKey = useRef<string | null>(null);
  const load = useCallback(
    (key: string, reload: boolean) => {
      const [endpoint, source] = key.split("|") as [string, string];
      latestKey.current = key;
      setServices((previous) => ({ key, status: "loading", data: previous?.key === key ? previous.data : null }));
      rpc.call("services", { endpoint, source, reload }).then(
        (result) => {
          if (latestKey.current !== key) return;
          setServices({ key, status: "ready", data: { services: result.services, state: result.state } });
        },
        (cause) => {
          if (latestKey.current !== key) return;
          setServices((previous) => ({ key, status: "error", error: errorMessage(cause), data: previous?.key === key ? previous.data : null }));
        },
      );
    },
    [rpc],
  );
  useEffect(() => {
    if (servicesKey !== null) load(servicesKey, false);
  }, [servicesKey, load]);
  return {
    current: services !== null && services.key === servicesKey ? services : null,
    /** Rebuilds the descriptors on the host. */
    reload: () => {
      if (servicesKey !== null) load(servicesKey, true);
    },
    /** Refetches the last requested key, which the host serves from cache unless its source changed. */
    refresh: () => {
      if (latestKey.current !== null) load(latestKey.current, false);
    },
  };
}

/** The request type closure of the selected method, cached per descriptor load. */
export function useTypeClosure(method: MethodInfo | null, endpointName: string | null, sourceName: string | null, loadedAt: number) {
  const rpc = useRpc<typeof rpcContract>();
  const closures = useRef(new Map<string, TypeClosure>());
  const [closure, setClosure] = useState<TypeClosure | null>(null);
  const [closureError, setClosureError] = useState<string | null>(null);
  useEffect(() => {
    setClosureError(null);
    if (method === null || endpointName === null || sourceName === null) {
      setClosure(null);
      return;
    }
    const key = `${endpointName}|${sourceName}|${loadedAt}|${method.input}`;
    const cached = closures.current.get(key);
    if (cached !== undefined) {
      setClosure(cached);
      return;
    }
    setClosure(null);
    let cancelled = false;
    rpc.call("types", { endpoint: endpointName, source: sourceName, typeName: method.input }).then(
      (result) => {
        closures.current.set(key, result);
        if (!cancelled) setClosure(result);
      },
      (cause) => {
        if (!cancelled) setClosureError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, method, endpointName, sourceName, loadedAt]);
  return { closure, closureError };
}
