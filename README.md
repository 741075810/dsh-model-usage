# dsh-model-usage

DSH（DeepSeek Harness）模型用量插件：扫描本机全部会话日志，按 provider / 模型统计请求数和 token 用量。

官方的 `dsh-token-meter` 和 `dsh-session-stats` 只给单个会话的总量或耗时，不按模型拆分，也不跨会话汇总；这个插件补上这块。

## 功能

- 顶部「对话 / 轨迹 / 上下文」标签行的「模型用量」入口，点击打开统计面板，不占用侧栏底部
- Provider → 模型联动筛选：先选 Provider，再选其模型；切换 Provider 自动清空模型选择
- 时间范围：今天 / 近 7 天 / 近 30 天 / 全部 / 自定义起止日期，支持只设置一侧日期，可选是否包含子代理会话
- 所有筛选可叠加，汇总卡片、模型占比、每日趋势及会话排行使用同一筛选口径；支持一键重置
- 汇总卡片：总 token、请求数、未缓存输入、输出、缓存命中、缓存命中率
- 按模型表格：请求、输入、输出、缓存读、缓存写、合计、占比，可排序；点击行展开「对话 / 失败重试 / 上下文压缩」分项和使用天数
- 每日趋势柱状图（前 5 个模型分色，其余合并为「其他」）；长区间合并为最多 180 个连续日期柱，悬停显示区间，保留全部用量
- 用量最高的 20 个会话

## 数据来源

只读 `<dshHome>/sessions/**/session*.jsonl[.zstd]`，每个会话目录只取一个日志（优先 `session.v4.jsonl.zstd`，避免迁移遗留的旧格式重复计数）。统计的是 provider 在日志里上报的用量：

| 事件 | 归类 | 模型来源 |
|---|---|---|
| `assistant/message` 的 `usage`（或流里最后一个 usage chunk） | 对话 | 消息的 `source.provider/model` |
| `assistant/attempt` 流里的 usage（失败后被重试的请求） | 失败重试 | 最近一次 `request/header` / `model/selection` |
| `compaction/summary` 的 `usage` | 上下文压缩 | 事件自带 `provider/model` |

口径：输入 = 未命中缓存的提示词；合计 = 输入 + 缓存读 + 缓存写 + 输出（provider 报的 `totalTokens` 更大时取它）。日期按本机时区。

Provider 和模型下拉项来自全部历史日志中有用量的模型，不是服务商实时模型目录。筛选选项保持稳定，选定日期没有用量时显示零汇总和空结果。日期区间包含开始与结束当天；开始日期晚于结束日期时显示提示并暂停查询。

不做费用换算：各家中转站价格差异大，token 数是唯一可靠的量。

## 性能

首次扫描约 15–20 秒（600+ 会话、约 700 MB 压缩日志），结果按文件 size + mtime 缓存在 `<dshHome>/dsh-model-usage/cache.json`。之后打开面板只重新解析有变化的会话（通常是正在进行的那一个），不到 1 秒。插件启动 8 秒后会在后台预热一次。面板上「重建缓存」会清空缓存重新扫描。

## 安全

HTTP 接口 `/model-usage/api/*` 复用 GUI `/api` 通道同一套准入（`connection.requestRejection`：Host/Origin 校验 + 签名的 HttpOnly 会话 cookie）。拿不到 `connection` 服务时直接返回 503，不会无鉴权放行。插件不写会话目录，只写自己的缓存文件。

统计接口支持 `GET /model-usage/api/summary?provider=PROVIDER&model=MODEL&from=YYYY-MM-DD&to=YYYY-MM-DD&subagents=0`。参数可省略；模型 ID 的 `/` 等字符应进行 URL 编码。非法日期或倒置区间返回 400。返回结果包含筛选后的 `totals/models/providers/days/sessions` 和独立的历史 `catalog`。

## 安装

```powershell
git clone https://github.com/741075810/dsh-model-usage.git "$env:USERPROFILE\.dsh\plugins\dsh-model-usage"
```

然后在 DSH 插件管理里安装 bundle `file:../../plugins/dsh-model-usage`，或手动：

1. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加 `"dsh-model-usage": "file:../../plugins/dsh-model-usage"`，`dsh.profile.bundles` 加 `"dsh-model-usage"`
2. 建 junction：`New-Item -ItemType Junction -Path ~/.dsh/profiles/<profile>/node_modules/dsh-model-usage -Target ~/.dsh/plugins/dsh-model-usage`
3. 重启 DSH

更新源码后也需完整重启 DSH，让宿主重新加载 ESM 模块和客户端 bundle；仅关闭再启用插件会复用宿主模块缓存。

## 开发

```powershell
npm run check   # node --check 全部源文件
npm test        # node:test，覆盖 zstd 分帧、事件折叠、聚合与筛选
```

浏览器回归使用隔离的日志样本和真实客户端代码，覆盖 Provider/模型联动、日期、子代理、重置、旧请求竞争、长区间、窄屏布局、标签重挂载和清理。需要已安装 React 18、React DOM 18、Playwright 及 Chromium；可通过 `MU_BROWSER_MODULE_BASE` 指定这些依赖所在的项目目录：

```powershell
$env:MU_BROWSER_MODULE_BASE = "$env:USERPROFILE\.dsh\profiles\desktop"
npm run test:browser
```

截图写入 `test/artifacts/`（已忽略），可用 `MU_BROWSER_ARTIFACTS` 自定义输出目录。此测试不修改运行中 GUI 的真实会话或插件状态。

无构建步骤：`lib/client.js` 直接作为 DSH 客户端 bundle 加载。

## 已知限制

- 只统计日志里有 usage 的请求；provider 不回报 usage 的请求（部分中转站）计为 0，不会出现在表里
- 会话标题生成请求（`session-title-llm`）的日志里没有 usage，不计入
- 被「会话清理」移入回收站的会话不再统计（它们已不在 `sessions` 目录下）
- `reasoningTokens` 目前各家几乎都不报，所以面板不单列

## License

MIT
