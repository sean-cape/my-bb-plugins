import type { LoopGates } from "../shared/loop";

export type GateOption = { gate: keyof LoopGates; label: string; hint: string; detail: string };

/** The gates that wait for the user. */
export const HOLDS: GateOption[] = [
  {
    gate: "plan",
    label: "Plan approval",
    hint: "Building waits until you approve a plan",
    detail: "The card's thread proposes a plan and the card waits in planning. Approve it, edited or not, with Y; the approved plan goes to the thread and into every review.",
  },
  {
    gate: "findings",
    label: "Findings approval",
    hint: "Each round's fixes wait for you",
    detail: "Each review round stops at Needs you. Untick the findings you don't want fixed and approve the rest with Y; the unticked stay open.",
  },
];

/** The gates that let the loop finish on its own. */
export const SKIPS: GateOption[] = [
  {
    gate: "autoAccept",
    label: "Auto-accept",
    hint: "A clean, low-risk change is accepted for you",
    detail: "A change that ends clean at Glance, with no critical or important finding or dispute open, is accepted without stopping at Needs you. Never at Read or Scrutinize; open minors are listed on the card.",
  },
];
