# dsh-continue-cost · 对话轮数与续聊差价

> DeepSeek Harness（DSH）插件：在输入框右侧显示**已完成的对话轮数**，或者——**继续这次对话比新开一次要多花多少钱**。

大多数费用插件回答的是“已经花了多少”。这个插件回答的是“**下一步该不该开新对话**”：续聊会把历史上下文再传一遍，这笔钱是可以省下来的，省多少取决于历史 token、缓存命中率和当前峰谷价。

## 为什么是它，而不是又一个费用计

| | 常见费用插件 | 本插件 |
|---|---|---|
| 口径 | 已经发生的花费 | 下一轮**继续 vs 新开**的差额 |
| 用途 | 看账单 | 做决定（要不要开新对话） |
| 展示 | 金额、明细、余额 | 一个胶囊 + 三色阈值（轮数或金额） |

差额是纯增量信息，和已有的费用统计插件共存不冲突。

## 两个数字到底是什么

胶囊显示二选一，点开面板顶部可以切换。

**对话轮数**

`12 轮` —— 这个会话里**已经完成**的问答轮次。进行中的那一轮要等回答结束、日志落盘后才 +1，所以刚发问时数字不变是正常的。

**续聊差价**

`≈ ¥0.0076` —— **继续当前对话**，比**新开一个对话**，下一轮请求要多花多少钱。

### 为什么会有差价

每次对话，模型都要重新读一遍上下文：系统提示、工具 schema、以及之前所有对话消息。开新对话时系统提示和工具还在，**历史消息不再携带**；续聊则要为这些历史消息再付一次输入费（命中缓存的部分便宜很多）。

所以差价只跟历史消息有关：

```text
差价 ≈ 历史上下文 token × 每 token 平均单价
平均单价 = 缓存命中比例 × 命中价 + 未命中比例 × 未命中价（按当前峰谷价）
```

回答本身的费用在两种做法下一样，所以不计入。举例：历史消息 6 万 token、本会话约 97% 命中缓存、谷时 `deepseek-flash` 输入价 0.02 / 1 元每百万，差价约 6 万 × 0.023 ≈ **¥0.0014**；峰时或缓存命中率低时会明显更高。实际以账户扣费为准。

### 面板里还有什么

悬停胶囊：

- 已完成轮数、差额（继续 − 新开）
- 继续当前对话（下一轮上下文）费用、新开对话（同一轮上下文）费用
- 历史上下文、下一轮上下文预计、本会话平均 token 单价、计价模型（含峰/谷标注）
- **当前时段：峰时 / 谷时 + 计算所用的北京时间**，下面一行写明官方峰谷规则
- 价格表来源、节假日表来源（官方在线 / 本地缓存 / 内置）

点击胶囊固定面板：顶部切换「对话轮数 / 多花金额」，下方设置绿色上限、黄色上限；「恢复默认」回到 5 / 10 轮、¥0.05 / ¥0.15。阈值存在 `localStorage`。

圆点在数值前面，按当前显示值着色：不超过绿色上限为绿，不超过黄色上限为黄，超过为红。峰谷切换不再依赖“正好赶上一次轮询”：跨过 09:00 / 12:00 / 14:00 / 18:00 或零点时会立即重算，最多 30 秒兜底；窗口从睡眠、最小化或后台恢复时也会马上重算。

## 峰谷自动切换

官方口径（价格页原文）：**北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00 为高峰时段，其余时段——包括 12:00–14:00 午间、周末和法定节假日全天——都是空闲时段**；空闲时段价格是高峰时段的一半。

插件按这个规则自动切换：

| 时间（北京时间） | 时段 | 胶囊上的标记 |
|---|---|---|
| 周一至周五 09:00–12:00、14:00–18:00 | 峰时（价格 ×2） | 峰 |
| 周一至周五 12:00–14:00 | 谷时 | 谷 |
| 周末、调休上班周末、法定节假日全天 | 谷时 | 谷 |

- **胶囊上直接标「峰/谷」**，不用悬停也能看出当前按哪档计价。
- 面板「当前时段」一行同时给出北京时间（如 `峰时 · 北京时间 14:23`），方便核对是不是时钟/时区问题。
- 切换是精确到边界的：09:00、12:00、14:00、18:00 和零点都会重算；`focus` / `visibilitychange` / `pageshow` 也会触发一次，所以睡眠唤醒、最小化恢复后不会沿用旧价。
- 判断用的是「当前时刻换算成 UTC+8 后读时钟」，与浏览器/系统时区无关；系统时间本身错了才会算错。

## 估算口径

价格单位：CNY / 百万 token。

```text
历史 token ≈ provider 锚定的下一轮上下文总量 × 历史消息占比
继续费用 ≈ 下一轮上下文 token / 1,000,000 × 平均 token 单价
新开费用 ≈ (下一轮上下文 token − 历史 token) / 1,000,000 × 平均 token 单价
差额 ≈ 历史 token / 1,000,000 × 平均 token 单价
```

