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
- Notion:
  - a page is read as markdown (`GET /pages/{id}/markdown?markdown_version=v2`): one request, nested
    to-dos included, no block ids;
  - a to-do with a unique line is ticked with `PATCH /pages/{id}/markdown` (`update_content`), which
    keeps the block; otherwise its block id is found by walking the page's blocks once (`source.ts`).
- Back:
  - only `short` reaches the app; `long` never does;
  - Back does not clear the app's elements, so `show()` moves what left the frame off screen.
- Display:
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
Send input with single `POST /api/input` requests a second or more apart.

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
