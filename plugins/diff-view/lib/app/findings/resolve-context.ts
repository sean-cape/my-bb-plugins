import { createContext } from "react";
import type { InlineFinding } from "./findings";

/** Resolves a finding from its card in the diff, as a GitHub thread is resolved; null when the source can't. */
export const ResolveFindingContext = createContext<((item: InlineFinding) => void) | null>(null);
