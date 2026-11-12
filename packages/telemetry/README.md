# @incident/telemetry

OpenTelemetry for every Incident Copilot process: one Layer that exports traces, metrics and logs over OTLP, the attributes and metrics the Grafana dashboard reads, Claude cost calculation, and W3C trace context for MCP requests. The backend (Collector, Tempo, Loki, Prometheus, Grafana) lives in [`infra/observability`](../../infra/observability).

## 用法

```ts
import { TelemetryLive } from "@incident/telemetry"

// 放在最外层，所有 span 才会被导出
Layer.launch(AppLayer.pipe(Layer.provide(TelemetryLive({ serviceName: "incident-api" }))))
```

| 环境变量                      | 默认                    | 作用                                                 |
| ----------------------------- | ----------------------- | ---------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | 网关 Collector（OTLP/HTTP）                          |
| `OTEL_SDK_DISABLED`           | `false`                 | `true` 时不导出任何信号（CI、测试）                  |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000`                 | 指标导出间隔（毫秒）                                 |
| `OTEL_RESOURCE_ATTRIBUTES`    | —                       | 额外资源属性，如 `deployment.environment.name=local` |
| `LLM_DAILY_BUDGET_USD`        | `10`                    | 日预算，花费告警以它为分母                           |

### 一次 Claude 调用

```ts
const triage = Effect.gen(function* () {
  yield* annotatePrompt({ step: "triage", promptVersion: "triage@v3", renderedPrompt: system })
  const message = yield* claude.create(params) // ClaudeClient（Effect 包装的官方 SDK）
  yield* recordClaudeResponse({ step: "triage", requestedModel: params.model }, message)
}).pipe(Effect.withSpan(SpanName.triage))
```

得到的 trace：

```
incident.triage                       Effect span：step、prompt 版本/哈希、token、成本、缓存命中率、fallback
  anthropic.messages.create           SDK span（CLIENT）：gen_ai.* 语义约定属性、request id
    anthropic.messages.create         Claude API span（SERVER，仅在 Console 配置了 OTLP 目的地时）
```

`TelemetryLive` 全局注册 tracer provider、AsyncLocalStorage context manager 和 W3C propagator：官方 SDK 由此自动找到 provider，并通过 `@effect/opentelemetry` 的 context 钩子把 span 挂在当前 Effect span 下，同时把 `traceparent` 发给 API。这一点由 `test/Telemetry.test.ts` 用真实 SDK + 本地 fetch 验证。

### 其他辅助

| 导出                                       | 用途                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `SpanName`、`Attr`、`MetricName`           | span 名、属性名、指标名；看板与告警依赖这些名字                                   |
| `costUsd`、`cacheHitRatio`、`PRICING`      | 按响应的 `model` 和 `usage` 计费（含 5m/1h 缓存写、Haiku 长上下文档、Batch 半价） |
| `recordInvestigationOutcome`               | 调查结束：状态、总成本、工具调用次数                                              |
| `recordRetrieval(indexVersion, top1Score)` | 检索：index 版本写入 span，rerank top-1 分数进直方图                              |
| `recordFeedback(rating)`                   | 控制台反馈                                                                        |
| `recordUnapprovedWriteAttempt(reason)`     | `mcp-ops` 拒绝无效 `ApprovalToken` 时调用，触发 critical 告警                     |
| `currentTraceMeta` / `withTraceMeta(meta)` | MCP 请求 `params._meta.traceparent` 的注入与续接，一次调查跨进程仍是一条 trace    |
| `sha256Hex`                                | 提示词、工具结果只记哈希，原文进审计表                                            |

## 约束

- 提示词和工具结果原文不进 span（安全规则 5）。SDK 默认 `metadata_only`；网关 Collector 还会删除 `gen_ai.input.messages` 等内容属性作为兜底。
- 指标标签只用低基数值（model、step、stop_reason、status、index_version），不放调查 id。
- `@opentelemetry/api` 在根 `package.json` 用 pnpm override 固定为 1.9.1：`@effect/opentelemetry` 4.1.4 依赖的 OTel JS SDK 2.x 要求 api < 1.10，而整个进程必须只有一份 api，SDK 的 span 才能找到全局 provider。升级到 OTel JS 3.x 时一并移除。
- 价格表 `Pricing.ts` 为 2026-11-12 的官方单价；Haiku 5.5 的缓存读取单价未单列，按输入价 0.1 倍估算。

## G1 验收

api 启动后，一次请求的 trace 能在 Grafana/Tempo 中看到；成本计算有单测（`test/Pricing.test.ts`）。本机验证步骤见 [`infra/README.md`](../../infra/README.md)。
