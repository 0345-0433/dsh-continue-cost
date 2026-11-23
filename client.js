/**
 * Browser half of `dsh-continue-cost`.
 *
 * One compact chip in the composer's trailing cluster
 * (`conversation.input.right`) shows the completed turn count. Its dot uses the
 * user's green / yellow / red thresholds, and hovering opens a panel with an
 * estimate of the extra input cost of continuing this conversation instead of
 * starting a new one.
 *
 * Every input is a live session projection (turn count, token usage, context
 * pressure/composition, model selection). All arithmetic happens in this
 * module, on this page. The optional Host routes only contribute the official
 * price table and holiday schedule; no Session content or credential is sent.
 *
 * Written as plain JavaScript against the module-loader factory contract: no
 * JSX, no imports, React comes from the shared table.
 */
;(() => {
  /** Package name; also the Client module id and the registrant row name. */
  const NAME = 'dsh-continue-cost'
  /** Locale namespace; every visible string goes through it. */
  const NS = 'dsh-continue-cost'
  /* Keys keep the pre-rename prefix on purpose: an existing install must keep
   * its thresholds and cached tables across the package rename. */
  /** Threshold settings survive reloads in this browser. */
  const STORAGE_KEY = 'dsh-turn-cost-meter:settings:v1'
  /** Last validated official price table, so a reload still has prices offline. */
  const PRICE_STORAGE_KEY = 'dsh-turn-cost-meter:prices:v1'
  /** Host route that fetches the official pricing page server-side. */
  const PRICE_PATH = '/plugins/dsh-continue-cost/prices'
  /** Last validated official holiday schedule, so a reload still has it offline. */
  const HOLIDAY_STORAGE_KEY = 'dsh-turn-cost-meter:holidays:v1'
  /** Host route that fetches the current/next year's State Council notice. */
  const HOLIDAY_PATH = '/plugins/dsh-continue-cost/holidays'

  /**
   * Official list prices, CNY per 1M tokens, by wire model id. Mirrors the
   * table used by the API-balance plugin and DeepSeek's pricing page. An
   * unknown model is reported as unknown rather than guessed.
   */
  const PRICING = {
    'deepseek-flash': {
      off: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
    'deepseek-v4-pro': {
      off: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
  }

  /** Retired wire ids the provider still serves and bills under a current model. */
  const PRICING_ALIASES = {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  }

  /**
   * Chinese statutory holidays in 2026, as Beijing calendar dates. DeepSeek's
   * current rule makes every Chinese public holiday an off-peak day, and
   * also makes make-up working weekends off-peak (the ordinary weekend check
   * already covers those). Source: the State Council's 2026 holiday notice,
   * https://www.gov.cn/zhengce/content/202511/content_7047090.htm
   *
   * Update this table when the next year's notice is published. The fixed
   * dates below cover New Year, Labour Day, and the National Day golden week
   * for later years until their formal schedules replace them.
   */
  const CN_HOLIDAYS_2026 = new Set([
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ])

  /** Month-day fixed holidays that apply without a year-specific table. */
  const FIXED_HOLIDAY_MONTH_DAYS = new Set([
    '01-01',
    '05-01',
    '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07',
  ])

  /** Dates fetched from the current/next year's official notice. */
  const FETCHED_HOLIDAYS = new Set()

  /**
   * @param dateKey - Beijing calendar date, `YYYY-MM-DD`.
   * @returns whether DeepSeek treats the date as an off-peak public holiday.
   */
  function isChineseHoliday(dateKey) {
    return CN_HOLIDAYS_2026.has(dateKey)
      || FETCHED_HOLIDAYS.has(dateKey)
      || FIXED_HOLIDAY_MONTH_DAYS.has(dateKey.slice(5))
  }

  /** @param value - candidate price. @returns a finite non-negative number, or undefined. */
  function priceNumber(value) {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }

  /**
   * Validate one model's two tariffs from the Host route or localStorage.
   * @param entry - candidate `{ off, peak }`.
   * @returns detached valid prices, or undefined.
   */
  function normalizePriceEntry(entry) {
    if (entry === null || typeof entry !== 'object') return undefined
    const normalized = {}
    for (const tariff of ['off', 'peak']) {
      const prices = entry[tariff]
      if (prices === null || typeof prices !== 'object') return undefined
      const cacheHit = priceNumber(prices.cacheHit)
      const cacheMiss = priceNumber(prices.cacheMiss)
      const output = priceNumber(prices.output)
      if (cacheHit === undefined || cacheMiss === undefined || output === undefined) return undefined
      normalized[tariff] = { cacheHit, cacheMiss, output }
    }
    return normalized
  }

  /**
   * Merge validated official prices into the built-in table. Existing models
   * are replaced only when all six prices are readable; new models are added.
   * @param models - `{ modelId: { off, peak } }` from the Host or cache.
   * @returns how many models were accepted.
   */
  function mergePriceModels(models) {
    if (models === null || typeof models !== 'object') return 0
    let accepted = 0
    for (const [name, entry] of Object.entries(models)) {
      if (!/^[a-z0-9][a-z0-9._/-]*$/iu.test(name)) continue
      const prices = normalizePriceEntry(entry)
      if (prices === undefined) continue
      PRICING[name.toLowerCase()] = prices
      accepted += 1
    }
    return accepted
  }

  /**
   * Load the last officially fetched table from this browser.
   * @returns `{ fetchedAt }` when at least one model was applied, else undefined.
   */
  function readCachedPrices() {
    try {
      const raw = window.localStorage.getItem(PRICE_STORAGE_KEY)
      if (raw === null) return undefined
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return undefined
      const accepted = mergePriceModels(parsed.models)
      if (accepted === 0) return undefined
      return { fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : undefined }
    } catch {
      return undefined
    }
  }

  /**
   * Persist the merged table. `PRICING` is written as a whole so built-in
   * models survive too; the next load validates every entry again.
   * @param fetchedAt - Host observation time, or now when unavailable.
   */
  function writeCachedPrices(fetchedAt) {
    try {
      window.localStorage.setItem(PRICE_STORAGE_KEY, JSON.stringify({ fetchedAt, models: PRICING }))
    } catch {
      /* private mode or a full quota: the in-memory table still works */
    }
  }

  /** @param value - candidate date. @returns whether it is a real `YYYY-MM-DD` date. */
  function isHolidayDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  }

  /**
   * Merge fetched official holiday dates into the runtime set.
   * @param dates - candidate `YYYY-MM-DD` strings.
   * @returns how many new dates were accepted.
   */
  function mergeHolidayDates(dates) {
    if (!Array.isArray(dates)) return 0
    let accepted = 0
    for (const date of dates) {
      if (!isHolidayDate(date) || FETCHED_HOLIDAYS.has(date)) continue
      FETCHED_HOLIDAYS.add(date)
      accepted += 1
    }
    return accepted
  }

  /**
   * Load the last official holiday schedule remembered by this browser.
   * @returns `{ fetchedAt }` when at least one date was applied, else undefined.
   */
  function readCachedHolidays() {
    try {
      const raw = window.localStorage.getItem(HOLIDAY_STORAGE_KEY)
      if (raw === null) return undefined
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return undefined
      const accepted = mergeHolidayDates(parsed.dates)
      if (accepted === 0) return undefined
      return { fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : undefined }
    } catch {
      return undefined
    }
  }

  /** @param fetchedAt - Host observation time, or now when unavailable. */
  function writeCachedHolidays(fetchedAt) {
    try {
      window.localStorage.setItem(HOLIDAY_STORAGE_KEY, JSON.stringify({
        fetchedAt,
        dates: [...FETCHED_HOLIDAYS],
      }))
    } catch {
      /* private mode or a full quota: the in-memory schedule still works */
    }
  }

  /** Defaults keep the first run useful without opening the settings. */
  const DEFAULT_SETTINGS = {
    metric: 'turns',
    turnsGreen: 5,
    turnsYellow: 10,
    costGreen: 0.05,
    costYellow: 0.15,
  }

  const ZH = {
    'chip.title': '对话轮数与续聊差价',
    'chip.unit': '轮',
    'chip.turnsLoading': '轮数 …',
    'chip.costUnknown': '¥ —',
    'chip.pinHint': '悬停看估算，点击胶囊固定并调整显示与阈值',
    'panel.title': '续聊差价估算',
    'panel.turns': '已完成轮数',
    'panel.extra': '差额（继续 − 新开）',
    'panel.continue': '继续当前对话（下一轮上下文）',
    'panel.fresh': '新开对话（同一轮上下文）',
    'panel.history': '历史上下文',
    'panel.prompt': '下一轮上下文预计',
    'panel.tokens': 'tokens',
    'panel.rateMeasured': '本会话平均 token 单价',
    'panel.rateReference': '参考 token 单价（未命中缓存）',
    'panel.model': '计价模型',
    'panel.noModel': '未选择模型',
    'panel.priceTable': '价格表',
    'panel.priceOnline': '官方在线',
    'panel.priceCache': '本地缓存',
    'panel.priceBuiltin': '内置',
    'panel.holidayTable': '节假日表',
    'panel.holidayOnline': '官方在线',
    'panel.holidayCache': '本地缓存',
    'panel.holidayBuiltin': '内置',
    'panel.perMillion': '/ 百万 tokens',
    'panel.tariff': '当前时段',
    'panel.tariffRule': '工作日北京时间 9:00–12:00、14:00–18:00 为峰时；午间、周末与法定节假日全天为谷时。跨过边界后这里与芯片上的「峰/谷」会自动切换。',
    'panel.beijingTime': '北京时间',
    'panel.noPrice': '未收录该模型价格',
    'panel.noContext': '上下文数据还没准备好，暂时无法估算历史占比。',
    'panel.waiting': '还没有可用的 token 用量，先按未命中缓存的单价估算。',
    'panel.note': '分别估算继续和新开的上下文费用（系统提示、工具 schema、历史消息）；回答本身费用两边相同，所以差额来自历史消息。按缓存命中比例估算，实际可能更低；以账单为准。',
    'panel.colorBy': '显示与着色',
    'panel.current': '当前显示值',
    'panel.leq': '≤',
    'panel.gt': '>',
    'tone.green': '绿',
    'tone.yellow': '黄',
    'tone.red': '红',
    'tone.idle': '等待数据',
    'tariff.peak': '峰时',
    'tariff.off': '谷时',
    'tariff.peakShort': '峰',
    'tariff.offShort': '谷',
    'settings.title': '阈值设置',
    'settings.turns': '对话轮数',
    'settings.cost': '多花金额',
    'settings.green': '绿色上限',
    'settings.yellow': '黄色上限',
    'settings.unitTurns': '轮',
    'settings.unitCost': '元',
    'settings.hint': '胶囊显示所选项，并按同一个数值着色：不超过绿色上限为绿，不超过黄色上限为黄，超过为红；两项自动保持先后顺序。',
    'settings.reset': '恢复默认',
    'settings.unpin': '收起',
    'settings.pinHint': '点击胶囊固定面板后即可切换显示和调整阈值。',
  }

  const EN = {
    'chip.title': 'Turn count & carry-over delta',
    'chip.unit': 'turns',
    'chip.turnsLoading': 'Turns …',
    'chip.costUnknown': '¥ —',
    'chip.pinHint': 'Hover for the estimate; click the chip to pin and adjust display/thresholds',
    'panel.title': 'Carry-over delta estimate',
    'panel.turns': 'Completed turns',
    'panel.extra': 'Delta (continue − fresh)',
    'panel.continue': 'Continue this chat (next-turn context)',
    'panel.fresh': 'Fresh chat (same-turn context)',
    'panel.history': 'History context',
    'panel.prompt': 'Next-turn context estimate',
    'panel.tokens': 'tokens',
    'panel.rateMeasured': 'Session average token rate',
    'panel.rateReference': 'Reference token rate (cache miss)',
    'panel.model': 'Priced model',
    'panel.noModel': 'No model selected',
    'panel.priceTable': 'Price table',
    'panel.priceOnline': 'Official online',
    'panel.priceCache': 'Local cache',
    'panel.priceBuiltin': 'Built-in',
    'panel.holidayTable': 'Holiday table',
    'panel.holidayOnline': 'Official online',
    'panel.holidayCache': 'Local cache',
    'panel.holidayBuiltin': 'Built-in',
    'panel.perMillion': '/ 1M tokens',
    'panel.tariff': 'Current tariff',
    'panel.tariffRule': 'Peak is 09:00–12:00 and 14:00–18:00 Beijing weekdays; the midday break, weekends and public holidays are off-peak. The chip badge and this row follow the clock automatically.',
    'panel.beijingTime': 'Beijing',
    'panel.noPrice': 'No listed price for this model',
    'panel.noContext': 'Context data is not ready yet; the history share is unknown for now.',
    'panel.waiting': 'No token usage yet; pricing the history at the cache-miss rate.',
    'panel.note': 'Both sides estimate the context cost (system prompt, tool schemas, history messages); the answer cost is identical, so the delta comes from history. Priced from the cache-hit mix; the real delta may be lower. Actual billing may differ.',
    'panel.colorBy': 'Display & color',
    'panel.current': 'Current display',
    'panel.leq': '≤',
    'panel.gt': '>',
    'tone.green': 'green',
    'tone.yellow': 'yellow',
    'tone.red': 'red',
    'tone.idle': 'waiting for data',
    'tariff.peak': 'peak',
    'tariff.off': 'off-peak',
    'tariff.peakShort': 'peak',
    'tariff.offShort': 'off',
    'settings.title': 'Thresholds',
    'settings.turns': 'Turns',
    'settings.cost': 'Extra cost',
    'settings.green': 'Green up to',
    'settings.yellow': 'Yellow up to',
    'settings.unitTurns': 'turns',
    'settings.unitCost': 'CNY',
    'settings.hint': 'The chip shows and colors by the selected value: green up to the first limit, yellow up to the second, red above it; the two limits keep their order.',
    'settings.reset': 'Reset',
    'settings.unpin': 'Close',
    'settings.pinHint': 'Click the chip to pin the panel, then switch the display and adjust thresholds.',
  }

  /** @param value - candidate number. @returns a finite non-negative number, else the fallback. */
  function nonNegative(value, fallback) {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }

  /**
   * Coerce one stored settings object, keeping every threshold valid and the
   * yellow limit at or above the green one.
   * @param raw - parsed localStorage value.
   * @returns complete settings.
   */
  function normalizeSettings(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const metric = source.metric === 'cost' ? 'cost' : 'turns'
    const turnsGreen = Math.round(nonNegative(source.turnsGreen, DEFAULT_SETTINGS.turnsGreen))
    const turnsYellow = Math.max(
      turnsGreen,
      Math.round(nonNegative(source.turnsYellow, DEFAULT_SETTINGS.turnsYellow)),
    )
    const costGreen = nonNegative(source.costGreen, DEFAULT_SETTINGS.costGreen)
    const costYellow = Math.max(costGreen, nonNegative(source.costYellow, DEFAULT_SETTINGS.costYellow))
    return { metric, turnsGreen, turnsYellow, costGreen, costYellow }
  }

  /** @returns settings remembered by this browser, or the defaults. */
  function readSettings() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw === null ? normalizeSettings(undefined) : normalizeSettings(JSON.parse(raw))
    } catch {
      return normalizeSettings(undefined)
    }
  }

  /**
   * Read one non-negative finite count out of a projection value that crossed
   * the wire, so a malformed bucket cannot become a fake cost.
   * @param value - candidate from the projection.
   * @returns the count, or 0.
   */
  function countOf(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * Resolve the list price of the route serving this conversation. The route
   * may be addressed with a provider prefix, so both spellings resolve.
   * @param selection - `modelSelection` projection.
   * @returns that model's tariffs, or undefined.
   */
  function pricingOf(selection) {
    const raw = selection?.next?.model ?? selection?.lastUsed?.model
    if (typeof raw !== 'string' || raw === '') return undefined
    const slash = raw.lastIndexOf('/')
    const bare = slash === -1 ? raw : raw.slice(slash + 1)
    const bareKey = bare.toLowerCase()
    const fullKey = raw.toLowerCase()
    const id = PRICING[bareKey] === undefined ? fullKey : bareKey
    const alias = PRICING_ALIASES[id]
      ?? PRICING_ALIASES[bareKey]
      ?? PRICING_ALIASES[fullKey]
    return PRICING[id] ?? (alias === undefined ? undefined : PRICING[alias])
  }

  /** @returns the bare model id serving the conversation, or undefined. */
  function modelOf(selection) {
    const raw = selection?.next?.model ?? selection?.lastUsed?.model
    if (typeof raw !== 'string' || raw === '') return undefined
    const slash = raw.lastIndexOf('/')
    return slash === -1 ? raw : raw.slice(slash + 1)
  }

  /**
   * Peak windows as Beijing wall-clock `[start, end)` hour pairs, straight from
   * the official pricing page: "北京时间周一至周五（不含中国法定节假日）
   * 9:00 - 12:00、14:00 - 18:00 为高峰时段". Everything else — including the
   * 12:00-14:00 midday break, weekends and statutory holidays — is off-peak.
   */
  const PEAK_WINDOWS = [
    [9, 12],
    [14, 18],
  ]

  /** Hours at which the tariff can change: window edges plus midnight. */
  const TARIFF_BOUNDARY_HOURS = [0, ...PEAK_WINDOWS.flat()]

  /** How far ahead the boundary search looks (a weekend plus a holiday run). */
  const BOUNDARY_LOOKAHEAD_DAYS = 12

  /**
   * Read an instant as Beijing wall-clock fields. Shifting the epoch by eight
   * hours and reading the UTC fields makes the answer independent of the
   * browser's own time zone.
   * @param now - instant to read.
   * @returns `{ day, hour, minute, timeKey, dateKey }` in Beijing time.
   */
  function beijingClock(now = new Date()) {
    const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const hour = shifted.getUTCHours()
    const minute = shifted.getUTCMinutes()
    return {
      day: shifted.getUTCDay(),
      hour,
      minute,
      dateKey: shifted.toISOString().slice(0, 10),
      timeKey: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    }
  }

  /**
   * @param clock - Beijing wall-clock fields from {@link beijingClock}.
   * @returns true when the provider charges the peak tariff then.
   */
  function isPeakAtClock(clock) {
    if (clock.day === 0 || clock.day === 6) return false
    if (isChineseHoliday(clock.dateKey)) return false
    return PEAK_WINDOWS.some(([start, end]) => clock.hour >= start && clock.hour < end)
  }

  /**
   * Which provider tariff is in force now: peak 09:00-12:00 and 14:00-18:00
   * Beijing time on weekdays, off-peak on weekends, make-up working weekends,
   * and Chinese public holidays. The holiday table covers 2026 plus the fixed
   * New Year / Labour Day / National Day dates for later years.
   * @param now - instant to classify.
   * @returns true for peak.
   */
  function isPeakTariff(now = new Date()) {
    try {
      return isPeakAtClock(beijingClock(now))
    } catch {
      return true
    }
  }

  /**
   * Milliseconds until the tariff next changes, so the chip can switch exactly
   * at 09:00 / 12:00 / 14:00 / 18:00 and at midnight (weekend or holiday
   * starts) instead of waiting for the next poll. Returns the poll interval
   * when the search fails.
   * @param now - instant to measure from.
   * @returns a positive delay in milliseconds.
   */
  function msUntilNextTariffChange(now = new Date()) {
    try {
      const base = now.getTime()
      const shifted = new Date(base + 8 * 60 * 60 * 1000)
      const year = shifted.getUTCFullYear()
      const month = shifted.getUTCMonth()
      const date = shifted.getUTCDate()
      let next = Number.POSITIVE_INFINITY
      for (let offset = 0; offset <= BOUNDARY_LOOKAHEAD_DAYS; offset += 1) {
        const day = new Date(Date.UTC(year, month, date + offset))
        for (const hour of TARIFF_BOUNDARY_HOURS) {
          const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour)
            - 8 * 60 * 60 * 1000
          if (at > base + 1_000 && at < next) next = at
        }
      }
      return Number.isFinite(next) ? next - base : 30_000
    } catch {
      return 30_000
    }
  }

  /**
   * Estimate the next turn's input side and the extra part caused by carrying
   * the current history into it.
   *
   * `historyTokens` comes from the heuristic composition of the next request,
   * scaled to the provider-anchored next-request pressure when one is present.
   * If neither context projection has arrived, the history share is unknown
   * rather than guessed from cumulative usage: one turn can contain many
   * tool/model steps, so an average input per turn would overstate it badly.
   * The per-million-token rate is the session's observed cache-hit/cache-miss
   * mix at the current tariff; with no usage yet it falls back to the
   * cache-miss rate. Output is identical between continuing and starting
   * fresh, so it is left out.
   *
   * @param params - live projections and the current tariff.
   * @returns the estimate and the figures behind it.
   */
  function estimateNextTurn(params) {
    const { usage, breakdown, pressure, selection, peak } = params
    const tariffs = pricingOf(selection)
    const tariff = tariffs === undefined ? undefined : tariffs[peak ? 'peak' : 'off']
    const systemTokens = countOf(breakdown?.systemTokens)
    const toolsTokens = countOf(breakdown?.toolsTokens)
    const baseTokens = systemTokens + toolsTokens
    const hit = countOf(usage?.cacheReadTokens)
    const miss = countOf(usage?.uncachedInputTokens) + countOf(usage?.cacheWriteTokens)
    const inputTokens = hit + miss
    const projected = countOf(pressure?.projectedTokens)
    const lastPressure = countOf(pressure?.pressureTokens)
    const anchor = projected > 0 ? projected : lastPressure
    const heuristicHistory = countOf(breakdown?.messageTokens)
    const heuristicTotal = baseTokens + heuristicHistory
    const inferredHistory = anchor > baseTokens ? anchor - baseTokens : 0
    const hasContext = anchor > 0 || breakdown !== undefined
    // `projectedTokens`/`pressureTokens` are provider-anchored while the
    // composition is heuristic. When both exist, scale the message share to
    // the anchored total so a systematic CJK/JSON undercount does not shrink
    // the history.
    const historyTokens =
      anchor > 0 && heuristicHistory > 0 && heuristicTotal > 0
        ? anchor * (heuristicHistory / heuristicTotal)
        : heuristicHistory > 0
          ? heuristicHistory
          : inferredHistory
    const promptTokens = anchor > 0 ? anchor : historyTokens + baseTokens

    const ratePerMillion =
      tariff === undefined
        ? undefined
        : inputTokens > 0
          ? (hit * tariff.cacheHit + miss * tariff.cacheMiss) / inputTokens
          : tariff.cacheMiss

    const priced = tariff !== undefined && ratePerMillion !== undefined
    const extraCny = priced && hasContext ? (historyTokens / 1e6) * ratePerMillion : undefined
    const totalCny = priced && hasContext ? (promptTokens / 1e6) * ratePerMillion : undefined
    const freshCny =
      priced && hasContext ? (Math.max(0, promptTokens - historyTokens) / 1e6) * ratePerMillion : undefined
    return {
      priced,
      hasContext,
      measured: inputTokens > 0,
      historyTokens,
      promptTokens,
      baseTokens,
      extraCny,
      totalCny,
      freshCny,
      rate: ratePerMillion,
      model: modelOf(selection),
      peak,
      hasUsage: inputTokens > 0,
    }
  }

  /**
   * Pick the dot tone from the configured metric and thresholds.
   * @param settings - normalized settings.
   * @param turns - completed turns.
   * @param estimate - the current estimate.
   * @param loaded - whether the turn projection has arrived.
   * @returns `green`, `yellow`, `red`, or `idle`.
   */
  function toneOf(settings, turns, estimate, loaded) {
    let value
    let green
    let yellow
    if (settings.metric === 'cost') {
      if (!estimate.hasContext || !estimate.priced || estimate.extraCny === undefined) return 'idle'
      value = estimate.extraCny
      green = settings.costGreen
      yellow = settings.costYellow
    } else {
      if (!loaded) return 'idle'
      value = turns
      green = settings.turnsGreen
      yellow = settings.turnsYellow
    }
    if (value <= green) return 'green'
    if (value <= yellow) return 'yellow'
    return 'red'
  }

  /**
   * Build the browser bundle's factory.
   * @param require - the module table's require.
   * @returns the factory the module loader registers.
   */
  function makeFactory() {
    return (require) => {
      const module = { exports: {} }
      const React = require('react')
      const { createElement: h, useState, useEffect, useRef, useSyncExternalStore } = React

      /** The last table remembered by this browser, applied before the fetch lands. */
      const cachedPrice = readCachedPrices()
      /** One shared price-table snapshot; components re-render when it changes. */
      let priceSnapshot = {
        source: cachedPrice === undefined ? 'builtin' : 'cache',
        fetchedAt: cachedPrice === undefined ? undefined : cachedPrice.fetchedAt,
        revision: 0,
      }
      const priceListeners = new Set()
      let priceInflight = null

      /** @param listener - price change callback. @returns unsubscribe. */
      function subscribePrices(listener) {
        priceListeners.add(listener)
        return () => {
          priceListeners.delete(listener)
        }
      }

      /** @returns the current price-table snapshot. */
      function getPriceSnapshot() {
        return priceSnapshot
      }

      /** @returns current price-table metadata, re-rendering on update. */
      function usePrices() {
        return useSyncExternalStore(subscribePrices, getPriceSnapshot)
      }

      /**
       * Ask the Host to fetch the official pricing Markdown and merge any
       * validated model prices. Failure leaves the built-in/cached table in
       * place and stays silent; this is an enhancement, not a prerequisite.
       * @returns a promise settling after the attempt.
       */
      function refreshPrices() {
        if (priceInflight !== null) return priceInflight
        priceInflight = (async () => {
          try {
            const response = await fetch(PRICE_PATH, {
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const body = await response.json()
            if (body === null || typeof body !== 'object' || body.ok !== true) return
            const accepted = mergePriceModels(body.models)
            if (accepted === 0) return
            const fetchedAt = typeof body.fetchedAt === 'number' ? body.fetchedAt : Date.now()
            writeCachedPrices(fetchedAt)
            priceSnapshot = {
              source: 'online',
              fetchedAt,
              revision: priceSnapshot.revision + 1,
            }
            for (const listener of priceListeners) listener()
          } catch {
            /* offline or no Host route: keep the built-in/cached table */
          } finally {
            priceInflight = null
          }
        })()
        return priceInflight
      }

      /** The last official holiday schedule remembered by this browser. */
      const cachedHoliday = readCachedHolidays()
      /** One shared holiday-table snapshot; components re-render when it changes. */
      let holidaySnapshot = {
        source: cachedHoliday === undefined ? 'builtin' : 'cache',
        fetchedAt: cachedHoliday === undefined ? undefined : cachedHoliday.fetchedAt,
        revision: 0,
      }
      const holidayListeners = new Set()
      let holidayInflight = null

      /** @param listener - holiday change callback. @returns unsubscribe. */
      function subscribeHolidays(listener) {
        holidayListeners.add(listener)
        return () => {
          holidayListeners.delete(listener)
        }
      }

      /** @returns the current holiday-table snapshot. */
      function getHolidaySnapshot() {
        return holidaySnapshot
      }

      /** @returns current holiday-table metadata, re-rendering on update. */
      function useHolidays() {
        return useSyncExternalStore(subscribeHolidays, getHolidaySnapshot)
      }

      /**
       * Ask the Host to discover and parse the current/next year's State
       * Council holiday notice. A failure keeps the built-in/cached schedule.
       * @returns a promise settling after the attempt.
       */
      function refreshHolidays() {
        if (holidayInflight !== null) return holidayInflight
        holidayInflight = (async () => {
          try {
            const response = await fetch(HOLIDAY_PATH, {
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const body = await response.json()
            if (body === null || typeof body !== 'object' || body.ok !== true) return
            if (body.years === null || typeof body.years !== 'object') return
            const dates = Object.values(body.years).flatMap((value) => Array.isArray(value) ? value : [])
            const valid = dates.filter((date) => isHolidayDate(date))
            if (valid.length === 0) return
            mergeHolidayDates(valid)
            const fetchedAt = typeof body.fetchedAt === 'number' ? body.fetchedAt : Date.now()
            writeCachedHolidays(fetchedAt)
            holidaySnapshot = {
              source: 'online',
              fetchedAt,
              revision: holidaySnapshot.revision + 1,
            }
            for (const listener of holidayListeners) listener()
          } catch {
            /* offline or no Host route: keep the built-in/cached schedule */
          } finally {
            holidayInflight = null
          }
        })()
        return holidayInflight
      }

      /** Chip geometry and panel styling; every color is a host theme token. */
      const CSS = `
.dshTurnCost_anchor { position: relative; display: inline-flex; align-items: center; }
.dshTurnCost_chip {
  box-sizing: border-box;
  display: inline-flex;
  align-items: stretch;
  height: 28px;
  max-width: 200px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
}
.dshTurnCost_chip:hover { background: var(--dsw-alias-bg-layer-2); }
.dshTurnCost_chip[data-tone="green"] { color: var(--dsw-alias-label-primary); }
.dshTurnCost_chip[data-tone="yellow"] { color: var(--dsw-alias-label-primary); }
.dshTurnCost_chip[data-tone="red"] { color: var(--dsw-alias-label-primary); }
.dshTurnCost_chip:focus-within { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshTurnCost_main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dshTurnCost_main:focus-visible { outline: none; }
.dshTurnCost_dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-state-idle-primary);
}
.dshTurnCost_chip[data-tone="green"] .dshTurnCost_dot { background: var(--dsw-alias-state-success-primary); }
.dshTurnCost_chip[data-tone="yellow"] .dshTurnCost_dot { background: var(--dsw-alias-state-warn-primary); }
.dshTurnCost_chip[data-tone="red"] .dshTurnCost_dot { background: var(--dsw-alias-state-error-primary); }
.dshTurnCost_amount { font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.dshTurnCost_tariff {
  flex: none;
  align-self: center;
  padding: 1px 3px;
  border-radius: 3px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 12px;
  letter-spacing: .02em;
}
.dshTurnCost_tariff[data-tariff="peak"] { color: var(--dsw-alias-label-primary); }
.dshTurnCost_panel {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 1400;
  box-sizing: border-box;
  width: 292px;
  max-width: min(292px, calc(100vw - 24px));
  max-height: min(70vh, calc(100vh - 88px));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  pointer-events: auto;
}
.dshTurnCost_header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
  color: var(--dsw-alias-label-secondary);
}
.dshTurnCost_headerTitle { font-weight: 500; }
.dshTurnCost_unpin {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  cursor: pointer;
}
.dshTurnCost_unpin:hover { text-decoration: underline; }
.dshTurnCost_unpin:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshTurnCost_line { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.dshTurnCost_label { color: var(--dsw-alias-label-secondary); }
.dshTurnCost_value { font-variant-numeric: tabular-nums; text-align: right; }
.dshTurnCost_line[data-emphasis="true"] { margin: 3px 0; font-size: 13px; font-weight: 600; }
.dshTurnCost_line[data-emphasis="true"] .dshTurnCost_label { color: var(--dsw-alias-label-primary); }
.dshTurnCost_divider { margin: 7px 0; border-top: .5px solid var(--dsw-alias-border-l1); }
.dshTurnCost_alert { color: var(--dsw-alias-state-warn-primary); }
.dshTurnCost_note { margin-top: 6px; color: var(--dsw-alias-label-secondary); }
.dshTurnCost_stage {
  margin-top: 8px;
  padding-top: 7px;
  border-top: .5px solid var(--dsw-alias-border-l1);
}
.dshTurnCost_stageText { margin-top: 2px; color: var(--dsw-alias-label-secondary); }
.dshTurnCost_pinHint { margin-top: 7px; color: var(--dsw-alias-brand-primary); }
.dshTurnCost_displayRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 7px;
  padding-bottom: 7px;
  border-bottom: .5px solid var(--dsw-alias-border-l1);
}
.dshTurnCost_displayLabel { color: var(--dsw-alias-label-secondary); }
.dshTurnCost_displayRow .dshTurnCost_seg { margin-bottom: 0; }
.dshTurnCost_settings {
  margin-top: 9px;
  padding-top: 8px;
  border-top: .5px solid var(--dsw-alias-border-l1);
}
.dshTurnCost_settingsTitle { margin-bottom: 6px; font-weight: 500; }
.dshTurnCost_seg {
  display: inline-flex;
  margin-bottom: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  overflow: hidden;
}
.dshTurnCost_segBtn {
  padding: 3px 9px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
}
.dshTurnCost_segBtn[data-active="true"] {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dshTurnCost_segBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshTurnCost_field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 5px;
}
.dshTurnCost_fieldLabel { color: var(--dsw-alias-label-secondary); }
.dshTurnCost_inputWrap { display: inline-flex; align-items: center; gap: 4px; }
.dshTurnCost_input {
  box-sizing: border-box;
  width: 74px;
  height: 25px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.dshTurnCost_input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshTurnCost_unit { color: var(--dsw-alias-label-secondary); }
.dshTurnCost_settingsFoot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-top: 7px;
  color: var(--dsw-alias-label-secondary);
}
.dshTurnCost_reset {
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  cursor: pointer;
}
.dshTurnCost_reset:hover { text-decoration: underline; }
.dshTurnCost_reset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
`.trim()

      /** One shared settings store, so two session chips stay in sync. */
      let settings = readSettings()
      const settingsListeners = new Set()

      /** @param next - complete settings to normalize, persist, and publish. */
      function publishSettings(next) {
        settings = normalizeSettings(next)
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
        } catch {
          /* private mode or a full quota: the in-memory value still works */
        }
        for (const listener of settingsListeners) listener()
      }

      /** @param listener - change callback. @returns unsubscribe. */
      function subscribeSettings(listener) {
        settingsListeners.add(listener)
        return () => {
          settingsListeners.delete(listener)
        }
      }

      /** @returns the current settings (stable reference between changes). */
      function getSettings() {
        return settings
      }

      /** @returns current settings, re-rendering on change. */
      function useSettings() {
        return useSyncExternalStore(subscribeSettings, getSettings)
      }

      /** @param amount - non-negative CNY. @returns display text. */
      function formatCny(amount) {
        if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
        const digits = amount > 0 && amount < 0.0001 ? 5 : amount > 0 && amount < 0.01 ? 4 : 2
        try {
          return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: 'CNY',
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(amount)
        } catch {
          return `¥${amount.toFixed(digits)}`
        }
      }

      /** @param amount - non-negative CNY. @returns a cost value with four decimals (five below ¥0.0001). */
      function formatCost(amount) {
        if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
        const digits = amount > 0 && amount < 0.0001 ? 5 : 4
        try {
          return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: 'CNY',
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(amount)
        } catch {
          return `¥${amount.toFixed(digits)}`
        }
      }

      /** @param tokens - non-negative count. @returns display text. */
      function formatTokens(tokens) {
        if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '—'
        try {
          return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(tokens)
        } catch {
          return String(Math.round(tokens))
        }
      }

      /** @param rate - CNY per million tokens. @returns CNY per million tokens. */
      function formatRate(rate) {
        return formatCny(rate)
      }

      /** @param value - threshold number. @returns a plain editable string. */
      function formatInput(value, metric) {
        return metric === 'cost' ? String(value) : String(Math.round(value))
      }

      /** The bundle's stylesheet as one React element, removed with the surface. */
      function StyleTag() {
        return h('style', { 'data-plugin-css': NAME }, CSS)
      }

      /** One label/value row of the panel. */
      function Line({ label, value, emphasis }) {
        return h(
          'div',
          { className: 'dshTurnCost_line', 'data-emphasis': emphasis === true ? 'true' : undefined },
          h('span', { className: 'dshTurnCost_label' }, label),
          h('span', { className: 'dshTurnCost_value' }, value),
        )
      }

      /** One threshold number field; commits a valid value on blur or Enter. */
      function NumberField({ label, value, unit, metric, onCommit }) {
        const [draft, setDraft] = useState(() => formatInput(value, metric))
        const cancelRef = useRef(false)
        useEffect(() => {
          setDraft(formatInput(value, metric))
        }, [value, metric])
        const reset = () => {
          setDraft(formatInput(value, metric))
        }
        const commit = () => {
          if (cancelRef.current) {
            cancelRef.current = false
            reset()
            return
          }
          const text = draft.trim()
          if (text === '') {
            reset()
            return
          }
          const parsed = Number(text.replace(',', '.'))
          if (Number.isFinite(parsed) && parsed >= 0) {
            onCommit(parsed)
          } else {
            reset()
          }
        }
        return h(
          'label',
          { className: 'dshTurnCost_field' },
          h('span', { className: 'dshTurnCost_fieldLabel' }, label),
          h(
            'span',
            { className: 'dshTurnCost_inputWrap' },
            h('input', {
              className: 'dshTurnCost_input',
              type: 'number',
              min: '0',
              step: metric === 'cost' ? '0.01' : '1',
              inputMode: 'decimal',
              value: draft,
              onChange: (event) => {
                cancelRef.current = false
                setDraft(event.target.value)
              },
              onBlur: commit,
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelRef.current = true
                  reset()
                  event.currentTarget.blur()
                }
              },
            }),
            h('span', { className: 'dshTurnCost_unit' }, unit),
          ),
        )
      }

      /** One option of the metric switch. */
      function MetricButton({ active, children, onClick }) {
        return h(
          'button',
          {
            type: 'button',
            className: 'dshTurnCost_segBtn',
            'data-active': active ? 'true' : 'false',
            'aria-pressed': active,
            onClick,
          },
          children,
        )
      }

      /**
       * The hover/focus panel: the selected display value, the next-turn
       * context estimate, the continue/fresh split, and (when pinned) the
       * display switch and thresholds.
       */
      function Panel({
        estimate,
        turnsLabel,
        settings,
        priceSource,
        holidaySource,
        tariffTime,
        t,
        pinned,
        onUnpin,
        onMetric,
        onThreshold,
        onReset,
        onMouseEnter,
        onMouseLeave,
      }) {
        const metricLabel = settings.metric === 'cost' ? t('settings.cost') : t('settings.turns')
        const green = settings.metric === 'cost' ? settings.costGreen : settings.turnsGreen
        const yellow = settings.metric === 'cost' ? settings.costYellow : settings.turnsYellow
        const greenText =
          settings.metric === 'cost'
            ? formatCny(green)
            : `${Math.round(green)} ${t('settings.unitTurns')}`
        const yellowText =
          settings.metric === 'cost'
            ? formatCny(yellow)
            : `${Math.round(yellow)} ${t('settings.unitTurns')}`
        const current =
          settings.metric === 'cost'
            ? estimate.priced && estimate.extraCny !== undefined
              ? `≈ ${formatCost(estimate.extraCny)}`
              : '—'
            : turnsLabel
        const tariff = estimate.peak ? t('tariff.peak') : t('tariff.off')
        const modelText =
          estimate.model === undefined
            ? t('panel.noModel')
            : estimate.priced
              ? `${estimate.model} · ${tariff}`
              : estimate.model

        const rows = [
          h(Line, { key: 'turns', label: t('panel.turns'), value: turnsLabel }),
          h(Line, {
            key: 'extra',
            label: t('panel.extra'),
            value:
              estimate.priced && estimate.extraCny !== undefined
                ? `≈ ${formatCost(estimate.extraCny)}`
                : '—',
            emphasis: true,
          }),
          h('div', { key: 'split', className: 'dshTurnCost_divider' }),
          h(Line, {
            key: 'continue',
            label: t('panel.continue'),
            value: estimate.totalCny === undefined ? '—' : `≈ ${formatCost(estimate.totalCny)}`,
          }),
          h(Line, {
            key: 'fresh',
            label: t('panel.fresh'),
            value: estimate.freshCny === undefined ? '—' : `≈ ${formatCost(estimate.freshCny)}`,
          }),
          h('div', { key: 'factDivider', className: 'dshTurnCost_divider' }),
          h(Line, {
            key: 'history',
            label: t('panel.history'),
            value: estimate.hasContext ? `≈ ${formatTokens(estimate.historyTokens)} ${t('panel.tokens')}` : '—',
          }),
          h(Line, {
            key: 'prompt',
            label: t('panel.prompt'),
            value: estimate.hasContext ? `${formatTokens(estimate.promptTokens)} ${t('panel.tokens')}` : '—',
          }),
          h(Line, {
            key: 'rate',
            label: estimate.measured ? t('panel.rateMeasured') : t('panel.rateReference'),
            value: estimate.rate === undefined ? '—' : `${formatRate(estimate.rate)} ${t('panel.perMillion')}`,
          }),
          h(Line, { key: 'model', label: t('panel.model'), value: modelText }),
          h(Line, {
            key: 'tariff',
            label: t('panel.tariff'),
            value: `${tariff} · ${t('panel.beijingTime')} ${tariffTime}`,
          }),
          h('div', { key: 'tariffRule', className: 'dshTurnCost_note' }, t('panel.tariffRule')),
          h(Line, {
            key: 'priceSource',
            label: t('panel.priceTable'),
            value:
              priceSource === 'online'
                ? t('panel.priceOnline')
                : priceSource === 'cache'
                  ? t('panel.priceCache')
                  : t('panel.priceBuiltin'),
          }),
          h(Line, {
            key: 'holidaySource',
            label: t('panel.holidayTable'),
            value:
              holidaySource === 'online'
                ? t('panel.holidayOnline')
                : holidaySource === 'cache'
                  ? t('panel.holidayCache')
                  : t('panel.holidayBuiltin'),
          }),
        ]

        const displaySwitch = pinned
          ? h(
              'div',
              { className: 'dshTurnCost_displayRow' },
              h('span', { className: 'dshTurnCost_displayLabel' }, t('panel.colorBy')),
              h(
                'div',
                { className: 'dshTurnCost_seg', role: 'group', 'aria-label': t('panel.colorBy') },
                h(
                  MetricButton,
                  {
                    active: settings.metric === 'turns',
                    onClick: () => {
                      onMetric('turns')
                    },
                  },
                  t('settings.turns'),
                ),
                h(
                  MetricButton,
                  {
                    active: settings.metric === 'cost',
                    onClick: () => {
                      onMetric('cost')
                    },
                  },
                  t('settings.cost'),
                ),
              ),
            )
          : null

        const settingsBlock = pinned
          ? h(
              'div',
              { className: 'dshTurnCost_settings' },
              h('div', { className: 'dshTurnCost_settingsTitle' }, t('settings.title')),
              h(NumberField, {
                key: `green-${settings.metric}`,
                label: t('settings.green'),
                value: green,
                unit: settings.metric === 'cost' ? t('settings.unitCost') : t('settings.unitTurns'),
                metric: settings.metric,
                onCommit: (value) => {
                  onThreshold('green', value)
                },
              }),
              h(NumberField, {
                key: `yellow-${settings.metric}`,
                label: t('settings.yellow'),
                value: yellow,
                unit: settings.metric === 'cost' ? t('settings.unitCost') : t('settings.unitTurns'),
                metric: settings.metric,
                onCommit: (value) => {
                  onThreshold('yellow', value)
                },
              }),
              h(
                'div',
                { className: 'dshTurnCost_settingsFoot' },
                h('span', null, t('settings.hint')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshTurnCost_reset',
                    onClick: onReset,
                  },
                  t('settings.reset'),
                ),
              ),
            )
          : null

        return h(
          'div',
          {
            className: 'dshTurnCost_panel',
            id: 'dsh-turn-cost-detail',
            role: pinned ? 'dialog' : 'tooltip',
            'aria-label': t('chip.title'),
            'data-pinned': pinned ? 'true' : 'false',
            onMouseEnter,
            onMouseLeave,
          },
          h(
            'div',
            { className: 'dshTurnCost_header' },
            h('span', { className: 'dshTurnCost_headerTitle' }, t('panel.title')),
            pinned
              ? h(
                  'button',
                  { type: 'button', className: 'dshTurnCost_unpin', onClick: onUnpin },
                  t('settings.unpin'),
                )
              : null,
          ),
          displaySwitch,
          ...rows,
          estimate.hasContext
            ? !estimate.priced && estimate.model !== undefined
              ? h('div', { className: 'dshTurnCost_note dshTurnCost_alert' }, t('panel.noPrice'))
              : null
            : h('div', { className: 'dshTurnCost_note dshTurnCost_alert' }, t('panel.noContext')),
          estimate.hasContext && estimate.priced && !estimate.hasUsage
            ? h('div', { className: 'dshTurnCost_note' }, t('panel.waiting'))
            : null,
          h(
            'div',
            { className: 'dshTurnCost_stage' },
            h(Line, { label: t('panel.colorBy'), value: metricLabel }),
            h(Line, { label: t('panel.current'), value: current }),
            h(
              'div',
              { className: 'dshTurnCost_stageText' },
              `${t('panel.leq')}${greenText} ${t('tone.green')} · ${t('panel.leq')}${yellowText} ${t(
                'tone.yellow',
              )} · ${t('panel.gt')}${yellowText} ${t('tone.red')}`,
            ),
          ),
          h('div', { className: 'dshTurnCost_note' }, t('panel.note')),
          pinned ? settingsBlock : h('div', { className: 'dshTurnCost_pinHint' }, t('settings.pinHint')),
        )
      }

      /**
       * Compact chip plus its hover panel. Clicking the chip pins the panel so
       * the threshold fields can receive pointer and keyboard input.
       */
      function TurnCostChip({ useProjection, t }) {
        const settings = useSettings()
        const priceInfo = usePrices()
        const holidayInfo = useHolidays()
        const [hovered, setHovered] = useState(false)
        const [pinned, setPinned] = useState(false)
        const [focusWithin, setFocusWithin] = useState(false)
        const [, setClock] = useState(0)
        const anchorRef = useRef(null)
        const chipRef = useRef(null)
        const closeTimer = useRef(0)
        const suppressFocus = useRef(false)

        useEffect(
          () => () => {
            if (closeTimer.current !== 0) window.clearTimeout(closeTimer.current)
          },
          [],
        )

        const dismiss = () => {
          if (closeTimer.current !== 0) {
            window.clearTimeout(closeTimer.current)
            closeTimer.current = 0
          }
          setPinned(false)
          setHovered(false)
          setFocusWithin(false)
          const chip = chipRef.current
          if (chip !== null && document.activeElement !== chip) {
            suppressFocus.current = true
            chip.focus()
          }
        }

        useEffect(() => {
          if (!pinned) return undefined
          const onPointerDown = (event) => {
            const anchor = anchorRef.current
            if (anchor !== null && !anchor.contains(event.target)) {
              setPinned(false)
              setHovered(false)
              setFocusWithin(false)
            }
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') dismiss()
          }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [pinned])

        const cancelClose = () => {
          if (closeTimer.current !== 0) {
            window.clearTimeout(closeTimer.current)
            closeTimer.current = 0
          }
          if (priceInfo.source !== 'online') void refreshPrices()
          if (holidayInfo.source !== 'online') void refreshHolidays()
          setHovered(true)
        }
        const scheduleClose = () => {
          if (closeTimer.current !== 0) window.clearTimeout(closeTimer.current)
          closeTimer.current = window.setTimeout(() => {
            closeTimer.current = 0
            setHovered(false)
          }, 240)
        }

        const useP = typeof useProjection === 'function' ? useProjection : () => undefined
        const stats = useP('sessionStats')
        const usage = useP('tokenUsage')
        const breakdown = useP('contextBreakdown')
        const pressure = useP('contextPressure')
        const selection = useP('modelSelection')

        const rawTurns = stats?.turns
        const turns = typeof rawTurns === 'number' && Number.isFinite(rawTurns) && rawTurns >= 0 ? Math.floor(rawTurns) : 0
        const now = new Date()
        const peak = isPeakTariff(now)
        let tariffTime = ''
        try {
          tariffTime = beijingClock(now).timeKey
        } catch {
          tariffTime = ''
        }
        const estimate = estimateNextTurn({ usage, breakdown, pressure, selection, peak })
        const tone = toneOf(settings, turns, estimate, stats !== undefined)
        const open = hovered || pinned || focusWithin
        /**
         * Keep the displayed tariff honest without polling blindly: wake up at
         * the exact next change (window edge or midnight, so weekends and
         * holidays flip too), fall back to a 30 s poll, and recompute as soon
         * as the window is visible again after sleep, minimise or a background
         * tab — the case where a stale "谷价" used to survive into peak hours.
         */
        useEffect(() => {
          let timer = 0
          let disposed = false
          const schedule = () => {
            if (disposed) return
            if (timer !== 0) window.clearTimeout(timer)
            const delay = Math.min(30_000, Math.max(500, msUntilNextTariffChange() + 400))
            timer = window.setTimeout(() => {
              if (disposed) return
              setClock((value) => value + 1)
              schedule()
            }, delay)
          }
          const refreshNow = () => {
            setClock((value) => value + 1)
            schedule()
          }
          const onVisibility = () => {
            if (document.visibilityState === 'visible') refreshNow()
          }
          document.addEventListener('visibilitychange', onVisibility)
          window.addEventListener('focus', refreshNow)
          window.addEventListener('pageshow', refreshNow)
          schedule()
          return () => {
            disposed = true
            if (timer !== 0) window.clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('focus', refreshNow)
            window.removeEventListener('pageshow', refreshNow)
          }
        }, [])
        const turnsLabel = stats === undefined ? t('chip.turnsLoading') : `${turns} ${t('chip.unit')}`
        const costLabel =
          estimate.hasContext && estimate.priced && estimate.extraCny !== undefined
            ? `≈ ${formatCost(estimate.extraCny)}`
            : t('chip.costUnknown')
        const valueLabel = settings.metric === 'cost' ? costLabel : turnsLabel
        const toneText =
          tone === 'green'
            ? t('tone.green')
            : tone === 'yellow'
              ? t('tone.yellow')
              : tone === 'red'
                ? t('tone.red')
                : t('tone.idle')
        const basisLabel = settings.metric === 'cost' ? t('settings.cost') : t('settings.turns')
        const tariffLabel = peak ? t('tariff.peak') : t('tariff.off')
        const tariffBadge = peak ? t('tariff.peakShort') : t('tariff.offShort')
        const summary = `${t('chip.title')} · ${valueLabel} · ${tariffLabel} · ${t('panel.colorBy')}: ${basisLabel} (${toneText}) · ${t('chip.pinHint')}`

        const updateMetric = (metric) => {
          publishSettings({ ...settings, metric })
        }
        const updateThreshold = (field, value) => {
          if (settings.metric === 'cost') {
            if (field === 'green') {
              publishSettings({
                ...settings,
                costGreen: value,
                costYellow: Math.max(settings.costYellow, value),
              })
            } else {
              publishSettings({
                ...settings,
                costYellow: Math.max(settings.costGreen, value),
              })
            }
          } else if (field === 'green') {
            publishSettings({
              ...settings,
              turnsGreen: value,
              turnsYellow: Math.max(settings.turnsYellow, value),
            })
          } else {
            publishSettings({
              ...settings,
              turnsYellow: Math.max(settings.turnsGreen, value),
            })
          }
        }
        const resetSettings = () => {
          publishSettings({ ...DEFAULT_SETTINGS, metric: settings.metric })
        }

        return h(
          'span',
          {
            ref: anchorRef,
            className: 'dshTurnCost_anchor',
            onMouseEnter: cancelClose,
            onMouseLeave: scheduleClose,
            onFocusCapture: () => {
              if (suppressFocus.current) {
                suppressFocus.current = false
                return
              }
              setFocusWithin(true)
              cancelClose()
            },
            onBlurCapture: (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false)
            },
            onKeyDown: (event) => {
              if (event.key === 'Escape') dismiss()
            },
          },
          h(StyleTag, { key: 'style' }),
          h(
            'span',
            {
              key: 'chip',
              className: 'dshTurnCost_chip',
              'data-tone': tone,
            },
            h(
              'button',
              {
                ref: chipRef,
                type: 'button',
                className: 'dshTurnCost_main',
                title: summary,
                'aria-label': summary,
                'aria-expanded': open,
                'aria-controls': open ? 'dsh-turn-cost-detail' : undefined,
                'aria-describedby': open ? 'dsh-turn-cost-detail' : undefined,
                onClick: () => {
                  if (pinned) {
                    dismiss()
                  } else {
                    setPinned(true)
                    cancelClose()
                  }
                },
              },
              h('span', { className: 'dshTurnCost_dot', 'aria-hidden': true }),
              h('span', { className: 'dshTurnCost_amount' }, valueLabel),
              h(
                'span',
                {
                  className: 'dshTurnCost_tariff',
                  'data-tariff': peak ? 'peak' : 'off',
                  'aria-hidden': true,
                },
                tariffBadge,
              ),
            ),
          ),
          open
            ? h(Panel, {
                key: 'panel',
                estimate,
                turnsLabel,
                settings,
                priceSource: priceInfo.source,
                holidaySource: holidayInfo.source,
                tariffTime,
                t,
                pinned,
                onUnpin: dismiss,
                onMetric: updateMetric,
                onThreshold: updateThreshold,
                onReset: resetSettings,
                onMouseEnter: cancelClose,
                onMouseLeave: scheduleClose,
              })
            : null,
        )
      }

      const inject = ['slots', 'locale']

      /** @param ctx - the page plugin's context (slots, locale, effects). */
      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'dsh-continue-cost: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'dsh-continue-cost: en dictionary')
        const t = ctx.locale.bind(NS)

        /* Thresholds are shared through localStorage, so a second window or tab
         * picks up a change without a reload. Echo suppression comes from
         * comparing the normalized value before writing again. */
        ctx.effect(() => {
          const onStorage = (event) => {
            if (event.key !== STORAGE_KEY) return
            let parsed
            try {
              parsed = event.newValue === null ? undefined : JSON.parse(event.newValue)
            } catch {
              return
            }
            const next = normalizeSettings(parsed)
            if (JSON.stringify(next) === JSON.stringify(getSettings())) return
            publishSettings(next)
          }
          window.addEventListener('storage', onStorage)
          return () => {
            window.removeEventListener('storage', onStorage)
          }
        }, 'dsh-continue-cost: threshold sync')

        ctx.effect(() => {
          void refreshPrices()
          void refreshHolidays()
          const timer = window.setInterval(() => {
            void refreshPrices()
            void refreshHolidays()
          }, 24 * 60 * 60 * 1000)
          return () => {
            window.clearInterval(timer)
          }
        }, 'dsh-continue-cost: official price and holiday refresh')

        ctx.slots.inject('conversation.input.right', function* () {
          yield ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'turn-cost-meter',
              order: 21,
              label: () => t('chip.title'),
              inject: () => ({ t }),
            },
            TurnCostChip,
          )
        })
      }

      module.exports = { apply, inject, name: NAME }
      return module.exports
    }
  }

  window.__ModuleLoader__.load({
    id: NAME,
    factory: makeFactory(),
  })
})()
