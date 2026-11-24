# AGENTS.md

`Tasks for Notion` (`app.avachadev.notiontasks`): a BUSY Bar JS app that browses Notion and ticks tasks
off. What it does, its settings and its files: [README.md](README.md).

## Target

- Firmware 1.4.1 and newer, `api_version` 27.15.0. 1.3.1 is not supported. A higher `api_version`
  makes 1.4.1 refuse the app.
- The firmware is read-only reference: https://github.com/busy-app/busybar-firmware,
  `documentation/JavaScript Applications.dox.md`, `applications_js/AGENTS.md`.

## Facts the code relies on

- `fetch`:
  - HTTPS takes 1.3-1.7 s per request (a TLS handshake each time); the idle timeout is 5 s.
  - No abort.
  - Two HTTPS requests at once have rebooted the bar, so `notion.ts` keeps one request on the wire.
- No incoming connections: Notion webhooks cannot reach the bar. The open view is polled (`REFRESH_MS`).
- `version` in `src/appmeta/settings.json` stays 1: raising it makes 1.4.1 drop the saved values ("Missing migration"), the token with them. New fields go in without a bump.
- Notion:
  - a page is read as markdown (`GET /pages/{id}/markdown?markdown_version=v2`): one request, nested
    to-dos included, no block ids;
  - a to-do with a unique line is ticked with `PATCH /pages/{id}/markdown` (`update_content`), which
    keeps the block; otherwise its block id is found by walking the page's blocks once (`source.ts`);
  - a database's first view (`GET /v1/views?database_id=`, then `GET /v1/views/{id}`) gives its sorts
    and how it shows the status; any 4xx but 401 and 429 there means no view, and the app's own order.
- Text: the bar's `toLowerCase` lowers ASCII only ("Готово" stays as it is, measured 22.11); match names
  with `lower()` from `tasks.ts`.
- Keys: the app gets the wheel, OK, Start and Back (firmware docs, appendix 3); there are no left and
  right keys. A database row's title always opens and nothing under it is read before it is opened
  (`docs/databases.md`).
- Back:
  - only `short` reaches the app; `long` never does;
  - Back does not clear the app's elements, so `show()` moves what left the frame off screen.
- Display:
  - the firmware's shared animations and images are open to apps by `stock_path: "<folder>/<file>"`
    (only the file name counts, looked up in `/ext/apps_assets/shared/animations` or `images`); the
    loading screen uses `animations/spinner_front_8x8.anim`, the firmware's own spinner;
  - the firmware blends an animation's half-transparent pixels over what is under it: the loading
    screen greys the title with a 60% black layer (`load_dim`) whose clear band is the shimmer;
  - an app's animation file being played cannot be overwritten (`storage/write` fails): clear the
    elements first;
  - an animation that leaves the frame is deleted (`element_ids`), not moved off screen: sent again
    under an id the bar still has, it does not start over (the spinner stood still on the second loading
    screen), and off screen a looping one would go on costing frames;
  - an element id keeps its type: the checkbox and every mark are XPM under one id per slot;
    a plate, chevron or count a slot no longer has is moved off screen, in the same request;
  - an `image` element makes the bar read its file on every draw: plates are rectangles, checkboxes XPM;
  - `DELETE` without `element_ids` clears all of the app's elements (used after a failed draw).
- Speed (stock bar, 1.4.1, measured 21.11):
  - JavaScript costs about 3 us an instruction, a loop step with a closure about 1 ms: a frame touches
    only the lines on screen; lines and their elements are remembered (`screen.ts`), elements' JSON
    too (`display.ts`); the frames one wheel step away are built while idle (`getReady`);
  - the firmware draws a 9-element frame in about 40 ms; a wheel step took 234 ms (median) before
    this work and 119 ms after;
  - reading the settings costs the bar about 200 ms of file work, and saving `localStorage` writes
    flash: both wait until the user has been idle for `IDLE_MS`.
