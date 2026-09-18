/**
 * Built-in demo datasets. Most people trying this app will not have a
 * million-row CSV handy, so this is what actually demonstrates the product —
 * which means the data has to be *interesting*: correlations, seasonality,
 * skew, nulls and outliers, so sorting and grouping and charting all show
 * something real.
 *
 * Fully deterministic (seeded PRNG, never Math.random) and written straight
 * into a growing byte buffer, because concatenating a 120MB JS string is
 * exactly the mistake this whole project exists to avoid.
 */

export interface SamplePreset {
  id: string
  name: string
  description: string
  columns: number
  suggestedRows: number
}

export const SAMPLE_PRESETS: SamplePreset[] = [
  {
    id: 'ecommerce',
    name: 'E-commerce orders',
    description:
      'Two years of orders with weekly seasonality, a Q4 spike, log-normal prices and returns that correlate with discounts.',
    columns: 15,
    suggestedRows: 1_000_000,
  },
  {
    id: 'iot_sensors',
    name: 'IoT sensor readings',
    description:
      'Per-second telemetry across sites and devices: daily temperature cycles, decaying batteries and rare spike outliers.',
    columns: 12,
    suggestedRows: 1_000_000,
  },
  {
    id: 'web_events',
    name: 'Web analytics events',
    description:
      'Clickstream sessions with anonymous users, a long-tail duration distribution and a rare, valuable conversion event.',
    columns: 14,
    suggestedRows: 1_000_000,
  },
]

/* ------------------------------------------------------------------- prng */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Box–Muller, reused for every log-normal and noise term. */
function makeNormal(rnd: () => number): () => number {
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = rnd() * 2 - 1
      v = rnd() * 2 - 1
      s = u * u + v * v
    } while (s === 0 || s >= 1)
    const f = Math.sqrt((-2 * Math.log(s)) / s)
    spare = v * f
    return u * f
  }
}

/* ------------------------------------------------------------ byte writer */

/**
 * Appends CSV text into a geometrically grown Uint8Array. Rows are built into
 * a small reused string and encoded with encodeInto, so no single allocation
 * ever approaches the size of the output.
 */
class CsvWriter {
  private buf: Uint8Array
  private len = 0
  private encoder = new TextEncoder()

  constructor(estimate: number) {
    this.buf = new Uint8Array(Math.max(1024, estimate))
  }

  private ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return
    let next = this.buf.length
    while (next < this.len + extra) next = Math.ceil(next * 1.6)
    const grown = new Uint8Array(next)
    grown.set(this.buf.subarray(0, this.len))
    this.buf = grown
  }

  write(s: string) {
    // Worst case for UTF-8 is 3 bytes per UTF-16 code unit for the BMP.
    this.ensure(s.length * 3)
    const { written } = this.encoder.encodeInto(s, this.buf.subarray(this.len))
    this.len += written
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

/** Quote only when the field actually needs it. */
function field(s: string): string {
  if (s.length === 0) return s
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 44 || c === 34 || c === 10 || c === 13) {
      return `"${s.replace(/"/g, '""')}"`
    }
  }
  return s
}

const DAY = 86_400_000

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function isoDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z'
}

function pick<T>(arr: readonly T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length]
}

/* ------------------------------------------------------------- generators */

const COUNTRIES = [
  'United States', 'Germany', 'India', 'Brazil', 'Japan', 'France',
  'United Kingdom', 'Canada', 'Australia', 'Mexico', 'Spain', 'Netherlands',
] as const

const CITIES: Record<string, readonly string[]> = {
  'United States': ['New York', 'Austin', 'Seattle', 'Chicago', 'Denver'],
  Germany: ['Berlin', 'Munich', 'Hamburg', 'Cologne'],
  India: ['Bengaluru', 'Mumbai', 'Delhi', 'Pune', 'Hyderabad'],
  Brazil: ['Sao Paulo', 'Rio de Janeiro', 'Belo Horizonte'],
  Japan: ['Tokyo', 'Osaka', 'Kyoto'],
  France: ['Paris', 'Lyon', 'Marseille'],
  'United Kingdom': ['London', 'Manchester', 'Bristol'],
  Canada: ['Toronto', 'Vancouver', 'Montreal'],
  Australia: ['Sydney', 'Melbourne', 'Brisbane'],
  Mexico: ['Mexico City', 'Guadalajara', 'Monterrey'],
  Spain: ['Madrid', 'Barcelona', 'Valencia'],
  Netherlands: ['Amsterdam', 'Rotterdam', 'Utrecht'],
}

