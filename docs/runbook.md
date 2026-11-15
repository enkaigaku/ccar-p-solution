# 运维手册

Incident Copilot 自身的日常操作和排障。整套环境跑在开发者的 Mac 上（OrbStack，建议给 Docker 分配约 12GB 内存），没有生产部署。背景和现状见[交接文档](handoff.md)；各组件的细节以对应的 README 为准，这里只写「要做某件事时按什么顺序敲什么」。

## 组件和端口

| 组件                       | 地址                               | 怎么起                                                                |
| -------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| api                        | <http://localhost:3000>（`/docs`） | `pnpm dev:api`                                                        |
| web 控制台                 | <http://localhost:3001>            | `pnpm --filter @incident/web dev`                                     |
| Postgres + pgvector        | `localhost:5432`                   | `docker compose -f infra/compose.yaml up -d`                          |
| Keycloak                   | <http://localhost:8080>            | `docker compose --env-file .env -f infra/keycloak/compose.yaml up -d` |
| OTLP 网关                  | `localhost:4317` / `4318`          | `docker compose -f infra/observability/compose.yaml up -d`            |
| Tempo / Loki / Prometheus  | `3200` / `3100` / `9090`           | 同上                                                                  |
| Grafana                    | <http://localhost:3001>            | 同上                                                                  |
| OpenTelemetry Demo         | 由 demo 自己的 compose 决定        | `infra/scripts/otel-demo.sh up`                                       |
| mcp-observability、mcp-ops | 默认 stdio，由 api 按需启动        | 不用单独起                                                            |

web 的开发端口和 Grafana 都是 3001。两者同时运行时给 web 换一个端口，并把 `.env` 里的 `WEB_ORIGIN` 改成新地址；Keycloak 也读这个变量，改后要 `down` 再 `up`。

## 启动全套环境

顺序有依赖：观测后端创建 demo 要接入的网络，所以必须先起。

```bash
cp .env.example .env                                         # 第一次：填密钥，见交接文档
docker compose -f infra/compose.yaml up -d                   # Postgres
docker compose -f infra/observability/compose.yaml up -d     # 观测后端（先于 demo）
infra/scripts/otel-demo.sh up                                # 被运维系统，约 6GB 内存
docker compose --env-file .env -f infra/keycloak/compose.yaml up -d   # 登录，约 30 秒后可用

set -a; . ./.env; set +a                                     # 每个新终端都要执行：没有任何脚本会自动读 .env

pnpm --filter @incident/rag rag ingest                       # 第一次，或语料变了之后
pnpm dev:api                                                 # 终端 1
pnpm --filter @incident/web dev                              # 终端 2
```

不需要登录时（评估、控制台开发）不要起 Keycloak，也不要设置 `OIDC_ISSUER`，改用 `AUTH_MODE=dev pnpm dev:api`。`AUTH_MODE=dev` 下所有请求都被当成拥有全部角色的操作员，只能在本机用。

### 检查是否正常

```bash
curl -s localhost:3000/health                                # api
pnpm --filter @incident/rag rag versions                     # 应有一个 active 版本
infra/scripts/otel-demo.sh status                            # demo 的容器
open http://localhost:3001/explore                           # Grafana：Tempo 里搜 service.name = incident-api
```

demo 起来几分钟后，Tempo 里应出现 frontend、checkout 等服务的 trace，Prometheus 里能查到 `traces_service_graph_request_total`。

### 停止

```bash
infra/scripts/otel-demo.sh down
docker compose -f infra/keycloak/compose.yaml down           # 丢弃 realm 和所有会话，下次 up 重新导入
docker compose -f infra/observability/compose.yaml down
docker compose -f infra/compose.yaml down                    # 不加 -v：保留索引
```

api 和 web 直接 Ctrl-C。**api 停了，内存里的告警、调查、提议和反馈就没了**；审计日志在 `infra/.api-state/audit.jsonl` 和 `infra/.ops-state/audit.jsonl`，不受影响。web 停了，所有人要重新登录。

## 日常操作

### 更新知识库

语料在 `packages/rag/corpus/`。改完后：

```bash
pnpm --filter @incident/rag rag ingest
```

它重建一个候选版本，对候选和当前版本都跑检索集，recall@8 低于 0.85 或比当前版本下降超过 5 个百分点就**不激活**并以非零退出。内容没变的块复用旧向量，不再调用 Voyage。

- 门禁没过：看输出里的 `miss` 行是哪些查询丢了哪些块。确认要上线再加 `--force`。
- 回滚：`rag versions` 找到上一个版本，`rag activate <version>`。
- 清理：`rag prune 3` 只保留最近 3 个非 active 版本。
- 换了 embedding 模型后增量写入会被拒绝，要走一次全量重建。

改检索参数（top-k、融合、rerank）属于「必须附评估结果」的改动。

### 轮换审批签名密钥

`APPROVAL_SIGNING_KEY` 由 api（签发）和 mcp-ops（验签）共用。

