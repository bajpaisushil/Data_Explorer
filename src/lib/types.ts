/**
 * DataForge shared domain types.
 *
 * Everything here is structured-clone safe so it can cross the worker boundary.
 * TypedArrays are used wherever a value is per-row, so a 1M-row column is one
 * contiguous buffer rather than a million boxed JS values.
 */

/* ------------------------------------------------------------------ schema */

export type ColumnKind = 'int' | 'float' | 'bool' | 'date' | 'string'

/** How a string column is physically stored. */
export type StringEncoding =
  /** Low cardinality: Int32Array of codes into a shared dictionary. */
  | 'dict'
  /** High cardinality: UTF-8 bytes in one buffer + Uint32Array offsets. */
  | 'blob'

export interface ColumnMeta {
  /** Stable identifier, unique within a dataset. */
  id: string
  /** Header text as it appeared in the source. */
  name: string
  /** Position in the source file. */
  index: number
  kind: ColumnKind
  /** Present only when `kind === 'string'`. */
  encoding?: StringEncoding
  nullCount: number
  /** Exact for dict-encoded and boolean columns, -1 when not computed. */
  distinctCount: number
  /** Approximate bytes of column memory. */
  byteSize: number
  /** Detected date format hint, for display only. */
  dateFormat?: string
}

export interface DatasetMeta {
  id: string
  name: string
  rowCount: number
  /** Bytes held in column memory. */
  byteSize: number
  /** Size of the original file. */
  sourceBytes: number
  createdAt: number
  columns: ColumnMeta[]
  /** Rows the parser could not align to the header, if any. */
  badRows: number
  delimiter: string
}

/* ------------------------------------------------------- column storage */

export interface QuantitativeColumn {
  kind: 'int' | 'float' | 'date'
  /** NaN encodes null. Dates are epoch milliseconds. */
  values: Float64Array
}

export interface BoolColumn {
  kind: 'bool'
  /** 0 = false, 1 = true, 2 = null. */
  values: Uint8Array
}

export interface DictColumn {
  kind: 'string'
  encoding: 'dict'
  /** Index into `dictionary`; -1 encodes null. */
  codes: Int32Array
  dictionary: string[]
}

export interface BlobColumn {
  kind: 'string'
  encoding: 'blob'
  /** Concatenated UTF-8 bytes of every non-null value. */
  bytes: Uint8Array
  /** Length rowCount + 1. Value i spans [offsets[i], offsets[i + 1]). */
  offsets: Uint32Array
  /** Bitmap, 1 bit per row, bit set = null. Length ceil(rowCount / 8). */
  nulls: Uint8Array
}

export type ColumnData = QuantitativeColumn | BoolColumn | DictColumn | BlobColumn

/* -------------------------------------------------------------- querying */

export type QuantitativeOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'isNull' | 'notNull'

export type StringOp =
  | 'contains' | 'notContains' | 'eq' | 'ne' | 'startsWith' | 'endsWith'
  | 'in' | 'notIn' | 'regex' | 'isEmpty' | 'isNull' | 'notNull'

export type BoolOp = 'isTrue' | 'isFalse' | 'isNull' | 'notNull'

export type FilterOp = QuantitativeOp | StringOp | BoolOp

export interface Filter {
  id: string
  columnId: string
  op: FilterOp
  /** Scalar operand. Dates arrive as epoch ms. */
  value?: string | number | null
  /** Upper bound for `between`. */
  value2?: string | number | null
  /** Operand set for `in` / `notIn`. */
  values?: string[]
  caseSensitive?: boolean
  enabled: boolean
}

export interface SearchSpec {
  term: string
  /** null searches every column. */
  columnIds: string[] | null
  caseSensitive: boolean
}

export interface SortSpec {
  columnId: string
  dir: 'asc' | 'desc'
}

export type AggFn =
  | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'distinct' | 'nulls'

export interface AggSpec {
  id: string
  columnId: string
  fn: AggFn
}

export interface GroupSpec {
  columnIds: string[]
  aggs: AggSpec[]
}

export interface QuerySpec {
  filters: Filter[]
  search: SearchSpec | null
  sorts: SortSpec[]
  group: GroupSpec | null
}

export const EMPTY_QUERY: QuerySpec = {
  filters: [],
  search: null,
  sorts: [],
  group: null,
}

