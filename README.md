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

## 显示什么

胶囊在 `conversation.input.right`，紧邻余额胶囊：

- **对话轮数**：`12 轮`（只统计已完成的轮次）
- **多花金额**：`≈ ¥0.0076`（继续这次对话比新开一次多出来的上下文费用）
- 圆点在数值前面，按当前显示值和阈值着色：绿 / 黄 / 红

悬停胶囊弹出面板：

- 已完成轮数、差额（继续 − 新开）
- 继续当前对话（下一轮上下文）费用、新开对话（同一轮上下文）费用
- 历史上下文、下一轮上下文预计、本会话平均 token 单价、计价模型（含峰/谷标注）
- 价格表来源、节假日表来源（官方在线 / 本地缓存 / 内置）

点击胶囊固定面板，顶部可切换「对话轮数 / 多花金额」，下方设置绿色上限、黄色上限；「恢复默认」回到 5 / 10 轮、¥0.05 / ¥0.15。阈值存 `localStorage`。

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
- 峰时：北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00；其余时段、周末、调休上班周末、法定节假日全天为谷时。
- 下一轮上下文取 `contextPressure.projectedTokens`（缺失时退回 `pressureTokens`），历史消息占比取 `contextBreakdown`；两者都没有时显示「上下文数据还没准备好」，而不是硬猜。
- 每 30 秒重算一次，跨过峰谷边界会自动更新。

## 安装

需要 DSH 桌面版 0.2.x（在 0.2.2-rc.3 上验证）。三种方式任选：

**1. 本地文件夹（推荐给朋友之间分享）**

1. 下载 `dsh-continue-cost-1.2.0.zip` 并解压，得到 `dsh-continue-cost` 文件夹，放到固定位置。
2. DSH：**设置 → 插件 → 添加插件**，选择这个包含 `package.json` 的文件夹。
3. **完全退出 DSH 再打开**（Host 端的价格/节假日路由要重启才挂载）。

**2. npm（发布后可用）**

在 DSH 里用插件管理器安装：`plugin_manager` 的 `install_bundle`，target 填 `dsh-continue-cost@1.2.0`；如果这台 DSH 自带 `dsh` 命令，也可以 `dsh plugin add dsh-continue-cost`（profile 名按你的安装，桌面版一般是 `desktop`）。

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

## 开发

- `client.js` 是浏览器端（module factory，无构建），`host-1.2.0.js` 是 Host 端。
- DSH 会缓存 Host 模块：改 Host 时复制成新版本文件（如 `host-1.3.0.js`），改 `package.json` 的 `main`/`exports`/`files`，重启 DSH。
- 改包名时要同步：`client.js` 的 `NAME`/`NS` 与两个路由常量、`host-1.2.0.js` 的 `BASE_PATH`、`cordis.patch.yml` 的 `id`/`name`。
- 自检：`node --check client.js`、`node -e "import('./host-1.2.0.js')"`、重启后两个路由返回 `ok:true`。

## English

**dsh-continue-cost** is a DeepSeek Harness plugin that shows the completed turn count and, more importantly, the extra context cost of **continuing this conversation instead of starting a fresh one** — priced from the official peak/off-peak CNY table and the session's cache-hit mix. Most cost plugins report money already spent; this one helps you decide whether to start over. Badge thresholds (green/yellow/red) apply to turns or to the delta.

Install: unzip into a folder and add it from **Settings → Plugins → Add plugin**, then fully restart DSH.

## License

MIT
