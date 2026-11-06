/**
 * The few Notion API calls the app makes, straight from the bar.
 *
 * The bar's `fetch` sends any method and custom headers, so no proxy is needed:
 * the token goes in `Authorization`, and closing a task is a `PATCH`. Every
 * response is JSON, errors included.
 */

export const API_BASE = "https://api.notion.com/v1/";
export const NOTION_VERSION = "2026-03-11";

/** An answer from Notion that is not a success, with its HTTP status and error code. */
export class NotionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Rejects a request that never answers, so a stalled call cannot block the next one. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("timeout"));
    }, ms);

    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** TLS on the bar is slow: a call takes about ten seconds, so allow for more. */
const TIMEOUT_MS = 30000;

export type Json = Record<string, unknown>;

export async function call(token: string, method: string, path: string, body?: unknown): Promise<Json> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  };
  // The firmware rejects a `body` key that is not a string, so leave it out when there is none.
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await withTimeout(fetch(API_BASE + path, init), TIMEOUT_MS);
  let json: Json = {};
  try {
    json = (await withTimeout(response.json(), TIMEOUT_MS)) as Json;
  } catch {
    if (response.ok) throw new Error("unreadable response");
  }
  if (!response.ok) {
    const code = typeof json.code === "string" ? json.code : "";
    const message = typeof json.message === "string" ? json.message : `HTTP ${response.status}`;
    throw new NotionError(response.status, code, message);
  }
  return json;
}
