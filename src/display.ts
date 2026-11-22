/**
 * Draws on the bar's own screen through its local HTTP API.
 *
 * Plain `fetch` rather than the device client from busy-lib: measured on the
 * bar, a draw takes 30-60 ms this way and 100-150 ms through the client,
 * which is the difference between a list that follows the wheel and one that lags.
 */

const DRAW_URL = "http://127.0.0.1/api/display/draw";

async function send(method: "POST" | "DELETE", body: string): Promise<void> {
  const response = await fetch(DRAW_URL, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
  // Read the answer either way, so the request is done with before the next one.
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} display: HTTP ${response.status} ${text}`);
}

/**
 * Each element's JSON, made once: most elements of a frame are the same objects
 * as in the last one, and serialising on the bar is slow. Cleared when it grows.
 */
const json = new Map<object, string>();
const MAX_JSON = 60;

/** Serialises elements ahead of time, while the user is idle, so drawing them later is only the request. */
export function prepare(elements: readonly object[]): void {
  for (const element of elements) jsonOf(element);
}

function jsonOf(element: object): string {
  let text = json.get(element);
  if (text === undefined) {
    if (json.size >= MAX_JSON) json.clear();
    text = JSON.stringify(element);
    json.set(element, text);
  }
  return text;
}

export function drawElements(app: string, elements: readonly object[]): Promise<void> {
  return send("POST", `{"application_name":${JSON.stringify(app)},"priority":50,"elements":[${elements.map(jsonOf).join(",")}]}`);
}

/** Clears every element the app has on screen: to start over once what is there is no longer known. */
export async function clearAll(app: string): Promise<void> {
  try {
    await send("DELETE", JSON.stringify({ application_name: app }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.indexOf("not displaying anything") < 0) throw err;
  }
}