- Memory:
  - running out of the JS heap is `jerryscript fatal error 10` in the log, and the firmware then
    restarts the whole bar; a 43 KB page read whole did that with a 256 KiB heap;
  - the heap is 384 KiB; a page is read as a stream (`stream.ts`) and never held whole, at most
    `MAX_ENTRIES` lines; neighbouring frames are not prepared while a read is out;
  - a loop over bytes costs about 20-50 us a byte, `Uint8Array.indexOf` 3.6 us a byte (one pass over a
    94.6 KB answer: 342 ms, measured 22.11), so an answer is searched once, for a rare byte; only kept
    lines are decoded, ASCII natively; a regular expression run over a line costs about 0.3-3 ms;
  - a page with 120 subpages still takes several seconds to read: its first screen shows after 8
    lines (`FIRST_SCREEN`), and a slow view is read again no sooner than 3 times its read time.
- The top level: `roots.ts`, `docs/roots.md`; each sweep pass logs `sweep pass done in N s` with `console.error`.
- `localStorage` lives in `/ext/apps_data/jsrunner/app.avachadev.notiontasks.localstorage.json` and survives
  uninstalling the app; to start from nothing, stop the app and delete that file.
- Saved place: `cache.ts` stores under `place2`; bump the key whenever an entry or a database changes
  shape, or an old place is read into new code.
- Settings:
  - the app reads them only through `GET /api/apps/settings` and cannot write them;
  - `"sensitive": true` hides the token in local web, but the API still serves it;
  - bumping `version` in `settings.json` makes the bar discard the stored values, the token included:
    keep it at 1 unless the old values must go.
- `localStorage`: every `setItem` rewrites flash. `cache.ts` writes only on change and never stores the
  token.

## Measuring

Use the bar's own log, not the screen: polling `/api/screen` loads the same web server the app draws
through. `telnet 10.0.4.20`, `log error`, and one `console.error` line per frame with `Date.now()`
differences (console.log does not reach the log). `log trace` shows the firmware's file work too.
Send input with single `POST /api/input` requests a second or more apart. `key=up` turns the wheel
forward (down the list), `key=down` back. A script that presses Back once too often leaves the app and
goes on pressing in the firmware's menus.

Edge cases live in a test page in Notion (600 to-dos, a 204 KB page of notes,
120 subpages, deep nesting, odd titles, big and wide databases). Point **Start page** at it to test,
and set it back to empty after. Back on the top level leaves the app by design: a test script that
presses Back there ends up in the firmware's launcher, which is not a crash.

## Work

```bash
npm run typecheck && npm test && npm run build
```

On macOS repack the built `.tgz` as ustar before installing it on a bar: busy-cli's PAX headers make
the bar lose the manifest.

```bash
COPYFILE_DISABLE=1 tar --format ustar --uid 0 --gid 0 --uname root --gname root --no-xattrs --no-mac-metadata -czf <out>.tgz -C <unpacked> app.avachadev.notiontasks
```

Keep this file and README.md true to the code.

## State (23.11.2026)

- Done: browse and tick; status pick; confetti for Done-like statuses in any group; first-run guide (front "look at the back", back screen with the bar's addresses); token help text; subpage emoji fetched in the background; wheel stalls and memory; sounds dropped for this release.
- "Today": JS on the bar has no time zone (`getTimezoneOffset()` is 0), so the offset comes from `GET /api/time` (`clock.ts`), asked every 10 minutes before a database read; dates are counted from UTC plus that offset.
- Messages without a mark (`Set up`, `Bad token` and the like) start at the marks' column, x = 1: an empty place for a mark read as a gap.
- Version 1.0.2: earlier releases 1.0.0 and 1.0.1 went out before the catalog, so the numbering goes on from them.
- Catalog: `catalog.json` (productivity); `screenshots/front-2..4.png` and `back-1..2.png` are exact frames from `GET /api/screen` of a demo workspace, `back-2` from BUSY Bar Emulator. `front-1` (1.0.3) is composed: the list drawn by the app's own `listFrame` on the emulator, white done text, the confetti of a bar capture laid over it and cleared off the letters. `busy-emulator check .` passes.
- Checked on BUSY Bars on firmware 1.4.1; 104 tests pass. Over Wi-Fi `key=down` at the top of a list does nothing: `key=up` goes down the list.
- Push as avachadev: `git -c credential.helper= -c "credential.helper=!f() { echo username=avachadev; echo password=$(gh auth token --user avachadev); }; f" push`.
