/**
 * Draws on the bar's own screen through its local HTTP API.
 *
 * Plain `fetch` rather than the device client from busy-lib: measured on the
 * bar, a draw takes 30-60 ms this way and 100-150 ms through the client,
 * which is the difference between a list that follows the wheel and one that lags.
 */

const DRAW_URL = "http://127.0.0.1/api/display/draw";

async function send(method: "POST" | "DELETE", body: unknown): Promise<void> {
  const response = await fetch(DRAW_URL, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Read the answer either way, so the request is done with before the next one.
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} display: HTTP ${response.status} ${text}`);
}

export function drawElements(app: string, elements: readonly unknown[]): Promise<void> {
  return send("POST", { application_name: app, priority: 50, elements });
}

/**
 * Clears elements by id. The bar refuses the whole request when one of the ids
 * is gone already, which happens after it wipes the app's screen on Back: then
 * each id is cleared on its own, and the missing ones are let go.
 */
export async function clearElements(app: string, ids: readonly string[]): Promise<void> {
  try {
    await send("DELETE", { application_name: app, element_ids: ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.indexOf("not displaying anything") >= 0) return;
    if (message.indexOf("non-existent") < 0 || ids.length < 2) throw err;
    for (const id of ids) {
      await send("DELETE", { application_name: app, element_ids: [id] }).catch(() => undefined);
    }
  }
}
