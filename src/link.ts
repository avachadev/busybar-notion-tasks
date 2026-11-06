/**
 * Turns what was pasted into the settings into a Notion object id and a token.
 *
 * A Notion link ends its path with the object's 32-digit id, after a slug made
 * from the title: `https://www.notion.so/team/Tasks-1a2b...?v=...`. The `v`
 * query parameter is the id of a view, not of the list, so only the path counts.
 * A bare id, with or without dashes, works too.
 */

export type ListLink =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly text: string }
  | { readonly kind: "id"; readonly id: string };

const HEX32 = /([0-9a-fA-F]{32})$/;

/** 32 hex digits in the dashed 8-4-4-4-12 form the API returns. */
export function dashed(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}`;
}

export function parseListLink(raw: string): ListLink {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };

  let path = text;
  for (const stop of ["?", "#"]) {
    const at = path.indexOf(stop);
    if (at >= 0) path = path.substring(0, at);
  }
  while (path.length > 0 && path[path.length - 1] === "/") path = path.substring(0, path.length - 1);
  const compact = path.split("-").join("");
  const match = HEX32.exec(compact);
  return match ? { kind: "id", id: dashed(match[1]) } : { kind: "invalid", text };
}

/**
 * A token is one word: an internal connection's starts with `ntn_` (older ones
 * with `secret_`), a personal access token has its own prefix. Anything with
 * spaces in it was pasted wrong.
 */
export function parseToken(raw: string): string | null {
  const token = raw.trim();
  if (token === "") return "";
  return /^[A-Za-z0-9_\-.]{20,}$/.test(token) ? token : null;
}
