# dsh-model-usage

DSH（DeepSeek Harness）模型用量插件：扫描本机全部会话日志，按 provider / 模型统计请求数和 token 用量。

官方的 `dsh-token-meter` 和 `dsh-session-stats` 只给单个会话的总量或耗时，不按模型拆分，也不跨会话汇总；这个插件补上这块。

## 功能

- 侧栏底部「模型用量」按钮，打开统计面板
- 时间范围：今天 / 近 7 天 / 近 30 天 / 全部，可选是否包含子代理会话
- 汇总卡片：总 token、请求数、未缓存输入、输出、缓存命中、缓存命中率
- 按模型表格：请求、输入、输出、缓存读、缓存写、合计、占比，可排序；点击行展开「对话 / 失败重试 / 上下文压缩」分项和使用天数
- 每日趋势柱状图（前 5 个模型分色，其余合并为「其他」）
- 用量最高的 20 个会话

## 数据来源

只读 `<dshHome>/sessions/**/session*.jsonl[.zstd]`，每个会话目录只取一个日志（优先 `session.v4.jsonl.zstd`，避免迁移遗留的旧格式重复计数）。统计的是 provider 在日志里上报的用量：

| 事件 | 归类 | 模型来源 |
|---|---|---|
| `assistant/message` 的 `usage`（或流里最后一个 usage chunk） | 对话 | 消息的 `source.provider/model` |
| `assistant/attempt` 流里的 usage（失败后被重试的请求） | 失败重试 | 最近一次 `request/header` / `model/selection` |
| `compaction/summary` 的 `usage` | 上下文压缩 | 事件自带 `provider/model` |

口径：输入 = 未命中缓存的提示词；合计 = 输入 + 缓存读 + 缓存写 + 输出（provider 报的 `totalTokens` 更大时取它）。日期按本机时区。

不做费用换算：各家中转站价格差异大，token 数是唯一可靠的量。

## 性能

首次扫描约 15–20 秒（600+ 会话、约 700 MB 压缩日志），结果按文件 size + mtime 缓存在 `<dshHome>/dsh-model-usage/cache.json`。之后打开面板只重新解析有变化的会话（通常是正在进行的那一个），不到 1 秒。插件启动 8 秒后会在后台预热一次。面板上「重建缓存」会清空缓存重新扫描。

## 安全

HTTP 接口 `/model-usage/api/*` 复用 GUI `/api` 通道同一套准入（`connection.requestRejection`：Host/Origin 校验 + 签名的 HttpOnly 会话 cookie）。拿不到 `connection` 服务时直接返回 503，不会无鉴权放行。插件不写会话目录，只写自己的缓存文件。

## 安装

```powershell
git clone https://github.com/741075810/dsh-model-usage.git "$env:USERPROFILE\.dsh\plugins\dsh-model-usage"
```

然后在 DSH 插件管理里安装 bundle `file:../../plugins/dsh-model-usage`，或手动：

1. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加 `"dsh-model-usage": "file:../../plugins/dsh-model-usage"`，`dsh.profile.bundles` 加 `"dsh-model-usage"`
2. 建 junction：`New-Item -ItemType Junction -Path ~/.dsh/profiles/<profile>/node_modules/dsh-model-usage -Target ~/.dsh/plugins/dsh-model-usage`
3. 重启 DSH

## 开发

```powershell
npm run check   # node --check 全部源文件
npm test        # node:test，覆盖 zstd 分帧、事件折叠、聚合与筛选
```

无构建步骤：`lib/client.js` 直接作为 DSH 客户端 bundle 加载。

## 已知限制

- 只统计日志里有 usage 的请求；provider 不回报 usage 的请求（部分中转站）计为 0，不会出现在表里
- 会话标题生成请求（`session-title-llm`）的日志里没有 usage，不计入
- 被「会话清理」移入回收站的会话不再统计（它们已不在 `sessions` 目录下）
- `reasoningTokens` 目前各家几乎都不报，所以面板不单列

## License

MIT
