# cmd-mod-summary

A Command Code mod that answers the question the CLI never answers: **which models
consumed how many tokens, across every session?**

Every model response carries its own usage block. This mod reads it off each request,
folds it into a SQLite row keyed by `(session id, model)`, and reports the totals through
`/summary`.

## Features

- Records `input`, `output`, `cache read` and `cache write` tokens for every model request.
- Persists to SQLite — the totals survive restarts and accumulate across sessions.
- One row per session **and** model, so a session that switched models is reported per model.
- `/summary` ranks models by total usage across all sessions (top 5 by default).
- Filters by model name (fuzzy), by date range, and by how many models to display.
- Sizes the table to the terminal, so long model names stay whole and rows never wrap.
- Drops the `CACHE-W` column entirely when no provider reported a cache write.
- `/summary clear` deletes what a filter selects, after showing it and asking to confirm.
- Prints its own options below every report, so the syntax is discoverable.
- No build step, no dependencies — it uses Node's built-in `node:sqlite`.

## Installation

```sh
cmd mods add git:https://github.com/ltt1987/cmd-mod-summary -g
```

Then confirm Command Code sees it:

```sh
cmd mods list
```

Start a new session (or run `/reload` inside one). The mod only records from the moment
it is loaded, so history before installation stays out of the database.

To try it without installing:

```sh
cmd --mod ./src/index.ts
```

## Usage

```
/summary
```

```text
⛁ cmd summary  top 4 · all time · all models
  MODEL                      INPUT OUTPUT CACHE-R CACHE-W TOTAL SESS
  ──────────────────────────────────────────────────────────────────
  anthropic/claude-fable-5   4.81M  96.3k   3.40M    512k 4.91M    1
  deepseek/deepseek-v4-flash 1.20M  18.4k    900k       0 1.22M    1
  poolside/laguna-s-2.1-free  268k  5.12k    140k   12.0k  274k    1
  openai/gpt-5-mini          41.0k    819       0       0 41.8k    1
  ──────────────────────────────────────────────────────────────────
  ALL                        6.33M   121k   4.44M    524k 6.45M    4
  4 models · 4 sessions · 4 rows · 12 requests
  first recorded 2026-09-19 19:08 · last used 2026-09-19 19:08
  TOTAL = input + output · cache is inside input · units k/M/B/T
  usage: /summary [model=<pattern>] [days=<n>] [top=<n>]
         [since=<YYYY-MM-DD>] [until=<YYYY-MM-DD>]
         a bare word matches the model · default is top 5
         /summary clear <filters> · clear all · asks to confirm
```

`ALL` sums every matching model, not only the displayed rows. The options block under the
table is part of every report, so `/summary` teaches itself.

The layout follows the terminal width: on a wide window a `LAST` column joins the table and
model names print in full; on an 80-column window `LAST` goes first, then `SESS`, and only
then do names clip — the token columns, which are the point of the report, always stay.

`CACHE-W` appears only when at least one model actually reported a cache write. Most
providers never do, and an all-zero column just takes room away from the model name. The
decision is made over everything the query matched, not over the rows on screen, so a
model hidden below `top=` still keeps its column alive.

### Options

| Option | Meaning |
| --- | --- |
| `model=<pattern>` | Keep models whose name contains `<pattern>`; a bare argument is read as the pattern |
| `since=<YYYY-MM-DD>` | Inclusive start date, in local time |
| `until=<YYYY-MM-DD>` | Inclusive end date, in local time |
| `days=<n>` | Shorthand for "the last n days" |
| `top=<n>` | Models to display (default 5, max 50) |

```
/summary model=claude
/summary claude-opus top=3
/summary since=2026-09-01 until=2026-09-07
/summary days=7 model=gpt
```

### Clearing data

`clear` takes the same filters as a query, so it deletes exactly what you could see:

```
/summary clear all
/summary clear model=deepseek
/summary clear days=1
```

A filtered `clear` prints the matching report first — the rows about to go, unpaginated —
and then asks:

```text
Delete the usage above?
1 row · 1 model · 1 session in ~/.commandcode/cmd-mod-summary/usage.db — this cannot
be undone.
❯ 1. Yes
  2. No
```

`/summary clear all` skips the listing and asks the same question about the whole store.
Nothing is removed until you answer `Yes`; `No` cancels and says so. An empty selection is
reported as such without a prompt, and `clear` on its own — with neither `all` nor a filter
— is refused, because guessing which rows you meant is not a safe default. Neither is
`clear all` combined with a filter.

The delete is physical: no archive, no undo. Deleting the **current** session's rows is
fine, but the next request from that session starts its row over, so its `created_at` and
`requests` restart from that moment. Uninstalling the mod leaves the database alone;
`/summary clear all` is the way to empty it.

In a non-interactive run (`cmd -p`) the preview prints as plain text and the delete is
refused, since there is nobody to confirm it.

## Reading the numbers

Providers report `inputTokens` as the **whole** prompt, with `cacheReadTokens` and
`cacheWriteTokens` as subsets of it. So:

- The ranking column `TOTAL` is `input + output`. Adding the cache columns to it as well
  would count the cached prefix twice.
- `INPUT` already includes everything in `CACHE-R` and `CACHE-W`.
- The uncached portion of a prompt is `input − cache read − cache write`.
- `LAST` (wide terminals only) is the timestamp of that model's most recent request in any
  session, not the session's start.

Counts are human-scaled by powers of 1000, keeping three significant digits: `742`,
`1.00k`, `10.0k`, `1.20M`, `6.45M`, `2.00B`, `1.23T`. The scale keeps climbing — a total
past a trillion prints as `1000T` rather than rolling over, because token counts that large
are still better read as one number than as a unit nobody uses.

Rows are cumulative. A time window selects rows whose **last activity** falls in range
and reports their whole total, so a session that straddles two days appears with all of
its tokens; `/summary` says so in that case instead of implying day-exact figures.

## Data

The database defaults to:

```text
~/.commandcode/cmd-mod-summary/usage.db
```

Set `CMD_SUMMARY_DB` to move it (handy for pointing a test run at a scratch file).
It is plain SQLite in WAL mode, so any tool can read it:

```sh
sqlite3 ~/.commandcode/cmd-mod-summary/usage.db \
  'SELECT model, SUM(input_tokens), SUM(output_tokens) FROM token_usage GROUP BY model'
```

### `token_usage`

| Column | Notes |
| --- | --- |
| `session_id` | Command Code session id, primary key part |
| `model` | Model name, primary key part |
| `input_tokens` | Full prompt tokens, cache included |
| `output_tokens` | Generated tokens |
| `cache_read_tokens` | Subset of `input_tokens` |
| `cache_write_tokens` | Subset of `input_tokens` |
| `requests` | Model calls folded into this row |
| `created_at` | First request of this session on this model |
| `updated_at` | Most recent request of this session on this model |

`created_at` and `updated_at` are ISO-8601 UTC. Concurrent sessions are safe: writes are
single-statement upserts and the store waits up to two seconds on a locked database.

## Project Structure

```text
src/index.ts   Mod entry point: event wiring, /summary and /summary clear, feed renderer
src/db.ts      SQLite store: schema, upsert accumulation, aggregate queries, filtered delete
package.json   Package metadata and mod registration (`commandcode.mods`)
```

## Limits

- Usage recorded before the mod was installed cannot be recovered — it is read from live
  model responses, not replayed from transcripts.
- If the same file is loaded twice in one session (a global install plus `--mod`), each
  registration records, and the usage lands twice.
