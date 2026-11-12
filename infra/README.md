# infra

本地环境运行在开发者的 Mac 上（OrbStack，建议给 Docker 分配约 12GB 内存）。

```bash
docker compose -f infra/compose.yaml up -d                 # 项目自身依赖：Postgres + pgvector
docker compose -f infra/observability/compose.yaml up -d   # 观测后端（先起：它创建 demo 要接入的网络）
infra/scripts/otel-demo.sh up                              # 被运维系统：OpenTelemetry Demo 3.1.0（约 6GB 内存）
```

- OTel Demo 3.1.0 默认只启动核心服务和它自己的 collector，不再自带 Grafana / Prometheus。`otel-demo.sh` 用 demo 提供的 `compose.extras.yaml` 和 `otelcol-config-extras.yml` 两个扩展点（内容在 `observability/otel-demo/`）把 demo 的 collector 接到我们的网关，demo 的 trace、指标、日志与 Incident Copilot 自己的遥测进同一套后端。
- Keycloak（OIDC）在 M2 接入审批流时加入本文件。

## 观测后端（`observability/`，ADR 008）

| 服务         | 本机地址                  | 说明                                                                               |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| otel-gateway | `localhost:4317` / `4318` | OTLP 入口；删除 GenAI 内容属性、遮蔽凭据类属性，生成 span metrics 和 service graph |
| Tempo 3.1    | `localhost:3200`          | trace；mcp-observability 从这里查链路                                              |
| Loki 3.7     | `localhost:3100`          | 日志（原生 OTLP 接入，`service_name` 为索引标签）                                  |
| Prometheus 3 | `localhost:9090`          | 指标（OTLP 接收，名字只把 `.` 换成 `_`，不加后缀）                                 |
| Grafana 13   | `localhost:3001`          | 匿名 Admin，仅绑定 127.0.0.1；「Incident Copilot」看板和 4 条告警                  |

告警（Grafana 统一告警，送到 api 的 `/alerts/webhook`，系统可以调查自己的告警）：

| 告警                          | 条件                                          |
| ----------------------------- | --------------------------------------------- |
| `PromptCacheHitRateLow`       | 缓存命中率 < 50% 持续 30 分钟                 |
| `LlmDailySpendNearBudget`     | 近 24 小时花费 > `LLM_DAILY_BUDGET_USD` × 80% |
| `InvestigationLatencyP95High` | 调查 p95 > 120 秒持续 10 分钟                 |
| `UnapprovedWriteAttempt`      | 任何未审批写操作尝试（critical）              |

api 不在 3000 端口时，用 `INCIDENT_API_WEBHOOK_URL` 覆盖告警投递地址。

### 本机验证（G1）

```bash
docker compose -f infra/observability/compose.yaml up -d
pnpm dev:api                                   # 默认导出到 localhost:4318
curl -s localhost:3000/health
open "http://localhost:3001/explore"           # 选 Tempo，Search：service.name = incident-api
```

能看到 `GET /health` 的 trace 即通过。再执行 `infra/scripts/otel-demo.sh up`，几分钟后 Tempo 里应出现 demo 各服务（frontend、checkout 等）的 trace，Prometheus 里能查到 `traces_service_graph_request_total`。
