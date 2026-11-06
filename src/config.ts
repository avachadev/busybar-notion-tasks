/** The app's settings, as edited in the bar's web interface. */

import { device } from "@shared/device";
import { loadValues } from "@shared/settings";

import { type ListLink, parseListLink, parseToken } from "./link.ts";
import type { Scope } from "./tasks.ts";

export interface Config {
  /** "" when not set, null when what was pasted cannot be a token. */
  readonly token: string | null;
  readonly link: ListLink;
  readonly scope: Scope;
}

/**
 * Stored settings. The runtime's `Settings` global comes first; where it is
 * missing, the documented `GET /api/apps/settings` endpoint answers instead.
 */
async function readValues(appId: string): Promise<Record<string, unknown>> {
  const local = await loadValues();
  if (local) return local;
  const doc = await device.AppsSettingsGet({ app_id: appId });
  return doc.values;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

export async function readConfig(appId: string): Promise<Config> {
  const values = await readValues(appId);
  return {
    token: parseToken(text(values.token)),
    link: parseListLink(text(values.list)),
    scope: values.scope === "all" ? "all" : "today",
  };
}

/** A key that changes whenever the settings mean something different. */
export function configKey(c: Config): string {
  const link = c.link.kind === "id" ? c.link.id : c.link.kind === "invalid" ? `?${c.link.text}` : "";
  return `${c.token ?? "?"}|${link}|${c.scope}`;
}
