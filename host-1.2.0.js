/**
 * Host half of `dsh-continue-cost`.
 *
 * The client's arithmetic is local. This half adds optional network
 * capabilities: it fetches DeepSeek's public Chinese pricing Markdown and the
 * State Council holiday notices, then serves validated tables to the page at
 *
 *   GET /plugins/dsh-continue-cost/prices
 *   GET /plugins/dsh-continue-cost/holidays
 *
 * Only the public documentation URL is requested. No Session content, token
 * usage, credential, or API key is ever sent. If the fetch or parse fails, the
 * client keeps its built-in table. The route caches one successful result for
 * six hours so a page reload does not hammer the docs site.
 *
 * @module dsh-continue-cost
 */

/** Route prefix; the client fetches `${BASE_PATH}/prices`. */
export const BASE_PATH = '/plugins/dsh-continue-cost'

/** The Host service needed to mount the route. */
export const inject = ['webServer']

/** Official Chinese pricing page, Markdown form (CNY values). */
const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md'

/** Official State Council "latest documents" page used to discover a new notice. */
const HOLIDAY_INDEX_URL = 'https://www.gov.cn/pushinfo/v150203/index.htm?aisiteOutPageId=543406643'

/** Known official notices for years whose URL can be pinned. */
const KNOWN_HOLIDAY_NOTICES = {
  2026: 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm',
  2027: 'https://www.gov.cn/zhengce/content/202611/content_7085101.htm',
}

/** A successful holiday parse is reused by the Host for one day. */
const HOLIDAY_CACHE_MS = 24 * 60 * 60 * 1000

/** How long one successful fetch is reused by the Host. */
const CACHE_MS = 6 * 60 * 60 * 1000

/** Per-request upstream timeout. */
const REQUEST_TIMEOUT_MS = 10_000

/** The three model-price buckets. */
const BUCKETS = ['cacheHit', 'cacheMiss', 'output']

/**
 * Parse one price cell such as `0.02元` or `4.5元`.
 * @param text - table cell.
 * @returns the number, or undefined when the cell is not a price.
 */
function parsePrice(text) {
  const match = /(\d+(?:\.\d+)?)/u.exec(String(text).replace(/,/gu, ''))
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Parse the official Markdown table into the client's price shape.
 *
 * The table header names the model columns; each `价格` row names the bucket
 * (cache hit / cache miss / output) and the tariff (off-peak / peak), with the
 * model prices as the last N cells. Any missing or unreadable value throws so
 * the caller falls back to the built-in table instead of publishing a partial
 * table.
 *
 * @param markdown - the fetched `pricing.md` body.
 * @returns `{ modelId: { off: {...}, peak: {...} } }` with CNY per 1M tokens.
 */
export function parsePricing(markdown) {
  const source = String(markdown)
  // The Chinese page is billed in CNY. Refuse an English/USD fallback rather
  // than silently pricing yuan as dollars.
  if (!/元|¥/u.test(source)) throw new Error('pricing page is not in CNY')
  const lines = source.split(/\r?\n/u)
  const header = lines.find((line) => line.includes('|')
    && /deepseek-[a-z0-9-]+/iu.test(line)
    && /模型|model/iu.test(line))
  if (header === undefined) throw new Error('pricing header not found')
  const models = [...new Set([...header.matchAll(/deepseek-[a-z0-9-]+/giu)].map((match) => match[0].toLowerCase()))]
  if (models.length === 0) throw new Error('pricing model columns not found')

  const table = Object.fromEntries(models.map((model) => [model, { off: {}, peak: {} }]))
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < models.length + 2) continue
    const prefix = cells.slice(0, -models.length).join(' ')
    let bucket
    if (/缓存命中|CACHE HIT/iu.test(prefix)) bucket = 'cacheHit'
    else if (/缓存未命中|CACHE MISS/iu.test(prefix)) bucket = 'cacheMiss'
    else if (/输出|OUTPUT/iu.test(prefix)) bucket = 'output'
    else continue
    let tariff
    if (/空闲时段|OFF-PEAK/iu.test(prefix)) tariff = 'off'
    else if (/高峰时段/iu.test(prefix)) tariff = 'peak'
    else continue
    const values = cells.slice(-models.length).map(parsePrice)
    if (values.some((value) => value === undefined)) {
      throw new Error(`unreadable pricing row: ${line}`)
    }
    models.forEach((model, index) => {
      table[model][tariff][bucket] = values[index]
    })
  }

  for (const model of models) {
    for (const tariff of ['off', 'peak']) {
      for (const bucket of BUCKETS) {
        const value = table[model][tariff][bucket]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new Error(`incomplete pricing for ${model} ${tariff} ${bucket}`)
        }
      }
    }
  }
  return table
}

/**
 * Read one optional Host service without letting a missing one throw.
 * @param ctx - plugin context.
 * @param name - service key.
 * @returns the service, or undefined.
 */
function service(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** @param value - HTML/XML text. @returns common entities decoded. */
function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
}