1. 确认没有待审批的提议（控制台里没有 `awaiting_approval`），否则已签发的令牌会失效，执行会失败。
2. `openssl rand -hex 32` 生成新值，写进 `.env`。
3. 停掉 api，在启动它的终端里重新执行 `set -a; . ./.env; set +a`，再启动。只改 `.env` 不重新加载的话，终端里还是旧值，重启后的 api 会继续用旧密钥。mcp-ops 默认由 api 每次执行时以子进程启动，继承 api 的环境，所以 api 用上新值后它也是新值；如果 mcp-ops 是以 `MCP_TRANSPORT=http` 单独运行的，在它的终端里同样重新加载 `.env` 后重启。
4. 确认生效：在控制台批准一个提议并执行成功。旧密钥签的令牌此时应当被 mcp-ops 拒绝。

密钥泄漏时立即做第 2 到 4 步，不必等第 1 步。然后查 `infra/.ops-state/audit.jsonl` 里泄漏时间之后的 `accepted` 和 `executed` 记录是否都对应控制台里的审批。

### 管理用户和角色

本地 Keycloak 的 realm 定义在 `infra/keycloak/incident-realm.json`，容器创建时导入。三个角色：approver 包含 responder，responder 包含 viewer。

- 临时加人或改角色：<http://localhost:8080/admin>（用户 `admin`，密码 `KEYCLOAK_ADMIN_PASSWORD`）。Keycloak 用内嵌数据库，`down` 之后这些改动会丢。
- 要保留的改动写进 realm 文件，然后 `down` 再 `up`。
- 角色变化在用户的访问令牌刷新后生效（几分钟内）；要立刻生效就让他退出再登录。

### 跑评估

不花钱的随时可以跑：

```bash
pnpm --filter @incident/evals eval:ci          # stub agent，10 条冒烟用例，带门禁
```

花钱的评估先看预算，并且先得到项目所有者的同意。完整步骤在 [`.claude/skills/run-evals/SKILL.md`](../.claude/skills/run-evals/SKILL.md)，要点：

```bash
pnpm --filter @incident/evals evals budget                              # 当月用量和剩余次数

AUTH_MODE=dev OBS_REPLAY_DIR=$PWD/packages/evals/.replay pnpm dev:api   # 终端 1：回放模式，不认证
cd packages/evals                                                       # 终端 2
EVAL_REPLAY_DIR=$PWD/.replay EVAL_AGENT=api EVAL_JUDGE=claude pnpm eval:smoke   # 约 3.5 美元
```

- 全量是 `pnpm eval:full`，约 24 美元（69 条），每月最多 8 次。
- 只跑一部分：在 promptfoo 命令后加 `--filter-metadata kind=adversarial` 或 `--filter-pattern <正则>`。
- 跑完用 `evals gate <结果文件> --min-top3 0.85` 对照门槛，把结论写成 `packages/evals/reports/` 下的一份报告。
- 结果文件含完整的 agent 输出，保存在仓库外，不提交。

### 录制新的故障快照

需要 demo 和观测后端都在运行。不调用 Claude，没有 API 费用，但每个场景要 13 到 22 分钟。

```bash
pnpm --filter @incident/evals evals scenarios                # ✓ 表示已经录过
caffeinate -i pnpm --filter @incident/evals record --missing \
  --flagd-url "http://localhost:$(docker port flagd 8013/tcp | cut -d: -f2)"
```

务必带 `--flagd-url`，原因见下面「排障」里 flagd 的那一条。录完要人工复核新生成的用例，细节在 [`packages/evals/README.md`](../packages/evals/README.md)「录制故障快照」。

## 告警

Grafana 的 4 条告警会送到 api 的 `/alerts/webhook`，所以系统可以调查自己的告警。

