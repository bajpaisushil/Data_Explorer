# DataForge

A million-row data explorer that runs entirely in your browser.

Drop in a CSV or JSON file and you get a real analysis environment — sorting, filtering,
grouping, search, charts, column statistics and saved views — over datasets large enough that
a spreadsheet would give up. There is no server, no upload and no account.

**The dataset never leaves your machine.** Everything below happens between the File API and
your own tab's memory.

```
 file  →  streaming byte parser  →  columnar typed arrays  →  query engine  →  virtualized grid
          (Web Worker)              (Float64 / Int32 / blob)   (Web Worker)     (~50 live rows)
                                            ↓
                                        IndexedDB
```

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm run build      # static export to ./out — any file host will serve it
npm test           # engine unit tests
npm run typecheck
```

No file handy? The landing screen generates realistic 10k–2M-row datasets (e-commerce orders,
IoT sensor readings, web events) with correlations, seasonality, skew, nulls and outliers, so
every feature has something meaningful to show.

## How it works

### Columns, not rows

A million-row CSV parsed the obvious way becomes a million JavaScript objects and tens of
millions of boxed values. DataForge stores each column as one contiguous typed array instead:

| Column kind | Storage | Null encoding |
|---|---|---|
| `int` / `float` / `date` | `Float64Array` (dates are epoch ms) | `NaN` |
| `bool` | `Uint8Array` | `2` |
| `string`, low cardinality | `Int32Array` of codes + a shared dictionary | code `-1` |
| `string`, high cardinality | one UTF-8 `Uint8Array` + `Uint32Array` offsets | null bitmap |

The dictionary case is what makes filtering fast. A predicate on a country column resolves
**once** against the dictionary into a small mask, after which testing a row is a single array
lookup — not a string comparison per row. The blob encoding covers the opposite case (order
ids, session ids), where a dictionary would just be a million strings with extra steps.

The **Memory** panel reports what this actually bought, column by column, against what the same
data would cost as plain JS values.

### Parsing

A byte-level state machine over the raw `Uint8Array`, not a split-on-comma. It handles RFC-4180
quoting, escaped quotes, delimiters and newlines inside quoted fields, CRLF/LF/CR, BOMs and
ragged rows; it sniffs the delimiter by row-to-row field-count consistency rather than raw
character frequency.

It runs in two streaming passes: the first counts rows and gathers type evidence and
cardinality, the second allocates exactly-sized arrays and fills them. Type inference resolves
bool → int → float → date → string, disambiguates `DD/MM` from `MM/DD` by scanning for a day
value above 12, and is deliberately conservative — a plain `0`/`1` column stays an integer
unless its name says otherwise.

### Everything heavy is off the main thread

One worker owns all column memory for the loaded dataset. The UI thread never holds more than a
screenful of values; it asks for windows. Requests are a promise-per-message RPC with progress
events and cancellation, and the query pipeline is staged so that changing a sort does not
redo the filter pass:

```
filters + search  →  Uint32Array selection  →  sort  →  group  →  materialise window
     cached by key            cached by key                         (~200 rows)
```

Filtering writes into a single pre-sized `Uint32Array` and slices it — no intermediate arrays,
no per-row allocation. Sorting reorders row ids, never the data, and for dictionary columns it
sorts by a precomputed code→rank table so the comparator is comparing integers.

### Virtualization

The grid renders roughly fifty rows no matter how many exist, and virtualizes columns too —
a 200-column CSV only mounts what is on screen.

A million rows at 28px is 28 million pixels of scroll height, which is past the element-height
ceiling in several browser engines. The grid handles that explicitly rather than hoping; the
strategy is documented at the top of `src/components/grid/DataGrid.tsx`.

### Charts

Canvas-rendered, drawn from aggregates the worker computes over the **current filtered rows**,
so a chart always describes what you are actually looking at. Clicking a bar or slice adds the
corresponding filter.

The categorical palette is fixed-order and validated: every adjacent pair clears colour-vision
and normal-vision separation floors against both the light and dark surfaces, and slots are
never cycled — a ninth category folds into a neutral "Other" rather than inventing a hue.

### Persistence

Datasets and saved views go to IndexedDB, one record per column so a large dataset saves
incrementally and can report progress. Saved views capture filters, sorts, column layout and
charts together. Private browsing degrades gracefully instead of throwing.

## Project layout

```
src/
  lib/
    types.ts            shared domain types and the column storage contract
    format.ts           display formatting (memoised Intl, UTC-stable dates)
    sample.ts           deterministic demo dataset generator
    engine/
      protocol.ts       worker RPC contract
      parse.ts          streaming CSV/TSV/JSON parser + type inference
      query.ts          filter, search, sort, group, materialise, CSV export
      stats.ts          profiling, summary statistics, chart aggregation
      worker.ts         the worker — owns all column memory
      client.ts         promise-per-request client with progress + cancellation
    persist/db.ts       IndexedDB datasets and saved views
    state/store.ts      application state
  components/
    grid/               virtualized grid
    charts/             canvas charts and sparklines
    ...                 filter bar, panels, chrome
```

## Stack

Next.js 16 (App Router, static export) · React 19 · TypeScript · Tailwind v4 · Zustand.
No charting library, no grid library, no CSV library — those are the parts worth building here.

## Limits worth knowing

- Everything is bounded by tab memory. Very large files are read fully before parsing.
- `scatter` plots sample down to 20,000 points; wide category sets fold into "Other".
- Saved data lives in *this* browser profile, and a browser may evict it under storage pressure.
