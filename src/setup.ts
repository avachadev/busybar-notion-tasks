/**
 * The back screen while the app has no token it can use: one screen that says
 * what to do, after the help of the Internet Speed app. The front says only
 * "look at the back"; there is no room on it for an address and a path.
 *
 * Back screen: 160x80 in greys, the right 12 px are the firmware's status bar,
 * so 148 px are ours. Widths measured with busy-lib's metrics of the bar's
 * fonts (22.11): "Connect Notion" bold 85, "Open in a browser:" 86,
 * "Apps → Tasks for Notion" 136, "paste a Notion token" about 100. The link
 * to Notion's token page (157 px) does not fit: it is in the setting's own
 * description, next to where the token is pasted.
 */

export interface WebAddress {
  readonly how: "Wi-Fi" | "USB";
  readonly address: string;
}

interface Base {
  id: string;
  display: "back";
  x: number;
  y: number;
  z_index: number;
}
export type SetupElement =
  | (Base & { type: "text"; align: "top_left"; text: string; font: "bold" | "normal" | "extra_large"; color: string })
  | (Base & { type: "rectangle"; width: number; height: number; radius: number; fill: "solid"; fill_colors: string[]; border_width: number })
  | (Base & { type: "xpmbitmap"; align: "top_left"; data: string });

export const BACK_W = 148;
const WHITE = "#FFFFFFFF";
const GREY = "#909090FF";
const BLACK = "#000000FF";

/** `normal`, `bold` and `extra_large` start their glyphs 2 px below the element's y. */
const LINE = 12;
const TAG_H = 14;
const TAG_STEP = TAG_H + 2;

/** Measured: "Wi-Fi" and "USB" in `normal`, "Apps" in `bold`; the gap around the arrow. */
const NAME_W = { "Wi-Fi": 26, USB: 17 } as const;
const APPS_W = 25;
const SPACE = 5;
const ARROW_W = 6;

/** "192.168.1.101" in `extra_large`: digits 7 px, "1" 4, "." 2, 1 px between glyphs. */
function addressWidth(address: string): number {
  let w = address.length - 1;
  for (const c of address) w += c === "1" ? 4 : c === "." ? 2 : 7;
  return w;
}

/** Icons copied pixel for pixel from the firmware's status bar. */
const WIFI = [".######.", "#......#", "..####..", ".#....#.", "........", "...##...", "...##..."];
const USB_UPRIGHT = [
  "...#....", "..###...", ".#####..", "...#....", "...#.###", "##.#..#.",
  "##.#.#..", ".#.##...", "..##....", "...#....", "..###...", "..###...",
];
/** Turned a quarter clockwise: the plug points right. */
const USB = USB_UPRIGHT[0].split("").map((_, x) => USB_UPRIGHT.map((row) => row[x]).reverse().join(""));
/** The font's own arrow; the firmware draws "→" heavier. */
const ARROW = ["...#..", "....#.", "######", "....#.", "...#.."];

function xpm(rows: readonly string[], color: string): string {
  return ["! XPM2", `${rows[0].length} ${rows.length} 2 1`, ". c none", `# c ${color.slice(0, 7)}`, ...rows].join("\n");
}

/** Why the app needs the user: no token yet, or one Notion does not take. */
export type SetupReason = "none" | "bad";

/**
 * The back screen's elements, ids starting with `b_`. Where the bar's web page
 * opens comes from `addresses`; with none known, a USB cable is the way in.
 */
export function setupElements(reason: SetupReason, addresses: readonly WebAddress[]): SetupElement[] {
  const out: SetupElement[] = [];
  let y = 0;
  const text = (key: string, x: number, at: number, value: string, font: "bold" | "normal" | "extra_large", color: string) =>
    out.push({ id: `b_${key}`, type: "text", display: "back", align: "top_left", x, y: at, text: value, font, color, z_index: 2 });
  const picture = (key: string, x: number, at: number, rows: readonly string[], color: string) =>
    out.push({ id: `b_${key}`, type: "xpmbitmap", display: "back", align: "top_left", x, y: at, data: xpm(rows, color), z_index: 2 });
  const line = (key: string, value: string, font: "bold" | "normal" = "normal", color = GREY) => {
    text(key, 0, y, value, font, color);
    y += LINE;
  };
  const tag = (n: number, a: WebAddress) => {
    const top = y + 1;
    const icon = a.how === "Wi-Fi" ? WIFI : USB;
    const iconW = icon[0].length;
    const addressW = addressWidth(a.address);
    // Padding 3, icon, 3, name, 5, address, 4. The name goes when there is no room for it.
    const full = 3 + iconW + 3 + NAME_W[a.how] + 5 + addressW + 4;
    const named = full <= BACK_W;
    const addressX = named ? full - 4 - addressW : 3 + iconW + 5;
    out.push({ id: `b_tag${n}`, type: "rectangle", display: "back", x: 0, y: top, width: addressX + addressW + 4, height: TAG_H, radius: 3, fill: "solid", fill_colors: [WHITE], border_width: 0, z_index: 1 });
    picture(`tag${n}_icon`, 3, top + Math.floor((TAG_H - icon.length) / 2), icon, BLACK);
    if (named) text(`tag${n}_name`, 3 + iconW + 3, top + 1, a.how, "normal", BLACK);
    text(`tag${n}_address`, addressX, top, a.address, "extra_large", BLACK);
    y += TAG_STEP;
  };

  line("title", reason === "bad" ? "Token not accepted" : "Connect Notion", "bold", WHITE);
  // Both addresses fit: the last line then ends at row 78 of 80.
  const shown = addresses.length > 0 ? addresses.slice(0, 2) : [{ how: "USB", address: "10.0.4.20" } as const];
  line("open", addresses.length > 0 ? "Open in a browser:" : "Plug in by USB, open:");
  shown.forEach((a, n) => tag(n, a));
  text("apps", 0, y, "Apps", "bold", WHITE);
  picture("arrow", APPS_W + SPACE, y + 3, ARROW, WHITE);
  text("app", APPS_W + SPACE + ARROW_W + SPACE, y, "Tasks for Notion", "bold", WHITE);
  y += LINE;
  line("paste", reason === "bad" ? "paste a new Notion token" : "paste a Notion token");
  return out;
}

const API = "http://127.0.0.1/api";

/** Where the bar's web page opens: its Wi-Fi address when the API is open there, and USB when a computer may be on the cable. */
export async function webAddresses(): Promise<WebAddress[]> {
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(`${API}/${path}`);
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const wifi = await get<{ state?: string; ip_config?: { address?: string } }>("wifi/status");
  const access = await get<{ mode?: string }>("access");
  const power = await get<{ usb_voltage?: number }>("status/power");
  const out: WebAddress[] = [];
  if (wifi?.state === "connected" && wifi.ip_config?.address && access?.mode === "enabled") out.push({ how: "Wi-Fi", address: wifi.ip_config.address });
  // A charger cannot be told from a computer's port.
  if ((power?.usb_voltage ?? 0) > 4000) out.push({ how: "USB", address: "10.0.4.20" });
  return out;
}
