/**
 * Head-less tests for `dsh-continue-cost`.
 *
 * There is no test runner, bundler or DOM in the package, so both halves are
 * exercised directly:
 *
 * 1. `client.js` is evaluated inside a tiny shim (localStorage, timers, a hook
 *    implementation and an element tree). The module's internals are exposed by
 *    rewriting the single `module.exports` line in memory — nothing on disk
 *    changes.
 * 2. `host-1.2.0.js` is imported as a normal ES module and its parsers are fed
 *    the real Markdown/HTML shapes they must accept, plus malformed input.
 *
 * Run with `npm test` (Node >= 20, no dependencies).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseHolidayNotice, parsePricing } from '../host-1.2.0.js'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const EXPORT_LINE = 'module.exports = { apply, inject, name: NAME }'
const EXPORT_WITH_TESTS = `module.exports = { apply, inject, name: NAME, __test: {
  isPeakTariff, isPeakAtClock, beijingClock, msUntilNextTariffChange, PEAK_WINDOWS,
  estimateNextTurn, pricingOf, PRICING, FETCHED_HOLIDAYS, mergeHolidayDates, isChineseHoliday,
} }`

if (!CLIENT_SOURCE.includes(EXPORT_LINE)) {
  throw new Error('client.js no longer exports the shape these tests rewrite; update the test')
}
const INSTRUMENTED_SOURCE = CLIENT_SOURCE.replace(EXPORT_LINE, EXPORT_WITH_TESTS)

/** Beijing wall-clock time as an epoch instant. */
function bj(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

/**
 * Evaluate the instrumented client bundle against a minimal browser shim.
 * @param initialNow - fake wall clock in epoch milliseconds.
 * @param react - hook implementation the bundle must capture at factory time.
 * @returns the module, the fake window, and helpers to move time and run timers.
 */
function loadClient(initialNow = bj(2026, 11, 23, 10, 0), react = null) {
  let now = initialNow
  let timerId = 0
  const timeouts = new Map()
  const intervals = new Map()
  const storage = new Map()
  const documentListeners = new Map()
  const windowListeners = new Map()

  const addListener = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, new Set())
    map.get(type).add(fn)
  }
  const removeListener = (map) => (type, fn) => {
    map.get(type)?.delete(fn)
  }

  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    __ModuleLoader__: { load: (entry) => { window.loaded = entry } },
    setTimeout: (fn) => { timerId += 1; timeouts.set(timerId, fn); return timerId },
    clearTimeout: (id) => { timeouts.delete(id) },
    setInterval: (fn) => { timerId += 1; intervals.set(timerId, fn); return timerId },
    clearInterval: (id) => { intervals.delete(id) },
    addEventListener: addListener(windowListeners),
    removeEventListener: removeListener(windowListeners),
  }
  const document = {
    visibilityState: 'visible',
    addEventListener: addListener(documentListeners),
    removeEventListener: removeListener(documentListeners),
  }

  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now)
      else super(...args)
    }
    static now() { return now }
  }

  const fetchBefore = globalThis.fetch
  globalThis.Date = FakeDate
  globalThis.fetch = async () => { throw new Error('offline in tests') }
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'navigator', INSTRUMENTED_SOURCE)(window, document, {})
  } finally {
    globalThis.Date = RealDate
    if (fetchBefore === undefined) delete globalThis.fetch
    else globalThis.fetch = fetchBefore
  }

  const reactShim = react ?? {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }

  const module = window.loaded.factory((name) => {
    if (name === 'react') return reactShim
    throw new Error(`unexpected require ${name}`)
  })

  return {
    module,
    internals: module.__test,
    window,
    document,
    storage,
    react: reactShim,
    /** Move the fake clock without running anything. */
    setNow(ms) { now = ms },
    /** Run every pending timeout once (the chip's tariff refresh chain). */
    runTimeouts() {
      const pending = [...timeouts.values()]
      timeouts.clear()
      for (const fn of pending) fn()
    },
    dispatch(type, target = 'window') {
      const map = target === 'document' ? documentListeners : windowListeners
      for (const fn of map.get(type) ?? []) fn({ type, key: null, newValue: null })
    },
  }
}

// ---------------------------------------------------------------------------
// React shim used by the render tests
// ---------------------------------------------------------------------------

/**
 * Minimal hook implementation: one slot array per mounted component (keyed by
 * its position in the tree), effects flushed after every commit, a setState
 * mark per render round.
 */
