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
- 手动快照：打开、筛选和重开面板使用已有缓存；只有「刷新」导入新增用量，「重建缓存」全量重扫

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

采用**手动更新快照**，结果保存在 `<dshHome>/dsh-model-usage/cache.json`。插件启动、打开面板、切换筛选都不会解压会话日志；没有定时扫描、启动预热或持续文件监听。重开面板保留上次结果，新增请求在点击「刷新」后导入。首次安装没有缓存时，也等待点击「刷新」建立统计。

「刷新」先检查文件元数据，跳过未变化日志；增长的日志从持久化游标读取新增完整 zstd 帧或 JSONL 字节，保留 provider/model 路由、未完行原始字节及统计记录。半帧、半行等待完成后再计数；文件身份使用精确 BigInt 字符串，已读尾帧哈希用于识别 DSH 的尾部回滚。文件缩短、替换、同大小改写或校验失配时，仅重读对应日志并替换旧贡献。

旧版缓存可直接显示，缺少增量游标的已变化日志在首次手动刷新时完整读取一次，之后使用新增帧。只有「重建缓存」会主动从头读取全部日志，重建完成前仍保留旧快照显示。初次导入和重建耗时取决于日志体积。

打开或筛选会检查缓存文件是否仍存在，仅访问元数据。已删除或移入回收站的会话从快照、历史选项和持久缓存中剔除，这一步不解压日志。

## 安全

HTTP 接口 `/model-usage/api/*` 复用 GUI `/api` 通道同一套准入（`connection.requestRejection`：Host/Origin 校验 + 签名的 HttpOnly 会话 cookie）。拿不到 `connection` 服务时直接返回 503，不会无鉴权放行。插件不写会话目录，只写自己的缓存文件。

统计接口支持 `GET /model-usage/api/summary?provider=PROVIDER&model=MODEL&from=YYYY-MM-DD&to=YYYY-MM-DD&subagents=0`。参数可省略；模型 ID 的 `/` 等字符应进行 URL 编码。非法日期或倒置区间返回 400。返回结果包含筛选后的 `totals/models/providers/days/sessions` 和独立的历史 `catalog`。

普通 `GET /summary` 只查询快照；追加 `refresh=1` 才导入变化日志。`POST /rebuild` 从头导入全部日志。`status` 包含 `mode: "manual"`、`cacheReady`、`needsRefresh`、扫描次数及上次手动读取的 `bytesRead/incrementalFiles/fullFiles`；`needsRefresh` 只反映已缓存路径的变化，新会话也通过手动刷新导入。

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
npm test        # 32 项回归：增量游标、UTF-8、回滚、快照/删除同步、聚合及筛选
```

浏览器回归使用隔离的日志样本和真实客户端代码，覆盖 Provider/模型联动、日期、子代理、重置、旧请求竞争、长区间、窄屏布局、标签重挂载、快照重开、刷新仅触发一次、闲置无轮询及首次缓存手动建立。需要已安装 React 18、React DOM 18、Playwright 及 Chromium；可通过 `MU_BROWSER_MODULE_BASE` 指定这些依赖所在的项目目录：

```powershell
$env:MU_BROWSER_MODULE_BASE = "$env:USERPROFILE\.dsh\profiles\desktop"
npm run test:browser
```

截图写入 `test/artifacts/`（已忽略），可用 `MU_BROWSER_ARTIFACTS` 自定义输出目录。此测试不修改运行中 GUI 的真实会话或插件状态。

无构建步骤：`lib/client.js` 直接作为 DSH 客户端 bundle 加载。

可选的 `node test/benchmark.manual.mjs` 使用真实日志的临时副本和隔离缓存，比对旧版全读与增量读的用量一致性、字节数和耗时；真实会话和统计缓存保持只读。设置 `MU_BENCH_HOME` 指定 DSH home，`MU_BENCH_OUTPUT` 保存性能结果；运行环境须保留 Git 历史中的 `c96fcf8`，或用 `MU_BENCH_BASELINE` 指定旧版引用。

## 已知限制

- 只统计日志里有 usage 的请求；provider 不回报 usage 的请求（部分中转站）计为 0，不会出现在表里
- 会话标题生成请求（`session-title-llm`）的日志里没有 usage，不计入
- 被「会话清理」移入回收站的会话不再统计（它们已不在 `sessions` 目录下）
- `reasoningTokens` 目前各家几乎都不报，所以面板不单列

## License

MIT