/**
 * Turn a government HTML page into compact plain text for clause parsing.
 * @param html - page body.
 * @returns whitespace-normalized text.
 */
function extractText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<[^>]+>/gu, ' '),
  ).replace(/\s+/gu, ' ')
}

/**
 * Parse the State Council notice body into off-peak holiday dates.
 *
 * This is deliberately deterministic text parsing, not a model call. It reads
 * the seven festival clauses and takes the first date or date range in each;
 * later dates in the same clause are make-up workdays, which are already
 * off-peak because they fall on a weekend.
 *
 * @param htmlOrText - fetched notice page or plain notice text.
 * @param year - schedule year.
 * @returns sorted `YYYY-MM-DD` dates.
 */
export function parseHolidayNotice(htmlOrText, year) {
  const compact = extractText(htmlOrText).replace(/\s+/gu, '')
  const names = '元旦|春节|清明节|劳动节|端午节|中秋节|国庆节'
  const clauses = [...compact.matchAll(new RegExp(`(${names})[：:]([^。]+)。`, 'gu'))]
  const dates = new Set()
  const add = (month, day) => {
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return
    dates.add(`${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  for (const clause of clauses) {
    const body = clause[2]
    const range = /(\d{1,2})月(\d{1,2})日[^至。]*至(?:(\d{1,2})月)?(\d{1,2})日/u.exec(body)
    if (range !== null) {
      const startMonth = Number(range[1])
      const startDay = Number(range[2])
      const endMonth = range[3] === undefined ? startMonth : Number(range[3])
      const endDay = Number(range[4])
      let month = startMonth
      let day = startDay
      for (let index = 0; index < 400; index += 1) {
        add(month, day)
        if (month === endMonth && day === endDay) break
        day += 1
        if (day > 31) {
          day = 1
          month += 1
        }
        if (month > 12) break
      }
    } else {
      const single = /(\d{1,2})月(\d{1,2})日/u.exec(body)
      if (single !== null) add(Number(single[1]), Number(single[2]))
    }
  }
  if (dates.size === 0) throw new Error(`holiday notice for ${String(year)} has no readable dates`)
  return [...dates].sort()
}

/** @param html - government index page. @returns `{ title, link }[]`. */
function parseIndexLinks(html) {
  const links = []
  const pattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu
  for (const match of String(html).matchAll(pattern)) {
    const href = decodeEntities(match[1]).trim()
    const title = decodeEntities(match[2].replace(/<[^>]+>/gu, '')).trim()
    if (title === '' || href === '') continue
    try {
      links.push({ title, link: new URL(href, 'https://www.gov.cn/').href })
    } catch {
      /* ignore malformed href */
    }
  }
  return links
}

/**
 * Find the notice URL for one year from the official latest-documents page,
 * with a known URL and a Bing RSS fallback for older/future years.
 * @param year - schedule year.
 * @returns `{ url, via }`.
 */
async function discoverHolidayNotice(year, includeKnown = true) {
  const wanted = `国务院办公厅关于${String(year)}年部分节假日安排的通知`
  const known = includeKnown ? KNOWN_HOLIDAY_NOTICES[year] : undefined
  if (known !== undefined) return { url: known, via: 'known' }

  try {
    const indexHtml = await fetchText(HOLIDAY_INDEX_URL, 'text/html')
    const hit = parseIndexLinks(indexHtml).find((entry) => entry.title.includes(wanted)
      && /^https?:\/\/www\.gov\.cn\//u.test(entry.link))
    if (hit !== undefined) return { url: hit.link, via: 'gov-index' }
  } catch {
    /* fall through to search */
  }

  const query = encodeURIComponent(`site:gov.cn "${wanted}"`)
  const rss = await fetchText(`https://cn.bing.com/search?q=${query}&format=rss`, 'application/rss+xml')
  const item = [...String(rss).matchAll(/<item>([\s\S]*?)<\/item>/giu)]
    .map((match) => {
      const block = match[1]
      const link = decodeEntities(/<link>([\s\S]*?)<\/link>/iu.exec(block)?.[1] ?? '').trim()
      const description = decodeEntities(/<description>([\s\S]*?)<\/description>/iu.exec(block)?.[1] ?? '')
      return { link, description }
    })
    .find((entry) => /^https?:\/\/www\.gov\.cn\//u.test(entry.link))
  if (item === undefined) throw new Error(`no official holiday notice found for ${String(year)}`)
  return { url: item.link, via: 'search', description: item.description }
}

/** @param url - URL to fetch. @param accept - Accept header. @returns body text. */
async function fetchText(url, accept) {
  const response = await fetch(url, {
    headers: {
      accept,
      'user-agent': 'dsh-continue-cost',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${String(response.status)}`)
  return response.text()
}

/**
 * Load and parse one year's official holiday notice.
 * @param year - schedule year.
 * @returns `{ dates, sourceUrl, via }`.
 */
async function loadHolidayYear(year) {
  let discovered = await discoverHolidayNotice(year)
  let body
  try {
    body = await fetchText(discovered.url, 'text/html')
  } catch (error) {
    if (discovered.via === 'known') {
      discovered = await discoverHolidayNotice(year, false)
      body = await fetchText(discovered.url, 'text/html')
    } else if (typeof discovered.description === 'string') {
      body = discovered.description
    } else {
      throw error
    }
  }
  try {
    return { dates: parseHolidayNotice(body, year), sourceUrl: discovered.url, via: discovered.via }
  } catch (error) {
    if (discovered.via === 'known') {
      discovered = await discoverHolidayNotice(year, false)
      body = typeof discovered.description === 'string'
        ? discovered.description
        : await fetchText(discovered.url, 'text/html')
      return { dates: parseHolidayNotice(body, year), sourceUrl: discovered.url, via: discovered.via }
    }
    throw error
  }
}

/**
 * Write one JSON response.
 * @param res - the HTTP response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** @param ctx - the plugin's context. */
export function apply(ctx) {
  /** Last successful table, reused for `CACHE_MS`. */
  let cache
  /** In-flight fetch, so concurrent readers share one upstream request. */
  let inflight

  /**
   * Read the price table, fetching only when missing, forced, or stale.
   * @param force - true for an explicit refresh.
   * @returns the JSON body the route answers with.
   */
  const read = async (force) => {
    const fresh = cache !== undefined && Date.now() - cache.fetchedAt < CACHE_MS
    if (!force && fresh) return cache
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      const response = await fetch(PRICING_URL, {
        headers: {
          accept: 'text/markdown, text/plain;q=0.9, */*;q=0.8',
          'user-agent': 'dsh-continue-cost',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`pricing page returned HTTP ${String(response.status)}`)
      const markdown = await response.text()
      const models = parsePricing(markdown)
      cache = {
        ok: true,
        source: 'official',
        url: PRICING_URL,
        fetchedAt: Date.now(),
        models,
      }
      return cache
    })()
      .catch((error) => {
        if (cache !== undefined) {
          return {
            ...cache,
            stale: true,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        return {
          ok: false,
          reason: 'fetch-failed',
          message: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
        }
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  ctx.effect(() => {
    const webServer = service(ctx, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger.warn('dsh-continue-cost: no webServer service; price refresh is unavailable')
      return () => {}
    }
    return webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/prices`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          sendJson(res, 200, await read(url.searchParams.get('refresh') === '1'))
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            reason: 'internal',
            message: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now(),
          })
        }
      },
    })
  }, 'dsh-continue-cost: price route')

  /** Parsed holiday years, keyed by year; reused for one day. */
  const holidayCache = new Map()
  /** In-flight holiday fetches, keyed by year. */
  const holidayInflight = new Map()

  /**
   * Load one year's holiday schedule, reusing a fresh parse or an in-flight
   * request. A failed refresh with a previous value returns the stale value.
   * @param year - schedule year.
   * @param force - true for an explicit refresh.
   * @returns `{ ok, dates?, error? }`.
   */
  const readHolidayYear = async (year, force) => {
    const cached = holidayCache.get(year)
    if (!force && cached !== undefined && Date.now() - cached.fetchedAt < HOLIDAY_CACHE_MS) {
      return cached
    }
    const existing = holidayInflight.get(year)
    if (existing !== undefined) return existing
    const pending = loadHolidayYear(year)
      .then((result) => {
        const record = {
          ok: true,
          dates: result.dates,
          sourceUrl: result.sourceUrl,
          via: result.via,
          fetchedAt: Date.now(),
        }
        holidayCache.set(year, record)
        return record
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (cached !== undefined) return { ...cached, stale: true, error: message }
        return { ok: false, error: message }
      })
      .finally(() => {
        holidayInflight.delete(year)
      })
    holidayInflight.set(year, pending)
    return pending
  }

  /**
   * Read current-year and next-year schedules.
   * @param force - true for an explicit refresh.
   * @returns the holiday route body.
   */
  const readHolidays = async (force) => {
    const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const currentYear = beijing.getUTCFullYear()
    const years = [currentYear, currentYear + 1]
    const records = await Promise.all(years.map((year) => readHolidayYear(year, force)))
    const result = {}
    const errors = {}
    records.forEach((record, index) => {
      const year = years[index]
      if (record.ok) result[year] = record.dates
      else errors[year] = record.error
    })
    const ok = Object.keys(result).length > 0
    return {
      ok,
      source: 'official',
      fetchedAt: Date.now(),
      years: result,
      ...(ok ? {} : { reason: 'fetch-failed', message: 'no year could be loaded', errors }),
      ...(ok && Object.keys(errors).length > 0 ? { errors } : {}),
    }
  }

  ctx.effect(() => {
    const webServer = service(ctx, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger.warn('dsh-continue-cost: no webServer service; holiday refresh is unavailable')
      return () => {}
    }
    return webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/holidays`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          sendJson(res, 200, await readHolidays(url.searchParams.get('refresh') === '1'))
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            reason: 'internal',
            message: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now(),
          })
        }
      },
    })
  }, 'dsh-continue-cost: holiday route')
}
