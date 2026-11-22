# Reading people's databases

Design for how the app reads a Notion database and shows its rows. Status: built (22.11.2026), not yet
tried on a bar: classification, two-line rows, pointing and choosing, opening rows and to-do links, the
view's sorts. Not built: the manual order of a view without sorts, read-only formula and rollup
statuses, a relation to a statuses database. The screens were drawn in Figma before they were built (22.11); the variant chosen is described below.

## Principle

Show a database the way the person sees it in Notion: their order, their status names and colours, a
checkbox only where Notion shows one. The app does not invent a task model on top of theirs.

## What the app does now

- `readSchema` (`src/tasks.ts`) accepts a database only if it finds a done field: a Checkbox (a done-like
  name first), else a Status (done = the options of the group whose name looks like Complete), else a
  Select with a done-like option. Anything else is `NoDoneFieldError`.
- Every row is drawn with a checkbox; OK toggles done and back.
- Rows are sorted by the first date property, then `created_time`; open rows first (`openFirst`).
- Filter: the "Show" setting, today and overdue and undated, or all open; done rows edited today stay.

## Sources

All requests use the existing one-request-on-the-wire queue (`src/notion.ts`).

| What | Request | When |
|---|---|---|
| Schema | `GET /v1/data_sources/{id}` | once per data source, cached |
| Views | `GET /v1/views?database_id={id}`, then `GET /v1/views/{view}` for the chosen one | once per database, cached |
| Rows | `POST /v1/data_sources/{id}/query` with our filter and the view's sorts, `filter_properties` | every refresh |
| Manual order | `POST /v1/views/{view}/queries` (ids only) | every refresh, only if the view has no sorts |

The Views API is in the changelog of 19.03.2026 (developers.notion.com/page/changelog). A view carries
`sorts`, `filter`, `configuration.properties[].status_show_as` (`select` or `checkbox`),
`configuration.group_by`, and `configuration.subtasks.property_id`. The app sends
`Notion-Version: 2026-03-11`; whether that version is enough for `/v1/views` is to be checked.

## Classifying a schema

A pure function over the data source (and the view, if read) returns:

```
Shape {
  title: property id
  state: {
    kind: status | checkbox | select | multi_select | formula | rollup | relation | none
    writable: boolean
    options: [{ name, color, group: todo | progress | done }]   // schema order
    closeTo, openTo: option names (writable kinds)
    asCheckbox: boolean                                           // how the row is drawn
  }
  date: property id or null
  parent: property id or null                                     // sub-items relation
}
```

Candidates for `state`, strongest first:

1. The property the view shows with `status_show_as: checkbox`, or the one it groups by.
2. Visible in the view before hidden.
3. By type: status; checkbox with a done-like name; select with a done-like option; formula (boolean or
   string); rollup of statuses; relation to a statuses database; any checkbox.
4. Then by name (status, state, статус, done, готово), then schema order.

Groups of a Status come from `groups` by position: first To-do, second In progress, third Complete. Old
databases may store translated group names, so the name test in `readSchema` goes. A Select has no
groups: the done-like option is `done`, the first option `todo`, the rest `progress` (a guess, stated as
one).

Read-only kinds (formula, rollup) show the status but OK does nothing. A relation to a statuses database
is left for later: it needs a second data source and access to it.

`none`: the database is shown read-only (title and date, no mark), instead of the current refusal.

## Drawing a row

A row with a Status or a Select takes the whole 72x16 screen in two lines: the title above, the status as a
Notion-like tag below. A status in the same line
as the title leaves 5 to 7 letters of the title, and a colour alone means nothing to someone who does not
know the code (22.11).

| Source | Mark | Lines |
|---|---|---|
| to-do block on a page | checkbox | one |
| Checkbox property | checkbox | one |
| Status shown as checkbox in the view (`asCheckbox`) | checkbox, ticked in the Complete group | one |
| Status or Select otherwise | tag with the option's name and colour | two |
| read-only kinds | tag, never focused for editing | two |
| none | nothing | one |

Notion's ten colour names map to fixed bar colours. A chevron at the right of the title, the mark pages
already have, says the title opens.

## Title and status: what OK does

The bar gives an app the wheel, OK, Start and Back (`documentation/JavaScript Applications.dox.md`,
appendix 3). There are no left and right keys; OK and Start also have a long press, Back has none.

A row has up to two targets: the title, if it opens something, and the mark (checkbox or status).

- One target: OK acts at once. A to-do without a link ticks.
- Two targets: OK (or Start) enters hover. Everything but the hovered part dims to 40%. The wheel moves
  between the title (above) and the status (below); with a one-line to-do, between the checkbox and the
  title. OK on the title opens it, with a small arrow at its left; OK on the mark acts on it. Back leaves
  hover.
- Choosing a status happens in place: arrows appear on both sides of the tag, the wheel goes through the
  options in schema order, OK writes `{status: {name}}` (or `{select: {name}}`), Back puts the old one
  back without writing.

What makes a title open:

- A to-do on a page: its text mentions a Notion page, `<mention url="https://...">` in the markdown, or
  links one, `[text](https://app.notion.com/...)`. A link elsewhere on the web does not count: the bar has
  no browser. Nested to-dos are already shown as lines under it.
- A database row: always. Every row is a page and may hold blocks (`query-a-data-source`: "Gets a list of
  pages"), and the page object has no field that says whether it has any (fields: `id`, `created_time`,
  `last_edited_time`, `in_trash`, `icon`, `cover`, `properties`, `parent`, `url`, and a few more; no
  `has_children`). Finding out takes a request per row, `GET /v1/blocks/{id}/children?page_size=1`, about
  1.5 s over HTTPS on the bar. The app does not ask: nothing under a row is read until the user opens it
  (22.11: loading while the user rests on a row would be unreliable and irritating).

So a database row always shows the chevron and always has two targets: OK enters hover, the status is one
wheel step away. An opened row reads as a page does now (`readPage`); an empty one says so.

## Order

1. The view: the first one `GET /v1/views` returns, unless a setting names another. Whether the first
   returned is the first tab in Notion is to be checked.
2. The view has `sorts`: pass them to the rows query instead of ours. One request per refresh, as now.
3. `sorts` is null (manual order): ask the view query for ids (about 60 bytes a row) and place the rows by
   them; rows it lacks go last by `created_time`. Two requests per refresh, about 3 s on the bar over
   HTTPS, so a manual-order view refreshes less often. That the view query returns the drag order is to
   be checked.
4. No views or an error: the current order.

The view's own filter is not applied: it can use `"me"`, which finds nothing with an internal token, and it
can exceed the two levels of nesting our filter adds. The "Show" setting stays the app's filter. "Open"
means not in the done group, tested with `group_does_not_equal` (header
`Notion-Beta: status-group-filters-2026-10-06`) instead of one `does_not_equal` per option.

## Cost on the bar

- One more request per database opened for the first time (views), cached after; schema as now.
- Rows: the same one request, plus one for manual-order views.
- Memory: options and colours per database, a few hundred bytes; the cache is bounded as the others.

## To check on a bar before building

- `/v1/views` with `Notion-Version: 2026-03-11`.
- The view query returns the manual order when `sorts` is null.
- The first view returned is the first tab.
- A linked database on a page resolves to its source through `data-source-url` or `views?database_id`.
- How many ids `filter_properties` takes.