| 告警                          | 条件                                          | 怎么处理                                                                                                                                                                |
| ----------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnapprovedWriteAttempt`      | 任何未审批的写操作尝试（critical）            | 当成安全事件。看 `infra/.ops-state/audit.jsonl` 里的 `rejected` 行和原因，确认调用方是谁。mcp-ops 只应该被 api 的审批执行器连接，别的来源都不正常。必要时轮换签名密钥。 |
| `LlmDailySpendNearBudget`     | 近 24 小时花费 > `LLM_DAILY_BUDGET_USD` × 80% | 先确认是不是有评估在跑。不是的话看看板上按 step 的花费，找出花费集中在哪些调查；必要时调低 `MAX_CONCURRENT_INVESTIGATIONS` 或 `AGENT_MAX_COST_USD`。                    |
| `InvestigationLatencyP95High` | 调查 p95 > 120 秒持续 10 分钟                 | 在 Tempo 里打开慢的 `incident.investigation` trace，看时间花在模型请求还是工具调用上。工具慢通常是观测后端慢；模型慢看有没有发生 fallback。                             |
| `PromptCacheHitRateLow`       | 缓存命中率 < 50% 持续 30 分钟                 | 多半是稳定前缀被改动了：最近有没有改提示词、工具定义的顺序，或者往稳定前缀里加了时间戳、随机值。`packages/prompts` 的测试会查一部分。调查量很小时也会偏低。             |

## 排障

| 现象                                                            | 原因和处理                                                                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api 启动时报认证没有配置                                        | 既没有 `OIDC_ISSUER` 也没有 `AUTH_MODE=dev`。认证不会降级，二选一。                                                                                                                                |
| api 启动时报两种认证方式冲突                                    | `OIDC_ISSUER` 和 `AUTH_MODE=dev` 同时设置了，去掉一个。常见于 `.env` 里开了 `OIDC_ISSUER` 又在命令行加 `AUTH_MODE=dev`。                                                                           |
| 控制台登录后又被送回登录页，或所有请求 401                      | api 和 web 的 `OIDC_ISSUER` 不一致，或其中一个没读 `.env`（两个终端都要 `set -a; . ./.env; set +a`）。访问令牌的 `aud` 必须是 `incident-api`。                                                     |
| 改了 realm 文件或 `.env` 之后登录不对                           | Keycloak 只在容器创建时导入，`down` 再 `up`。                                                                                                                                                      |
| 调查失败，日志里是模型拒绝或 `max_tokens`                       | api 读 `content` 前会检查 `stop_reason`，这两种都记为 failed。偶发可以重新发起；集中出现时看是不是工具结果过大。                                                                                   |
| 调查报告没有处置建议                                            | 置信度低于 0.5，或状态不是 `completed`，提议不会变成待审批单。这是设计行为。                                                                                                                       |
| 批准后执行失败                                                  | 看 `infra/.ops-state/audit.jsonl` 的 `rejected` 原因：令牌过期（签发后 2 分钟内必须用掉）、签名不对（api 和 mcp-ops 的密钥不一致）、参数不匹配、令牌已用过。提议超过 10 分钟未决会变成 `expired`。 |
| 回滚过的服务在 `otel-demo.sh up` 之后回到了原镜像               | 回滚的覆盖文件只在 mcp-ops 执行回滚时生效，这是已知行为。                                                                                                                                          |
| `rag ingest` 或 `rag eval` 报 HTTP 429                          | Voyage 的速率限制。评估是 strict 模式，被限流时直接报错而不是降级，所以门禁不会用错误的分数放行。在 Voyage 控制台绑定付款方式后限制会提高。线上检索遇到 429 会降级并在 span 上标 `rag.degraded`。  |
| `otel-demo.sh up` 报 `network incident-observability not found` | 观测后端没起，先 `docker compose -f infra/observability/compose.yaml up -d`。                                                                                                                      |
| 录制时场景全部等到超时                                          | flagd 丢了对 flag 文件的监听，一直按旧状态提供 flag，而写文件看起来仍然成功。`docker restart flagd`，并且录制时带 `--flagd-url`，它会在每次注入后核对 flagd 实际提供的 variant。                   |
| 评估里 agent 说查不到数据                                       | 回放按 PromQL 逐字匹配，agent 自己写的查询命中不了录制，会得到工具错误。工具说明里新增了查询写法之后，用 `evals backfill` 给旧快照补录（前提是 Prometheus 还留着那段数据，本地保留 15 天）。       |
| 真实评估一条都连不上 api                                        | api 必须以 `AUTH_MODE=dev` 启动（评估客户端不带访问令牌），而且 `OBS_REPLAY_DIR` 要和评估的 `EVAL_REPLAY_DIR` 是同一个目录的绝对路径。                                                             |
| 预算守卫拒绝运行评估                                            | 当月全量次数用完（8 次），或加上本次估算会超过月度上限的 80%。不要绕过。冒烟不受 80% 规则限制，每月 50 次。换过机器的话账本是空的，用 `EVAL_MONTH_SPEND_USD` 带上已用金额。                        |
| Grafana 和 web 抢 3001 端口                                     | 给 web 换端口并改 `WEB_ORIGIN`，见本页开头。                                                                                                                                                       |

## 数据在哪

| 数据                                     | 位置                                    | 重启后                 |
| ---------------------------------------- | --------------------------------------- | ---------------------- |
| 告警、调查、提议、反馈                   | api 进程内存                            | 丢失                   |
| 控制台会话和令牌                         | web 进程内存                            | 丢失，重新登录         |
| api 审计（提示、模型输出、工具结果原文） | `infra/.api-state/audit.jsonl`          | 保留，按 trace id 关联 |
| mcp-ops 审计                             | `infra/.ops-state/audit.jsonl`          | 保留                   |
| 知识库索引                               | Postgres 卷                             | 保留（`down -v` 会删） |
| trace、日志、指标                        | 观测后端的卷，Prometheus 本地保留 15 天 | 保留                   |
| Keycloak 用户和会话                      | 容器内嵌数据库                          | `down` 后丢失          |
| 评估预算账本                             | `packages/evals/.ledger/`（不在仓库里） | 保留；换机器不跟着走   |

审计文件里有提示词和工具结果的原文，可能含有脱敏后仍然敏感的内容，不要提交，也不要贴到 issue 或 PR 里。