/** Rough shipping distance proxy, so shipping_days correlates with country. */
const FAR: Record<string, number> = {
  'United States': 2, Germany: 3, India: 6, Brazil: 6, Japan: 6, France: 3,
  'United Kingdom': 3, Canada: 3, Australia: 8, Mexico: 4, Spain: 3, Netherlands: 3,
}

const CATEGORIES = ['Books', 'Electronics', 'Home', 'Toys', 'Apparel', 'Garden', 'Sports'] as const
const PAYMENTS = ['card', 'paypal', 'bank_transfer', 'gift_card', 'apple_pay'] as const

function generateEcommerce(rows: number, rnd: () => number, onProgress?: (r: number) => void): Uint8Array {
  const normal = makeNormal(rnd)
  const w = new CsvWriter(rows * 130 + 4096)
  w.write(
    'order_id,customer_id,order_date,country,city,category,product,unit_price,quantity,' +
      'discount_pct,revenue,payment_method,is_returned,rating,shipping_days\n',
  )

  const start = Date.UTC(2023, 0, 1)
  const step = Math.max(1, Math.floor(rows / 200))
  const customers = Math.max(1, Math.floor(rows / 8))

  for (let i = 0; i < rows; i++) {
    // Weekly seasonality plus a Q4 lift, expressed as a day offset bias.
    const dayIndex = Math.floor(rnd() * 730)
    const month = new Date(start + dayIndex * DAY).getUTCMonth()
    const q4Boost = month >= 9 ? 1 : 0
    // Re-roll a fraction of non-Q4 days towards Q4, producing the spike.
    const day = q4Boost === 0 && rnd() < 0.18 ? 273 + Math.floor(rnd() * 90) : dayIndex
    const ms = start + day * DAY

    const country = pick(COUNTRIES, rnd)
    const city = pick(CITIES[country], rnd)
    const category = pick(CATEGORIES, rnd)

    const price = Math.min(4000, Math.exp(2.6 + normal() * 0.85))
    const qty = 1 + Math.floor(-Math.log(1 - rnd()) * 1.4)
    const discount = rnd() < 0.62 ? 0 : Math.round(rnd() * 45)
    const revenue = price * qty * (1 - discount / 100)

    // Returns rise with discount depth and vary by category.
    const catRisk = category === 'Apparel' ? 0.11 : category === 'Electronics' ? 0.06 : 0.025
    const returned = rnd() < catRisk + discount / 400

    const ratingNull = rnd() < 0.08
    const rating = ratingNull ? '' : String(Math.min(5, Math.max(1, Math.round(4.3 + normal() * 0.9))))

    const ship = Math.max(1, Math.round(FAR[country] + Math.abs(normal()) * 2))

    w.write(
      `ord_${i.toString(36)},cus_${Math.floor(rnd() * customers).toString(36)},${isoDate(ms)},` +
        `${field(country)},${field(city)},${category},${field(`${category} item ${1 + Math.floor(rnd() * 500)}`)},` +
        `${price.toFixed(2)},${qty},${discount.toFixed(1)},${revenue.toFixed(2)},` +
        `${pick(PAYMENTS, rnd)},${returned},${rating},${ship}\n`,
    )

    if (onProgress && i % step === 0) onProgress(i / rows)
  }
  onProgress?.(1)
  return w.done()
}

const SITES = ['plant-north', 'plant-south', 'depot-east', 'depot-west', 'lab-1'] as const
const SENSOR_TYPES = ['thermal', 'humidity', 'pressure', 'vibration'] as const
const STATUSES = ['ok', 'ok', 'ok', 'ok', 'degraded', 'fault'] as const
const ERROR_CODES = ['E_TIMEOUT', 'E_CALIB', 'E_RANGE', 'E_LINK'] as const