/* --------------------------------------------------------------- results */

export type CellValue = number | string | boolean | null

export interface QueryResult {
  /** Rows surviving filters + search. */
  matched: number
  /** Rows in the dataset. */
  total: number
  /** Distinct group keys, or null when not grouping. */
  groupCount: number | null
  elapsedMs: number
}

/** A materialised slice of the current result set, column-major. */
export interface RowWindow {
  offset: number
  /** Source row index of each returned row. */
  rowIds: Uint32Array
  columnIds: string[]
  /** `columns[c][r]` — parallel to `columnIds`, each of length `rowIds.length`. */
  columns: CellValue[][]
}

export interface GroupRow {
  /** Parallel to `GroupSpec.columnIds`. */
  keys: CellValue[]
  count: number
  /** Parallel to `GroupSpec.aggs`. null when undefined for the group. */
  aggs: (number | null)[]
}

export interface GroupWindow {
  offset: number
  rows: GroupRow[]
  columnIds: string[]
  aggIds: string[]
}

/* ------------------------------------------------------------- profiling */

export interface HistogramBin {
  start: number
  end: number
  count: number
}

export interface ValueCount {
  value: string | null
  count: number
}

export interface QuantitativeStats {
  kind: 'numeric' | 'date'
  count: number
  nulls: number
  distinct: number
  min: number
  max: number
  mean: number
  median: number
  p25: number
  p75: number
  p95: number
  stdev: number
  sum: number
  histogram: HistogramBin[]
  /** Values falling outside 1.5 * IQR. */
  outlierCount: number
}

export interface CategoricalStats {
  kind: 'categorical'
  count: number
  nulls: number
  distinct: number
  top: ValueCount[]
  minLength: number
  maxLength: number
  avgLength: number
  emptyCount: number
}

export interface BoolStats {
  kind: 'bool'
  count: number
  nulls: number
  trueCount: number
  falseCount: number
}

export type ColumnStats = QuantitativeStats | CategoricalStats | BoolStats

export interface ColumnProfile {
  columnId: string
  stats: ColumnStats
  /** 0-1, share of rows that are non-null. */
  completeness: number
  /** Cheap sparkline: bin counts for quantitative, top-N counts otherwise. */
  spark: number[]
}

/* ---------------------------------------------------------------- charts */

export type ChartType = 'bar' | 'histogram' | 'line' | 'scatter' | 'pie'

export interface ChartSpec {
  id: string
  title: string
  type: ChartType
  /** Category or x-axis column. */
  xColumnId: string
  /** Measure column. null means "count of rows". */
  yColumnId: string | null
  agg: AggFn
  /** Histogram bin count. */
  bins: number
  /** Top-N categories for bar/pie. */
  limit: number
  /** Optional series split for line/bar. */
  seriesColumnId?: string | null
}

export interface ChartSeries {
  name: string
  y: Float64Array
}

export interface ChartData {
  type: ChartType
  /** Categorical axis labels, when the x axis is discrete. */
  xLabels: string[] | null
  /** Quantitative x positions (bin starts, line x, scatter x). */
  x: Float64Array | null
  /** Bin ends, for histograms. */
  xEnd: Float64Array | null
  series: ChartSeries[]
  xLabel: string
  yLabel: string
  /** x axis renders as dates. */
  xIsDate: boolean
  /** True when categories were cut to `limit`. */
  truncated: boolean
  totalCategories: number
  /** Rows contributing to the chart. */
  sampled: number
}

/* ----------------------------------------------------------- view state */

export interface ColumnViewState {
  columnId: string
  width: number
  hidden: boolean
  pinned: boolean
}

export interface SavedView {
  id: string
  datasetId: string
  name: string
  createdAt: number
  query: QuerySpec
  columnOrder: string[]
  columnState: Record<string, ColumnViewState>
  charts: ChartSpec[]
}

/* ------------------------------------------------------------ utilities */

export const NULL_CODE = -1
export const BOOL_FALSE = 0
export const BOOL_TRUE = 1
export const BOOL_NULL = 2

export function isQuantitative(kind: ColumnKind): kind is 'int' | 'float' | 'date' {
  return kind === 'int' || kind === 'float' || kind === 'date'
}

export function isStringColumn(col: ColumnData): col is DictColumn | BlobColumn {
  return col.kind === 'string'
}
