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
  - Back does not clear the app's elements, so `show()` clears what left the frame.
- Display:
  - an element id keeps its type: a slot that changes kind uses another id (`screen.ts`);
  - `DELETE` with `element_ids` is refused whole when one id is gone (`display.ts`).
- Settings:
  - the app reads them only through `GET /api/apps/settings` and cannot write them;
  - `"sensitive": true` hides the token in local web, but the API still serves it;
  - bumping `version` in `settings.json` makes the bar discard the stored values, the token included:
    keep it at 1 unless the old values must go.
- `localStorage`: every `setItem` rewrites flash. `cache.ts` writes only on change and never stores the
  token.

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
