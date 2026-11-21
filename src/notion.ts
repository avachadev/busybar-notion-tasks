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
  /** On 429: how long Notion asks to wait, in ms; 0 when it does not say. */
  readonly retryAfterMs: number;

  constructor(status: number, code: string, message: string, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Rejects when `work` takes longer than `ms`. The work itself carries on. */
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

/** How long a caller waits, its turn on the wire included. A call takes 1.3-1.7 s on the bar. */
const TIMEOUT_MS = 30000;

export type Json = Record<string, unknown>;

interface Answer {
  readonly ok: boolean;
  readonly status: number;
  readonly json: Json | null;
  /** The Retry-After header, in seconds, or NaN. */
  readonly retryAfter: number;
}

function header(response: Response, name: string): string {
  try {
    return response.headers.get(name) ?? "";
  } catch {
    return "";
  }
}

/**
 * The request on the wire. The next one starts only once it has settled, even
 * when its caller has given up on a timeout: the firmware cannot abort a fetch,
 * and two HTTPS requests at once have rebooted the bar.
 */
let onWire: Promise<unknown> = Promise.resolve();

async function exchange(url: string, init: RequestInit): Promise<Answer> {
  const response = await fetch(url, init);
  let json: Json | null = null;
  try {
    json = (await response.json()) as Json;
  } catch {
    // An error page that is not JSON: the status says enough.
  }
  return { ok: response.ok, status: response.status, json, retryAfter: Number(header(response, "retry-after") || NaN) };
}

export async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<Json> {
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

  const turn = onWire.then(() => exchange(API_BASE + path, init));
  onWire = turn.catch(() => undefined);
  const answer = await withTimeout(turn, timeoutMs);

  const json = answer.json ?? {};
  if (!answer.ok) {
    const code = typeof json.code === "string" ? json.code : "";
    const message = typeof json.message === "string" ? json.message : `HTTP ${answer.status}`;
    const extra = json.additional_data as { retry_after?: unknown } | undefined;
    const seconds = typeof extra?.retry_after === "number" ? extra.retry_after : answer.retryAfter;
    throw new NotionError(answer.status, code, message, seconds > 0 ? seconds * 1000 : 0);
  }
  if (answer.json === null) throw new Error("unreadable response");
  return json;
}
