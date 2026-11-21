/**
 * Where the focus may stand in a list: on anything but a heading, which only
 * names a part of the page. Pure, so it is tested off the device.
 */

import type { Entry } from "./tasks.ts";

export const focusable = (e: Entry | undefined): boolean => e !== undefined && e.kind !== "heading";

/** The next focusable line from `from` in the wheel's direction; `from` when there is none that way. */
export function step(list: readonly Entry[], from: number, delta: number): number {
  for (let i = from + delta; i >= 0 && i < list.length; i += delta) if (focusable(list[i])) return i;
  return from;
}

/** `at`, or the nearest focusable line after it, else before it; 0 when the list has none. */
export function settle(list: readonly Entry[], at: number): number {
  const i = Math.max(0, Math.min(at, list.length - 1));
  if (focusable(list[i])) return i;
  const after = step(list, i, 1);
  if (after !== i) return after;
  const before = step(list, i, -1);
  return before !== i ? before : i;
}
