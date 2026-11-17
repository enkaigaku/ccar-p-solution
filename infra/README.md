# infra

本地环境运行在开发者的 Mac 上（OrbStack，建议给 Docker 分配约 12GB 内存）。

```bash
docker compose -f infra/compose.yaml up -d                 # 项目自身依赖：Postgres + pgvector
docker compose -f infra/observability/compose.yaml up -d   # 观测后端（先起：它创建 demo 要接入的网络）
infra/scripts/otel-demo.sh up                              # 被运维系统：OpenTelemetry Demo 3.1.0（约 6GB 内存）
```

- OTel Demo 3.1.0 默认只启动核心服务和它自己的 collector，不再自带 Grafana / Prometheus。`otel-demo.sh` 用 demo 提供的 `compose.extras.yaml` 和 `otelcol-config-extras.yml` 两个扩展点（内容在 `observability/otel-demo/`）把 demo 的 collector 接到我们的网关，demo 的 trace、指标、日志与 Incident Copilot 自己的遥测进同一套后端。

## 登录（`keycloak/`，ADR 010）

```bash
# .env 里填 OIDC_CLIENT_SECRET、KEYCLOAK_ADMIN_PASSWORD、KEYCLOAK_DEMO_PASSWORD，并取消 OIDC_ISSUER 的注释（见 .env.example）
docker compose --env-file .env -f infra/keycloak/compose.yaml up -d      # http://localhost:8080，约 30 秒后可用

set -a; . ./.env; set +a                 # 两个终端都要执行：api 和 web 都读 OIDC_ISSUER
pnpm dev:api                             # 终端 1：校验访问令牌
pnpm --filter @incident/web dev          # 终端 2：http://localhost:3001，未登录时跳转到 Keycloak
```

- `keycloak/incident-realm.json` 在容器创建时导入 realm `incident`：三个角色（approver 包含 responder，responder 包含 viewer）、客户端 `incident-web`（机密客户端，授权码 + PKCE，访问令牌带 `aud=incident-api` 和 `realm_access.roles`）、三个演示用户。客户端密钥和用户密码由 compose 从 `.env` 注入，文件里没有任何凭据。
- 演示用户：`alice`（approver）、`bob`（responder）、`carol`（viewer），密码都是 `KEYCLOAK_DEMO_PASSWORD`。
- Keycloak 用 `start-dev`（HTTP、内嵌数据库），只适合本机演示。`down` 会丢弃 realm 和所有会话，下次 `up` 重新导入；改了 realm 文件或 `.env` 后要 `down` 再 `up`。
- 管理控制台：<http://localhost:8080/admin>（端口随 `KEYCLOAK_PORT`），用户 `admin`，密码 `KEYCLOAK_ADMIN_PASSWORD`。
- 默认端口 8080 与 OpenTelemetry Demo 的 frontend-proxy 相同。两者同时运行时在 `.env` 里设 `KEYCLOAK_PORT`（例如 8081），并把 `OIDC_ISSUER` 里的端口改成同一个，然后 `down` 再 `up`；api 和 web 的终端要重新加载 `.env`。
- web 的默认端口 3001 与下面 Grafana 的 3001 相同，两者同时运行时在 `.env` 里设 `WEB_PORT`（例如 3002），并把 `WEB_ORIGIN` 改成同一个端口的地址（Keycloak 也读这个变量，改后要重建容器）。
- 评估和不需要登录的开发用 `AUTH_MODE=dev pnpm dev:api`，不要设置 `OIDC_ISSUER`。

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
AUTH_MODE=dev pnpm dev:api                     # 默认导出到 localhost:4318
curl -s localhost:3000/health
open "http://localhost:3001/explore"           # 选 Tempo，Search：service.name = incident-api
```

能看到 `GET /health` 的 trace 即通过。再执行 `infra/scripts/otel-demo.sh up`，几分钟后 Tempo 里应出现 demo 各服务（frontend、checkout 等）的 trace，Prometheus 里能查到 `traces_service_graph_request_total`。
