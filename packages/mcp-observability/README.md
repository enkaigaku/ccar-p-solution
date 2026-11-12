# @incident/mcp-observability

只读 MCP server，工具契约见 `@incident/contracts` 的 `ObservabilityTools`。用官方 `@modelcontextprotocol/sdk` 的底层 `Server` 实现，`tools/list` 的 inputSchema / outputSchema 由契约 Schema 生成，入参用同一 Schema 解码。挂给调查 agent，也可以给 Claude Code / Claude Desktop 人工排障复用。

## 工具

| 工具                   | 后端                                                  | 返回                                                           |
| ---------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `query_metrics`        | Prometheus `query_range`                              | 每条序列 min/max/avg/last + 12 点降采样尾巴，最多 20 条        |
| `query_logs`           | Loki（按 `service_name` 和 `detected_level`）         | 按级别计数、top 10 消息模式、最多 `limit`（默认 20）条脱敏样本 |
| `get_trace`            | Tempo `/api/traces/{id}`                              | 根服务、总耗时、最多 100 个 span（优先保留错误和最慢的）       |
| `get_service_status`   | `docker ps` / `docker inspect`（只读）                | 容器状态、重启次数、镜像 tag                                   |
| `get_service_topology` | Prometheus service graph 指标，无数据时用内置静态拓扑 | 调用边，可只取某服务的直接邻居                                 |

- 每个结果都带 `ref`（同一工具同一入参得到同一 ref），日志样本带 `ref#i`；agent 的报告只能引用出现过的 ref。
- 文本内容包在 `<untrusted-data>` 里并声明为数据（`<` 转义，日志内容无法提前闭合标记）；`structuredContent` 保持原样，由 api 组装提示时再按自己的标记包装。
- 输入里的 service 名和 traceId 有格式校验，LogQL 字符串按引号转义，防止查询注入。

## PII 脱敏（`src/Redaction.ts`）

所有返回值在本 server 内脱敏，replay 快照也会再过一遍（规则幂等）：

1. JSON 格式的日志行按字段白名单处理，白名单外的字符串值替换为 `[REDACTED]`
2. 正则规则：JWT、Bearer/Basic、`password=`/`api_key:` 等键值、常见 API key 前缀、邮箱、卡号（Luhn 校验）、IPv4/IPv6、国际/中国大陆/北美电话

规则与反例（时间戳、trace id、版本号等不被误伤）见 `test/Redaction.test.ts`。

## Replay 模式（ADR 007）

设置 `REPLAY_DIR` 后不访问任何后端，从录制快照返回结果：读取 `REPLAY_DIR/snapshot.json`，或 `REPLAY_DIR/$REPLAY_CASE/snapshot.json`。快照由 `packages/evals` 的录制器作为 MCP client 调用本 server 生成。匹配规则：去掉时间窗口、step、limit 后按工具的关键入参精确匹配（metrics 按 PromQL，logs 按 service+contains+level，trace 按 traceId，status/topology 按 service），未命中时 logs/status/topology 退化为 工具 + service；仍未命中返回空结果，trace 返回 "Trace not found"。

快照 Schema 目前在 `src/ReplaySource.ts` 里临时定义，与 evals 工作包提交到 contracts 的 `ReplaySnapshot` 一致，那个 PR 合入后改为 import。

## 运行

```bash
node packages/mcp-observability/src/main.ts                                  # stdio，实时后端
REPLAY_DIR=path/to/case node packages/mcp-observability/src/main.ts          # stdio，replay
MCP_TRANSPORT=http MCP_HTTP_TOKEN=... node packages/mcp-observability/src/main.ts
npx @modelcontextprotocol/inspector node packages/mcp-observability/src/main.ts
```

| 环境变量                           | 默认值                               |
| ---------------------------------- | ------------------------------------ |
| `PROMETHEUS_URL`                   | `http://localhost:9090`              |
| `LOKI_URL`                         | `http://localhost:3100`              |
| `TEMPO_URL`                        | `http://localhost:3200`              |
| `LOKI_SERVICE_LABEL`               | `service_name`                       |
| `LOKI_LEVEL_LABEL`                 | `detected_level`                     |
| `SERVICE_GRAPH_METRIC`             | `traces_service_graph_request_total` |
| `TOPOLOGY_FILE`                    | `src/topology/otel-demo.json`        |
| `OTEL_DEMO_COMPOSE_PROJECT`        | `opentelemetry-demo`                 |
| `REPLAY_DIR` / `REPLAY_CASE`       | 未设置                               |
| `MCP_TRANSPORT`                    | `stdio`                              |
| `MCP_HTTP_HOST` / `PORT` / `TOKEN` | `127.0.0.1` / `3101` / http 模式必填 |

后端由 `infra/observability`（可观测性工作包）提供。内置静态拓扑是按 OTel Demo 架构手写的兜底数据，以实时 service graph 为准。

**G1 验收**：MCP Inspector 能列出并调用全部 5 个工具（需在本机启动 demo 与观测后端后验证）；replay 模式测试见 `test/ReplaySource.test.ts`。