function createReactShim() {
  const instances = new Map()
  const effects = []
  let frame = null
  let dirty = false
  let tree = null

  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initial) => {
      const slotIndex = frame.index++
      if (!(slotIndex in frame.hooks)) {
        frame.hooks[slotIndex] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = frame.hooks[slotIndex]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useEffect: (fn, deps) => {
      const slotIndex = frame.index++
      const slot = (frame.hooks[slotIndex] ??= { deps: undefined })
      const changed = slot.deps === undefined || deps === undefined
        || deps.length !== slot.deps.length
        || deps.some((value, index) => !Object.is(value, slot.deps[index]))
      if (changed) {
        slot.deps = deps
        effects.push(fn)
      }
    },
    useRef: (initial) => {
      const slotIndex = frame.index++
      if (!(slotIndex in frame.hooks)) frame.hooks[slotIndex] = { value: { current: initial } }
      return frame.hooks[slotIndex].value
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }

  const expand = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}.${index}`))
    if (typeof node.type === 'function') {
      const id = `${path}:${node.type.name}`
      let slot = instances.get(id)
      if (slot === undefined) {
        slot = { index: 0, hooks: [] }
        instances.set(id, slot)
      }
      slot.index = 0
      const saved = frame
      frame = slot
      try {
        return expand(node.type(node.props), `${path}.r`)
      } finally {
        frame = saved
      }
    }
    return { type: node.type, props: node.props, children: expand(node.props.children, `${path}.c`) }
  }

  return {
    react,
    render(component, props) {
      for (let round = 0; round < 25; round += 1) {
        dirty = false
        effects.length = 0
        tree = expand({ type: component, props }, 'root')
        const pending = effects.splice(0)
        for (const fn of pending) fn()
        if (!dirty) return tree
      }
      throw new Error('render did not settle')
    },
    get tree() { return tree },
  }
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (node.children !== undefined) textOf(node.children, out)
  return out
}

function findByClass(node, className, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) findByClass(child, className, out); return out }
  if (typeof node !== 'object') return out
  if (node.props?.className === className) out.push(node)
  if (node.children !== undefined) findByClass(node.children, className, out)
  return out
}

const ZH = {
  'chip.title': '对话轮数与续聊差价', 'chip.unit': '轮', 'chip.turnsLoading': '轮数 …',
  'chip.costUnknown': '¥ —', 'chip.pinHint': '',
  'panel.title': '续聊差价估算', 'panel.turns': '已完成轮数', 'panel.extra': '差额（继续 − 新开）',
  'panel.continue': '继续当前对话（下一轮上下文）', 'panel.fresh': '新开对话（同一轮上下文）',
  'panel.history': '历史上下文', 'panel.prompt': '下一轮上下文预计', 'panel.tokens': 'tokens',
  'panel.rateMeasured': '本会话平均 token 单价', 'panel.rateReference': '参考 token 单价（未命中缓存）',
  'panel.model': '计价模型', 'panel.noModel': '未选择模型', 'panel.priceTable': '价格表',
  'panel.priceOnline': '官方在线', 'panel.priceCache': '本地缓存', 'panel.priceBuiltin': '内置',
  'panel.holidayTable': '节假日表', 'panel.holidayOnline': '官方在线', 'panel.holidayCache': '本地缓存',
  'panel.holidayBuiltin': '内置', 'panel.perMillion': '/ 百万 tokens', 'panel.tariff': '当前时段',
  'panel.tariffRule': '工作日北京时间 9:00–12:00、14:00–18:00 为峰时。',
  'panel.beijingTime': '北京时间', 'panel.noPrice': '未收录该模型价格', 'panel.noContext': '上下文未就绪。',
  'panel.waiting': '还没有用量。', 'panel.note': '', 'panel.colorBy': '显示与着色', 'panel.current': '当前显示值',
  'panel.leq': '≤', 'panel.gt': '>',
  'tone.green': '绿', 'tone.yellow': '黄', 'tone.red': '红', 'tone.idle': '等待数据',
  'tariff.peak': '峰时', 'tariff.off': '谷时', 'tariff.peakShort': '峰', 'tariff.offShort': '谷',
  'settings.title': '阈值设置', 'settings.turns': '对话轮数', 'settings.cost': '多花金额',
  'settings.green': '绿色上限', 'settings.yellow': '黄色上限', 'settings.unitTurns': '轮',
  'settings.unitCost': '元', 'settings.hint': '', 'settings.reset': '恢复默认', 'settings.unpin': '收起',
  'settings.pinHint': '',
}

/** Render the registered chip with sample projections and return helpers. */
function mountChip(initialNow) {
  const shim = createReactShim()
  const loaded = loadClient(initialNow, shim.react)
  const t = (key) => ZH[key] ?? key
  const data = {
    sessionStats: { turns: 12 },
    tokenUsage: { cacheReadTokens: 970_000, uncachedInputTokens: 20_000, cacheWriteTokens: 10_000 },
    contextBreakdown: { systemTokens: 2_000, toolsTokens: 30_000, messageTokens: 60_000 },
    contextPressure: { projectedTokens: 98_000 },
    modelSelection: { next: { model: 'deepseek-flash' } },
  }
  let component = null
  const previousDate = globalThis.Date
  // The component reads the clock through `new Date()`, so the fake clock stays
  // installed for the whole mount lifetime.
  const clock = { now: initialNow }
  globalThis.Date = class extends previousDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now)
      else super(...args)
    }
    static now() { return clock.now }
  }

  const ctx = {
    locale: { register: () => () => {}, bind: () => t },
    slots: {
      inject: (_slot, generator) => { for (const _ of generator()) { /* consume */ } },
      register: (_config, surface) => { component = surface },
    },
    effect: (fn) => fn(),
  }
  loaded.module.apply(ctx)

  const useProjection = (name) => data[name]
  const render = () => shim.render(component, { useProjection, t })
  const click = (className) => {
    const target = findByClass(shim.tree, className)[0]
    assert.ok(target !== undefined, `expected an element with class ${className}`)
    target.props.onClick()
  }
  const panelText = () => {
    const panel = findByClass(shim.tree, 'dshTurnCost_panel')[0]
    return panel === undefined ? '' : textOf(panel).join(' | ')
  }
  const chipText = () => textOf(findByClass(shim.tree, 'dshTurnCost_chip')[0]).join(' ').trim()

  loaded.setNow(initialNow)
  return {
    render,
    chipText,
    panelText,
    pin() { click('dshTurnCost_main'); render() },
    setNow(ms) { clock.now = ms },
    runTimeouts: loaded.runTimeouts,
    dispatch: loaded.dispatch,
    restore() { globalThis.Date = previousDate },
    internals: loaded.internals,
  }
}

// ---------------------------------------------------------------------------
// Tariff rules
// ---------------------------------------------------------------------------

test('peak tariff matches the official Beijing windows', () => {
  const { internals } = loadClient()
  const { isPeakTariff } = internals
  const cases = [
    ['Monday 08:59', bj(2026, 11, 23, 8, 59), false],
    ['Monday 09:00', bj(2026, 11, 23, 9, 0), true],
    ['Monday 11:59', bj(2026, 11, 23, 11, 59), true],
    ['Monday 12:00 midday break', bj(2026, 11, 23, 12, 0), false],
    ['Monday 13:59 midday break', bj(2026, 11, 23, 13, 59), false],
    ['Monday 14:00', bj(2026, 11, 23, 14, 0), true],
    ['Monday 17:59', bj(2026, 11, 23, 17, 59), true],
    ['Monday 18:00', bj(2026, 11, 23, 18, 0), false],
    ['Friday 10:00', bj(2026, 11, 27, 10, 0), true],
    ['Saturday 10:00', bj(2026, 11, 28, 10, 0), false],
    ['Sunday 15:00', bj(2026, 11, 29, 15, 0), false],
    ['Labour Day 2026 10:00', bj(2026, 5, 1, 10, 0), false],
    ['Spring Festival 2026 10:00', bj(2026, 2, 17, 10, 0), false],
    ['National Day 2026 15:00', bj(2026, 10, 5, 15, 0), false],
    ['New year 2027 10:00', bj(2027, 1, 1, 10, 0), false],
  ]
  for (const [label, ms, expected] of cases) {
    assert.equal(isPeakTariff(new Date(ms)), expected, label)
  }
})

test('fetched holiday dates make a weekday off-peak', () => {
  const { internals } = loadClient()
  // 2026-11-24 is a Tuesday; the Host-supplied calendar must take precedence.
  assert.equal(internals.isPeakTariff(new Date(bj(2026, 11, 24, 10, 0))), true)
  internals.mergeHolidayDates(['2026-11-24'])
  assert.equal(internals.isPeakTariff(new Date(bj(2026, 11, 24, 10, 0))), false)
})

test('the next tariff change lands on the exact boundary', () => {
  const { internals } = loadClient()
  const next = (ms) => internals.msUntilNextTariffChange(new Date(ms))
  const minutes = (ms) => Math.round(ms / 60_000)
  assert.equal(minutes(next(bj(2026, 11, 23, 8, 0))), 60, '08:00 waits for 09:00')
  assert.equal(minutes(next(bj(2026, 11, 23, 10, 0))), 120, '10:00 waits for 12:00')
  assert.equal(minutes(next(bj(2026, 11, 23, 12, 50))), 70, '12:50 waits for 14:00')
  assert.equal(minutes(next(bj(2026, 11, 23, 16, 0))), 120, '16:00 waits for 18:00')
  assert.equal(minutes(next(bj(2026, 11, 23, 20, 0))), 240, 'evening waits for midnight')
  assert.equal(minutes(next(bj(2026, 11, 27, 19, 0))), 300, 'Friday 19:00 waits for midnight')
  const afterBoundary = next(bj(2026, 11, 23, 9, 0) + 5_000)
  assert.ok(afterBoundary > 0 && afterBoundary <= 3 * 60 * 60 * 1000)
})

// ---------------------------------------------------------------------------
// Pricing lookup
// ---------------------------------------------------------------------------

test('model ids resolve with provider prefixes and retired aliases', () => {
  const { internals } = loadClient()
  const priced = (model) => internals.pricingOf({ next: { model } })
  assert.deepEqual(priced('deepseek-flash').off, { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  assert.deepEqual(priced('deepseek-official/deepseek-v4-pro').peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 })
  assert.deepEqual(priced('deepseek-v4-flash').off, { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    'retired alias maps to the current model')
  assert.equal(priced('deepseek-official/deepseek-v4-flash').off.cacheMiss, 1,
    'prefix plus alias still resolves')
  assert.equal(priced('deepseek-v4-flash-vision-exp').off.cacheHit, 0.02)
  assert.equal(priced('unknown-model'), undefined)
})

test('the same context costs exactly twice as much in peak', () => {
  const { internals } = loadClient()
  const params = {
    usage: { cacheReadTokens: 970_000, uncachedInputTokens: 20_000, cacheWriteTokens: 10_000 },
    breakdown: { systemTokens: 2_000, toolsTokens: 30_000, messageTokens: 60_000 },
    pressure: { projectedTokens: 98_000 },
    selection: { next: { model: 'deepseek-flash' } },
  }
  const peak = internals.estimateNextTurn({ ...params, peak: true })
  const off = internals.estimateNextTurn({ ...params, peak: false })
  assert.equal(peak.priced, true)
  assert.equal(peak.peak, true)
  assert.equal(off.peak, false)
  assert.ok(Math.abs(peak.rate / off.rate - 2) < 1e-9, 'peak rate doubles')
  assert.ok(Math.abs(peak.extraCny / off.extraCny - 2) < 1e-9, 'peak delta doubles')
})

// ---------------------------------------------------------------------------
// Rendered chip and panel
// ---------------------------------------------------------------------------

test('the chip and panel name the tariff in force', () => {
  const chip = mountChip(bj(2026, 11, 23, 10, 0))
  try {
    chip.render()
    chip.pin()
    assert.match(chip.chipText(), /峰/)
    const peakPanel = chip.panelText()
    assert.match(peakPanel, /deepseek-flash · 峰时/)
    assert.match(peakPanel, /当前时段 \| 峰时 · 北京时间 10:00/)
    assert.match(peakPanel, /工作日北京时间 9:00–12:00、14:00–18:00 为峰时/)

    chip.setNow(bj(2026, 11, 23, 12, 31))
    chip.runTimeouts()
    chip.render()
    assert.match(chip.chipText(), /谷/)
    const offPanel = chip.panelText()
    assert.match(offPanel, /deepseek-flash · 谷时/)
    assert.match(offPanel, /当前时段 \| 谷时 · 北京时间 12:31/)
  } finally {
    chip.restore()
  }
})

test('the chip switches by itself when the peak window opens', () => {
  const chip = mountChip(bj(2026, 11, 23, 8, 59))
  try {
    chip.render()
    chip.pin()
    assert.match(chip.panelText(), /谷时 · 北京时间 08:59/)

    // 09:00:05 — the scheduled timeout is due; no user interaction involved.
    chip.setNow(bj(2026, 11, 23, 9, 0) + 5_000)
    chip.runTimeouts()
    chip.render()
    assert.match(chip.chipText(), /峰/)
    assert.match(chip.panelText(), /峰时 · 北京时间 09:00/)
    assert.match(chip.panelText(), /≈ ¥0\.0063/)
  } finally {
    chip.restore()
  }
})

test('a window restored after sleep refreshes the tariff immediately', () => {
  const chip = mountChip(bj(2026, 11, 23, 8, 30))
  try {
    chip.render()
    chip.pin()
    assert.match(chip.panelText(), /谷时 · 北京时间 08:30/)

    // The machine slept through the boundary and no timer ran.
    chip.setNow(bj(2026, 11, 23, 15, 0))
    chip.dispatch('focus')
    chip.render()
    assert.match(chip.chipText(), /峰/)
    assert.match(chip.panelText(), /峰时 · 北京时间 15:00/)

    chip.setNow(bj(2026, 11, 23, 18, 30))
    chip.dispatch('visibilitychange', 'document')
    chip.render()
    assert.match(chip.panelText(), /谷时 · 北京时间 18:30/)
  } finally {
    chip.restore()
  }
})

// ---------------------------------------------------------------------------
// Host parsers
// ---------------------------------------------------------------------------

const PRICING_MARKDOWN = `# 模型 & 价格

| 模型 | 模型 | 模型 | deepseek-flash(1) | deepseek-v4-pro |
| --- | --- | --- | --- | --- |
| 价格(2) | 百万tokens输入 / （缓存命中） | 空闲时段 | 0.02元 | 0.15元 |
| 价格(2) | 百万tokens输入 / （缓存命中） | 高峰时段 | 0.04元 | 0.30元 |
| 价格(2) | 百万tokens输入 / （缓存未命中） | 空闲时段 | 1元 | 4.5元 |
| 价格(2) | 百万tokens输入 / （缓存未命中） | 高峰时段 | 2元 | 9.0元 |
| 价格(2) | 百万tokens输出 | 空闲时段 | 4元 | 13.5元 |
| 价格(2) | 百万tokens输出 | 高峰时段 | 8元 | 27.0元 |
`

test('the host parser keeps peak and off-peak prices apart', () => {
  const table = parsePricing(PRICING_MARKDOWN)
  assert.deepEqual(table['deepseek-flash'], {
    off: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  })
  assert.deepEqual(table['deepseek-v4-pro'], {
    off: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  })
})

test('the host parser refuses a table it cannot fully read', () => {
  assert.throws(
    () => parsePricing('| 模型 | deepseek-flash |\n| 价格 | 高峰时段 | $0.04 |'),
    /not in CNY/,
  )
  assert.throws(
    () => parsePricing('| 模型 | deepseek-flash |\n| 价格 | 高峰时段 | ¥0.04 |'),
    /incomplete pricing/,
  )
})

test('the holiday notice parser reads dates and ignores make-up workdays', () => {
  const notice = `经国务院批准，现将2026年元旦、春节、清明节、劳动节、端午节、中秋节、国庆节放假调休日期的具体安排通知如下。
元旦：1月1日至3日放假，共3天。
春节：2月15日至23日放假调休，共9天。2月14日（星期六）、2月28日（星期六）上班。
清明节：4月4日至6日放假，共3天。
劳动节：5月1日至5日放假调休，共5天。4月26日（星期日）上班。
端午节：6月19日至21日放假，共3天。
中秋节：9月25日至27日放假，共3天。
国庆节：10月1日至7日放假调休，共7天。9月27日（星期日）、10月10日（星期六）上班。`
  const dates = parseHolidayNotice(notice, 2026)
  assert.equal(dates.length, 33)
  assert.ok(dates.includes('2026-02-15'))
  assert.ok(dates.includes('2026-02-23'))
  assert.ok(!dates.includes('2026-02-14'), 'make-up Saturday is not a holiday')
  assert.ok(!dates.includes('2026-10-10'))
  assert.deepEqual(dates, [...dates].sort())
})

test('the holiday notice parser rejects a page without dates', () => {
  assert.throws(() => parseHolidayNotice('<p>今日要闻</p>', 2026), /no readable dates/)
})
