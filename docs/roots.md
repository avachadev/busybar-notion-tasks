# The top level

Built (22.11.2026): `notion.ts` (the queue), `scan.ts`, `roots.ts`, `main.ts`. Not built: the
ancestor walk for a quick first fill (the first pass took 44 s on a 929-page workspace, so it was not
needed there), and a sweep for an internal connection, whose top level is still read the old way: the
first 100 search results, a page whose parent is not among them counting as top level. How the app finds and keeps the workspace's top-level pages and databases,
and how often it checks them while the app is open.

## The problem

The Notion API has no call for the sidebar: no "children of the workspace", no search filter by parent,
no teamspaces (`post-search`, `parent-object`, changelog up to November 2026). A page or a database is
top level when its parent is `{"type":"workspace"}`; teamspace pages look the same. The only way to see
them is to go through `POST /v1/search`, which lists every page the token can see: subpages at any depth
and every row of every database. Notion itself says search "can't provide a complete inventory".

Today the app reads the first 100 results (5 searches of 20) and keeps those with a workspace parent. On
a test workspace of 929 pages, two of the three top-level pages are not among them. A quick check of the
10 last edited runs every 15 s, the full read every 10 minutes.

## Facts the design rests on

Measured on the API with a personal access token, 22.11.2026, unless a link says otherwise.

| Fact | Consequence |
|---|---|
| Search without `sort` returns pages by `last_edited_time`, newest first; with an explicit descending sort the order is the same | the sweep and the recent check read the same order |
| `last_edited_time` has minute precision (`...T16:13:00.000Z`) | a watermark must overlap by a minute; equal times are normal |
| `next_cursor` is the id of the next result | a cursor is 36 bytes to save |
| Creating a child page bumps the parent's `last_edited_time` | a top-level page with new content comes to the front |
| Moving a page (`POST /pages/{id}/move`) does not change its `last_edited_time` | a top-level page moved under another page is not seen by the recent check: each root has to be checked by itself |
| Restoring from trash bumps `last_edited_time` too; 4 s later the page was not in search yet | the recent check sees restores, after Notion's index catches up |
| Trashing a page bumps `last_edited_time`; `GET /pages/{id}` then answers 200 with `"in_trash":true` | trash is seen by a search with `filter: {"in_trash": true}`, newest first, or by getting the page |
| A page deleted for good, or no longer shared, answers 404 | drop it |
| 100 results with `filter_properties=title`: 94.6 KB; without it 123.8 KB; 20 results about 20 KB | a full page of results cannot go through `JSON.parse` on the bar |
| Compact JSON, key order: `object`, `id`, `created_time`, `last_edited_time`, ..., `parent`, `in_trash`, ..., `properties` | the id comes before the parent in each result; a scanner can rely on it, with a guard |
| `GET /users/me`: a personal token has `bot.owner.type = "user"`, an internal connection `"workspace"` | an internal connection may see a page whose parent it cannot see: such a page is top level for it |
| Rate limit 180 requests a minute per connection, Retry-After on 429 (`request-limits`) | the sweep is far below it |

On the bar (AGENTS.md): one HTTPS request at a time (two at once rebooted it), 1.3-1.7 s each for the TLS
handshake, no abort, a 5 s idle timeout; the JS heap is 384 KiB and running out restarts the bar;
`Uint8Array.indexOf` about 3 us a byte, a decoding loop 20-54 us a byte, a loop step with a closure about
1 ms; `toLowerCase` lowers ASCII only; every `localStorage.setItem` writes flash.

Measured on the bar (step 0, 22.11, a test bar, 1.4.1, by USB; from inside the app, as the CLI's `js`
answers "Out of resources"):

| Search answer | Head (TLS) | Body | Of it |
|---|---|---|---|
| 100 results, 94.6 KB, 70 chunks of up to 1460 bytes | 1.47-1.51 s | 0.75 s | a scan with a check at every `{`: 0.59 s |
| 50 results, 47 KB | 1.48 s | 0.35 s | the same scan: 0.29 s |
| 20 results, 18.4 KB, `text()` and `JSON.parse` | 1.42 s | 0.13 s | `text()` 62 ms, `JSON.parse` 70 ms |

One `Uint8Array.indexOf` pass over the 94.6 KB costs 342 ms (3.6 us a byte, native); a loop over every
`w` in it (2 hits) 343 ms, over every `{` (899 hits) 370 ms. So the receiving is cheap and the scan is the
cost, and one pass is the floor: the scanner searches the answer once, for a byte that is rare in it, and
looks closer only at its hits. With that, 100 results cost about 1.5 s + 0.5 s, as an ordinary request:
`page_size` stays 100.

Not measured: how search pages when results move during paging (the cursor is an id, which suggests
keyset paging). Either way a moved page was edited, and the recent check reads it.

## What is kept

One record in `localStorage`, `roots1`, separate from the saved place:

```
{ owner,                       // tokenTag: another token starts from nothing
  roots: [{ id, kind, title }],// pages and databases, a few to a few dozen
  sweep: { cursor, round },    // where the full pass stopped; null when it is done
  doneAt,                      // when the last full pass ended
  seen }                       // newest last_edited_time the recent check has read
```

No tree, no parents, no rows: a page whose parent is not the workspace is passed over the moment its
parent is read. Ancestors looked up for the quick first fill (below) live in memory for one read. The
record is written only when it changed, and only when the user is idle (as the saved place is), at most
once per sweep request.

## How the top level is found and kept

Four readers fill and correct one list. All of them go through the one request queue.

