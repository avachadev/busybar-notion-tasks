/** The app's settings, as edited in the bar's web interface. */

import { type ListLink, parseListLink, parseToken } from "./link.ts";
import type { Scope } from "./tasks.ts";

export interface Config {
  /** "" when not set, null when what was pasted cannot be a token. */
  readonly token: string | null;
  readonly link: ListLink;
  readonly scope: Scope;
  /** The Notion logo at the left of the screen, for photos and videos. */
  readonly logo: boolean;
}

const SETTINGS_URL = "http://127.0.0.1/api/apps/settings?app_id=";

const text = (v: unknown) => (typeof v === "string" ? v : "");

export async function readConfig(appId: string): Promise<Config> {
  const response = await fetch(SETTINGS_URL + appId);
  const body = await response.text();
  if (!response.ok) throw new Error(`settings: HTTP ${response.status}`);
  const values = ((JSON.parse(body) as { values?: Record<string, unknown> }).values) ?? {};
  return {
    token: parseToken(text(values.token)),
    link: parseListLink(text(values.list)),
    scope: values.scope === "all" ? "all" : "today",
    logo: values.logo === true,
  };
}

/** A key that changes whenever the settings mean other Notion content; the logo only changes the look. */
export function configKey(c: Config): string {
  const link = c.link.kind === "id" ? c.link.id : c.link.kind === "invalid" ? `?${c.link.text}` : "";
  return `${c.token ?? "?"}|${link}|${c.scope}`;
}

/** Can Notion be read with these settings. */
export function usable(c: Config | null): c is Config & { token: string } {
  return c !== null && typeof c.token === "string" && c.token !== "" && c.link.kind !== "invalid";
}

/**
 * A short fingerprint of the token, so what was saved under one token is not
 * shown under another. Not a secret: 32 bits of FNV-1a.
 */
export function tokenTag(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