- 平均 token 单价按本会话累计 `tokenUsage` 的缓存命中/未命中比例，套用当前时段官方单价。
- 回答本身在两种做法下费用相同，不计入差额；只比较输入侧。
- 峰时：北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00；其余时段、周末、调休上班周末、法定节假日全天为谷时（见上一节）。
- 下一轮上下文取 `contextPressure.projectedTokens`（缺失时退回 `pressureTokens`），历史消息占比取 `contextBreakdown`；两者都没有时显示「上下文数据还没准备好」，而不是硬猜。
- 跨过峰谷边界会在半秒内自动更新，另有 30 秒轮询兜底。

## 安装

需要 DSH 桌面版 0.2.x（在 0.2.2-rc.3 上验证）。三种方式任选：

**1. 本地文件夹（推荐给朋友之间分享）**

1. 下载 `dsh-continue-cost-1.3.0.zip` 并解压，得到 `dsh-continue-cost` 文件夹，放到固定位置。
2. DSH：**设置 → 插件 → 添加插件**，选择这个包含 `package.json` 的文件夹。
3. **完全退出 DSH 再打开**（Host 端的价格/节假日路由要重启才挂载）。

**2. npm（发布后可用）**

在 DSH 里用插件管理器安装：`plugin_manager` 的 `install_bundle`，target 填 `dsh-continue-cost@1.3.0`；如果这台 DSH 自带 `dsh` 命令，也可以 `dsh plugin add dsh-continue-cost`（profile 名按你的安装，桌面版一般是 `desktop`）。

**3. GitHub Release**：从 Releases 下载 zip，按方式 1 安装。

更新：替换文件夹内容（保持路径不变）或在插件管理里升级，然后重启 DSH。

## 数据来源与网络行为

- 价格表：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md>，Host 端解析模型列与峰谷价，缓存 6 小时；客户端启动时和每 24 小时刷新一次。
- 节假日：优先使用已知的国务院通知 URL（2026、2027），其次政府网“最新文件”页，最后 Bing RSS 的 `site:gov.cn` 结果；固定文本解析，不调用大模型；Host 缓存一天。
- 两个 Host 路由：`/plugins/dsh-continue-cost/prices`、`/plugins/dsh-continue-cost/holidays`。
- 网络失败回退到 `localStorage` 里的上次成功结果，再回退到内置表，估算照常可用。

## 隐私

- 不上传会话内容、token 用量、API Key。
- 只请求上面的公开页面和本机 DSH 路由。
- 阈值和缓存只存在本机浏览器的 `localStorage`（桌面版 origin 为 `dsh-app://app`，改端口不丢）。

## 兼容性

- DSH 桌面版 0.2.x（验证于 0.2.2-rc.3）；Web 版同版本亦可。
- 无原生依赖、无构建步骤，纯 ES module + browser factory。
- 依赖的投影：`sessionStats`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`modelSelection`；缺少某个时退化为可用字段或显示未知。

## 限制

- 历史 token 占比是按 `contextBreakdown` 缩放到 provider 锚定总量的启发式，不是精确分桶。
- 平均单价按整个会话累计缓存比例，下一轮缓存状态变化会让实际值偏离。
- 中途切换模型时累计用量按当前模型价格折算。
- 节假日解析依赖 gov.cn 通知的固定文本结构；结构变化时回退缓存/内置。
- 已内置 2026 年表；2027 年表来自官方通知；更久远年份依赖自动发现。
- 峰谷按系统时钟换算成北京时间；系统时间本身错误时判断也会错，面板「当前时段」会显示所用的北京时间，便于核对。

## 开发

- `client.js` 是浏览器端（module factory，无构建），`host-1.2.0.js` 是 Host 端。
- DSH 会缓存 Host 模块：改 Host 时复制成新版本文件（如 `host-1.3.0.js`），改 `package.json` 的 `main`/`exports`/`files`，重启 DSH。
- 改包名时要同步：`client.js` 的 `NAME`/`NS` 与两个路由常量、`host-1.2.0.js` 的 `BASE_PATH`、`cordis.patch.yml` 的 `id`/`name`。
- 自检：`npm test`（12 个用例：峰谷边界、周末/节假日、跨边界自动切换、唤醒重算、alias 解析、Host 解析器）、`node --check client.js`、`node -e "import('./host-1.2.0.js')"`、重启后两个路由返回 `ok:true`。

## English

**dsh-continue-cost** is a DeepSeek Harness plugin that shows the completed turn count and, more importantly, the extra context cost of **continuing this conversation instead of starting a fresh one** — priced from the official peak/off-peak CNY table and the session's cache-hit mix. Most cost plugins report money already spent; this one helps you decide whether to start over. Badge thresholds (green/yellow/red) apply to turns or to the delta.

The chip carries a small **peak / off** badge that flips by itself at the official boundaries (09:00 / 12:00 / 14:00 / 18:00 Beijing on weekdays, and midnight for weekends and statutory holidays), and refreshes immediately when the window is restored after sleep or minimisation. The panel spells out the tariff in force together with the Beijing time it was derived from.

Install: unzip into a folder and add it from **Settings → Plugins → Add plugin**, then fully restart DSH.

## License

MIT
