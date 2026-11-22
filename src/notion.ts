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
 * Who waits for a request, most urgent first. A tick or a status the user set,
 * then the view on screen, then keeping the top level up to date, then the
 * sweep of the whole workspace (`docs/roots.md`).
 */
export const WRITE = 0;
export const VIEW = 1;
export const UPKEEP = 2;
export const SWEEP = 3;

/** How a request takes its turn: its priority, whether it is still wanted when its turn comes, how long its caller waits. */
export interface Turn {
  readonly priority?: number;
  readonly alive?: () => boolean;
  readonly timeoutMs?: number;
}

/** Thrown to a caller whose request was dropped before it started: `alive` said it was no longer wanted. */
export class DroppedError extends Error {}

interface Job {
  readonly priority: number;
  readonly seq: number;
  readonly alive: (() => boolean) | undefined;
  /** Runs the request; resolves when it has settled. */
  readonly run: () => Promise<void>;
  /** Tells the caller it was dropped. */
  readonly drop: () => void;
  /** The caller gave up while it waited: it is not started. */
  gone: boolean;
}

/**
 * One request on the wire at a time: the firmware cannot abort a fetch, and two
 * HTTPS requests at once have rebooted the bar. Whatever starts holds the wire
 * for its whole length (1.5-2 s), so what starts next is chosen by priority, in
 * the order asked within one. A request whose caller gave up, or whose `alive`
 * says no, is not started.
 */
const waiting: Job[] = [];
let busy = false;
let seq = 0;
/** Notion asked to wait (429, 529): nothing starts before this, whoever asks. */
let heldUntil = 0;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
/** A wait asked without saying how long. */
const DEFAULT_HOLD_MS = 2000;

function pump(): void {
  const wait = heldUntil - Date.now();
  if (wait > 0) {
    if (holdTimer === undefined) {
      holdTimer = setTimeout(() => {
        holdTimer = undefined;
        pump();
      }, wait);
    }
    return;
  }
  while (!busy && waiting.length > 0) {
    const job = waiting.shift() as Job;
    if (job.gone) continue;
    if (job.alive && !job.alive()) {
      job.drop();
      continue;
    }
    busy = true;
    const done = (): void => {
      busy = false;
      pump();
    };
    job.run().then(done, done);
  }
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Queues `work` and settles with it once it has had its turn. The caller waits
 * at most `timeoutMs`, its time in the queue included; work already on the wire
 * carries on regardless, as nothing can stop it.
 */
function take<T>(turn: Turn | undefined, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const priority = turn?.priority ?? VIEW;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const job: Job = {
      priority,
      seq: (seq += 1),
      alive: turn?.alive,
      run: () => work().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(asError(err));
        },
      ),
      drop: () => {
        clearTimeout(timer);
        reject(new DroppedError("no longer wanted"));
      },
      gone: false,
    };
    // A short list, kept in order: after every job as urgent or more.
    let at = waiting.length;
    while (at > 0 && waiting[at - 1].priority > priority) at -= 1;
    waiting.splice(at, 0, job);
    timer = setTimeout(() => {
      job.gone = true;
      reject(new Error("timeout"));
    }, turn?.timeoutMs ?? TIMEOUT_MS);
    pump();
  });
}

/** Nothing on the wire and nothing waiting: a sweep may take its turn without holding anyone up. */
export function wireIdle(): boolean {
  return !busy && waiting.every((j) => j.gone);
}

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

export async function call(token: string, method: string, path: string, body?: unknown, turn?: Turn): Promise<Json> {
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

  const answer = await take(turn, () => exchange(API_BASE + path, init));

  if (!answer.ok) throw failure(answer);
  if (answer.json === null) throw new Error("unreadable response");
  return answer.json;
}

function failure(answer: Answer): NotionError {
  const json = answer.json ?? {};
  const code = typeof json.code === "string" ? json.code : "";
  const message = typeof json.message === "string" ? json.message : `HTTP ${answer.status}`;
  const extra = json.additional_data as { retry_after?: unknown } | undefined;
  // The body's `retry_after` is a string of whole seconds; the header the same, where the bar shows it.
  const fromBody = Number(extra?.retry_after);
  const seconds = fromBody > 0 ? fromBody : answer.retryAfter;
  const waitMs = seconds > 0 ? seconds * 1000 : 0;
  if (answer.status === 429 || answer.status === 529) heldUntil = Math.max(heldUntil, Date.now() + (waitMs || DEFAULT_HOLD_MS));
  return new NotionError(answer.status, code, message, waitMs);
}

interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(): Promise<void>;
}

/**
 * A GET whose answer is handed on chunk by chunk as it arrives, never held
 * whole; `onChunk` says whether more is wanted, and once it does not the rest
 * is let go. Takes its turn on the wire as `call` does.
 */
export async function stream(
  token: string,
  path: string,
  onChunk: (bytes: Uint8Array) => boolean,
  turn?: Turn,
  method = "GET",
  body?: unknown,
): Promise<void> {
  let wanted = true;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const hand = (bytes: Uint8Array) => (wanted = wanted && onChunk(bytes));
  const work = async (): Promise<NotionError | null> => {
    const response = await fetch(API_BASE + path, init);
    if (!response.ok) {
      let json: Json | null = null;
      try {
        json = (await response.json()) as Json;
      } catch {
        // An error page that is not JSON: the status says enough.
      }
      return failure({ ok: false, status: response.status, json, retryAfter: Number(header(response, "retry-after") || NaN) });
    }
    const body = response.body as unknown as { getReader?: () => Reader } | null;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      for (;;) {
        const part = await reader.read();
        if (part.done || !part.value) break;
        if (!hand(part.value)) {
          try {
            if (reader.cancel) await reader.cancel();
          } catch {
            // Nothing more to read either way.
          }
          break;
        }
      }
    } else {
      // A runtime without streams: the answer in one piece.
      hand(new TextEncoder().encode(await response.text()));
    }
    return null;
  };
  try {
    const error = await take(turn, work);
    if (error) throw error;
  } finally {
    // Given up or done: whatever still arrives is not handed on.
    wanted = false;
  }
}