1. **Sweep** (complete, slow, once). Search pages with `filter_properties=title`, `page_size` 100, from
   the saved cursor. The answer is read as a stream (`stream.ts` style) and searched once, for `w`: a hit
   that is the `w` of `"type":"workspace"` after `"parent":{` is a top-level result. Its id is found by
   searching back from the hit for `"object":"page","id":"` (in this chunk or the one before, kept for that),
   its title by searching forward for `"plain_text":"`; only that title is decoded. Nothing else is decoded or
   kept. The cursor is saved after each answer, so a restart goes on where it stopped. Data sources are
   searched the same way (`database_parent` workspace), usually one answer. When the cursor runs out the
   pass is done; a new pass starts after a day, from the start, to catch what paging may have missed.
2. **Recent check** (new, renamed, restored). Search newest first, `page_size` 10, until a result is older
   than `seen` minus a minute. A workspace-parented page is added or renamed; a trashed one dropped.
   Usually one small answer.
3. **Trash check**. Search `{"in_trash": true}`, newest first, `page_size` 10: any of them in the list
   goes.
4. **Root check** (moved away, deleted for good, unshared). `GET /pages/{id}` (or `/databases/{id}`) for
   one root at a time, round robin: parent no longer the workspace, `in_trash`, 404 or 403 drop it. Also
   when a root is opened and answers 404.

First fill, before the sweep has got far: for the pages of the first recent answer whose parent is not
the workspace, walk up by `GET /pages/{id}`, `/blocks/{id}`, `/databases/{id}` until the workspace, at most
N lookups a read, most shared parents first. The top-level pages people work in show within seconds; the
sweep finds the rest. Built only if step 0 shows the sweep is slow to reach them.

An internal connection (`users/me`) also counts a page as top level when its parent answers 404 or 403.
In the sweep such candidates are pages whose parent was not seen: for an internal connection the sweep
keeps the ids seen as 32-bit hashes in a `Uint32Array` (4 bytes a page) and checks candidates' parents at
the end; for a personal token, which sees everything, it does not.

## How often

The person has the app open because they are working in Notion: changes should show within seconds, and
the bar must still answer the wheel at once. One request on the wire at a time, no abort: whatever starts
blocks the next for its whole length, so the order of what starts is the design.

| Priority | What | When |
|---|---|---|
| 1 | Ticks and status writes | at once |
| 2 | The view on screen | every 5 s, 3 times its read time for a slow view (as now) |
| 3 | Top level, when it is on screen | recent check every 5 s; trash check and one root check every third cycle |
| 4 | Sweep | only when the user has been idle 2 s and nothing above is due |

With the top level on screen: a new page or a rename shows in about 5 s plus Notion's search lag; a trashed
one in about 15 s; one moved away within the number of roots x 15 s, about a minute for four. Away from
the top level nothing about it is read, except the sweep while idle; coming back to it runs a recent
check first.

## Cost

| | 929 pages | 10 000 pages |
|---|---|---|
| Sweep, once | 10 answers of 95 KB | 100 answers, 9.5 MB |
| Sweep on the bar | 10 x about 2 s, 20 s | 100 x about 2 s, under 4 minutes of idle time |
| Top level on screen | 1 small request per 5 s, 2 more per 15 s | the same |
| Memory | one chunk (a few KB) and the list | the same; 40 KB of hashes for an internal connection |

## Edge cases

- Token changed: the record's owner differs, everything starts over.
- Start page set: the top level is not shown; no sweep.
- A top-level page created and edited within the same minute as `seen`: the one-minute overlap reads it again.
- Results shift while the sweep pages through them: a page may be read twice (the list is keyed by id) or missed;
  the daily new pass catches it.
- A cursor Notion no longer accepts (400): the pass starts over.
- A title with escapes (`\"`, `\\`, `\uXXXX`) or emoji only: `decode()` and `printable()`, "Untitled".
- A result split across chunks: the scanner keeps the tail of a chunk from the last `"object":"page"`.
- A key order other than id before parent: the result is skipped and the mismatch reported once; the
  recent check and the root check still work.
- 429: the queue waits Retry-After, the sweep backs off longest.
- Teamspace pages: top level as the API says; the sidebar's grouping and order are not in the API, titles sort.
- The bar restarts mid-sweep: the saved cursor.

## Results on the bar

22.11, a test bar, 1.4.1, a test workspace (929 pages, 111 data sources), the top level on screen
from the start, the app's storage cleared:

- the first pass, 12 answers: 44 s, logged as `sweep pass done in 44 s, 4 top-level`; all three
  top-level pages and People found, none of which the old first-100 read had in full;
- while a pass runs, the top level is checked every third read (every 15 s) and only for the last edited:
  with checks every 5 s the same pass took about two minutes;
- a top-level page renamed in Notion showed renamed on the bar 7.5-10 s later (a read every 5 s plus
  Notion's search lag);
- no heap error or exception in the log over the passes.

Not tried on the bar: a top-level page created, trashed or moved (that would change the person's real
sidebar); those paths are covered by `test/roots.test.ts`. The wheel's step time during a sweep was not
measured.

## Work

0. Done 22.11. Measure on the bar from inside the app (`console.error` with `Date.now()`, `log error`): head and body
   time and scan cost of a 100- and a 50-result search; settle `page_size`. Check restore-from-trash and
   paging on the API.
1. A request queue with priorities in `notion.ts`, replacing first come, first served; tests.
2. The search scanner over a byte stream, with chunk boundaries, escapes and the key-order guard; tests
   against answers built like the real ones (synthetic titles: the repo is public).
3. The roots record and the four readers in a module of their own; the scheduling in `main.ts`; tests with
   a fake clock and a fake Notion.
4. On the bar: the test workspace (929 pages) finds all three top-level pages and People; a page created,
   renamed, trashed and moved in the test area shows within the times above; the wheel stays at its usual
   step time while the sweep runs; no heap error in `log error` over a full pass.