function generateIot(rows: number, rnd: () => number, onProgress?: (r: number) => void): Uint8Array {
  const normal = makeNormal(rnd)
  const w = new CsvWriter(rows * 110 + 4096)
  w.write(
    'reading_id,device_id,timestamp,site,sensor_type,temperature_c,humidity_pct,' +
      'battery_pct,signal_dbm,status,error_code,uptime_hours\n',
  )

  const start = Date.UTC(2025, 3, 1)
  const devices = Math.max(8, Math.min(5000, Math.floor(rows / 200)))
  const step = Math.max(1, Math.floor(rows / 200))

  // Battery decays per device and resets on replacement.
  const battery = new Float64Array(devices)
  for (let d = 0; d < devices; d++) battery[d] = 60 + rnd() * 40

  for (let i = 0; i < rows; i++) {
    const device = i % devices
    const ms = start + i * 1000
    const hourOfDay = ((ms / 3_600_000) % 24) + 0

    battery[device] -= 0.0004
    if (battery[device] < 5) battery[device] = 100

    // Daily sine cycle, noise, and a rare spike outlier.
    const base = 18 + Math.sin((hourOfDay / 24) * Math.PI * 2) * 7
    const spike = rnd() < 0.0008 ? (rnd() < 0.5 ? -28 : 34) : 0
    const temp = base + normal() * 1.4 + spike

    const status = pick(STATUSES, rnd)
    const hasError = status !== 'ok' && rnd() < 0.7
    const humidity = Math.max(0, Math.min(100, 46 + Math.sin(hourOfDay / 3) * 12 + normal() * 6))

    w.write(
      `rd_${i.toString(36)},dev_${device.toString(36).padStart(4, '0')},${isoDateTime(ms)},` +
        `${pick(SITES, rnd)},${pick(SENSOR_TYPES, rnd)},${temp.toFixed(1)},${humidity.toFixed(1)},` +
        `${battery[device].toFixed(1)},${Math.round(-40 - Math.abs(normal()) * 25)},${status},` +
        `${hasError ? pick(ERROR_CODES, rnd) : ''},${(i / 3600).toFixed(2)}\n`,
    )

    if (onProgress && i % step === 0) onProgress(i / rows)
  }
  onProgress?.(1)
  return w.done()
}

const EVENT_TYPES = ['page_view', 'page_view', 'page_view', 'click', 'scroll', 'search', 'add_to_cart', 'checkout'] as const
const PATHS = ['/', '/pricing', '/docs', '/blog', '/product', '/signup', '/about', '/changelog'] as const
const REFERRERS = ['google.com', 'news.ycombinator.com', 'twitter.com', 'reddit.com', 'linkedin.com', 'direct'] as const
const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge'] as const
const OSES = ['macOS', 'Windows', 'iOS', 'Android', 'Linux'] as const
const DEVICES = ['desktop', 'mobile', 'tablet'] as const

function generateWebEvents(rows: number, rnd: () => number, onProgress?: (r: number) => void): Uint8Array {
  const normal = makeNormal(rnd)
  const w = new CsvWriter(rows * 125 + 4096)
  w.write(
    'event_id,session_id,user_id,timestamp,event_type,page_path,referrer_domain,' +
      'browser,os,device_type,country,duration_ms,is_conversion,revenue\n',
  )

  const start = Date.UTC(2025, 5, 1)
  const sessions = Math.max(1, Math.floor(rows / 6))
  const step = Math.max(1, Math.floor(rows / 200))

  for (let i = 0; i < rows; i++) {
    const ms = start + Math.floor(rnd() * 90 * DAY)
    const converted = rnd() < 0.02
    const anonymous = rnd() < 0.12

    // Long-tailed dwell time.
    const duration = Math.round(Math.exp(6.4 + normal() * 1.15))

    w.write(
      `ev_${i.toString(36)},ses_${Math.floor(rnd() * sessions).toString(36)},` +
        `${anonymous ? '' : `usr_${Math.floor(rnd() * sessions * 0.4).toString(36)}`},` +
        `${isoDateTime(ms)},${converted ? 'checkout' : pick(EVENT_TYPES, rnd)},${pick(PATHS, rnd)},` +
        `${pick(REFERRERS, rnd)},${pick(BROWSERS, rnd)},${pick(OSES, rnd)},${pick(DEVICES, rnd)},` +
        `${field(pick(COUNTRIES, rnd))},${duration},${converted},` +
        `${converted ? (20 + Math.exp(3 + normal() * 0.7)).toFixed(2) : ''}\n`,
    )

    if (onProgress && i % step === 0) onProgress(i / rows)
  }
  onProgress?.(1)
  return w.done()
}

/* --------------------------------------------------------------- dispatch */

export function generateSampleCsv(
  presetId: string,
  rows: number,
  onProgress?: (ratio: number) => void,
): Uint8Array {
  const n = Math.max(1, Math.min(5_000_000, Math.floor(rows)))
  const rnd = mulberry32(seedOf(presetId))

  switch (presetId) {
    case 'iot_sensors':
      return generateIot(n, rnd, onProgress)
    case 'web_events':
      return generateWebEvents(n, rnd, onProgress)
    case 'ecommerce':
    default:
      return generateEcommerce(n, rnd, onProgress)
  }
}
