# @incident/api

Effect HttpApi 服务：告警 webhook、调查编排（分诊 workflow + 调查 agent）、审批执行、SSE 事件流。M2 集成步骤，设计见设计文档「总体架构」与 ADR 001 / 003 / 004 / 006。

## 一次调查

```
POST /investigations ──► InvestigationRunner（后台 fiber，一次调查 = 一条 trace，根 span incident.investigation）
  1. Triage          Haiku 5.5 / low，结构化输出：类别、服务、严重度、检索查询、关联告警；失败时退化为按标签的启发式
  2. Retriever       按分诊的查询和服务检索 runbook / 复盘（@incident/rag；无 DATABASE_URL 时用 stub）
  3. Investigator    Opus 5.5 / high 的手写工具循环：
                       工具 = mcp-observability 的 5 个只读工具 + search_knowledge + propose_action
                       每轮发 StepStarted / ToolCalled 事件；预算（轮数、花费）用完后 tool_choice=none 强制出报告
                       报告用 structured outputs；引用的 ref 必须出现在本次工具结果或检索 chunk 里，
                       不符合时让模型修正一次，仍不符合的引用被删除
  4. 报告            置信度 ≥ 0.5 且 status=completed 时，propose_action 的提议才变成待审批单（awaiting_approval）
POST /proposals/:id/decision ──► 批准：ApprovalExecutor 签 ApprovalToken（2 分钟有效，绑定 actionHash）
                                  → OpsGateway 调 mcp-ops（验签、有效期、参数绑定、一次性）→ executed / failed
                                  拒绝：rejected；提议超过 10 分钟未决：expired
GET /investigations/:id/events ──► SSE，id 为事件序号，支持 Last-Event-ID 续传，终态后结束
```

### 安全约束在代码里的位置

| 规则                         | 实现                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| agent 只有只读工具和提议工具 | `agent/tools.ts`：只放行 `ObservabilityTools` 里的工具名，另加 `search_knowledge`、`propose_action`；有测试断言工具列表 |
| mcp-ops 只给审批执行器       | 只有 `ApprovalExecutor` 依赖 `OpsGateway`；签名密钥只在 api 与 mcp-ops 之间共享                                         |
| 工具结果是不可信数据         | `prompting.ts` 的 `untrusted()`：包在 `<untrusted-data>` 里，`<` 转义，系统提示声明其为数据                             |
| 原文只进审计                 | `audit/AuditLog.ts`：提示、模型输出、工具结果原文写 JSONL（按 trace id 关联），span 上只有哈希                          |
| 密钥                         | 只从环境变量读；spawn 的 MCP server 只拿到白名单内的变量（mcp-observability 拿不到任何密钥）                            |

### 提示缓存

工具定义固定顺序、JSON 键排序；断点依次为 system、稳定上下文（服务拓扑 + 方法论）、自动缓存的对话尾部。本次告警、当前时间和检索结果放在稳定前缀之后。

## 运行

```bash
pnpm dev:api        # http://localhost:3000/docs
```

没有 `ANTHROPIC_API_KEY`、`DATABASE_URL`、`APPROVAL_SIGNING_KEY` 时也能启动（控制台开发用），对应功能会失败并打 warning。

| 环境变量                                            | 默认                           | 说明                                                                                    |
| --------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                 | —                              | 分诊与调查                                                                              |
| `DATABASE_URL`                                      | —                              | 有则用 `@incident/rag` 的 `RetrieverLive`，否则 stub                                    |
| `VOYAGE_API_KEY`                                    | —                              | `RetrieverLive` 需要                                                                    |
| `APPROVAL_SIGNING_KEY`                              | —                              | ≥ 32 字符，与 mcp-ops 共用                                                              |
| `OBSERVABILITY_MCP_URL` / `OBSERVABILITY_MCP_TOKEN` | —                              | 设置后用 Streamable HTTP；否则每次调查 stdio 启动一个 mcp-observability                 |
| `OPS_MCP_URL` / `OPS_MCP_TOKEN`                     | —                              | 同上，针对 mcp-ops（每次执行启动一个）                                                  |
| `OBS_REPLAY_DIR`                                    | —                              | 回放模式：mcp-observability 以 `REPLAY_DIR=<它>`、`REPLAY_CASE=<告警 fingerprint>` 启动 |
| `AGENT_MAX_TURNS` / `AGENT_MAX_COST_USD`            | `12` / `0.6`                   | 超过后强制出报告                                                                        |
| `INVESTIGATION_TIMEOUT`                             | `5 minutes`                    | 超时记为 failed                                                                         |
| `MAX_CONCURRENT_INVESTIGATIONS`                     | `2`                            |                                                                                         |
| `APPROVER_ID`                                       | `console-operator`             | 写进审批令牌的审批人；接入 OIDC 后改为登录用户                                          |
| `API_AUDIT_LOG`                                     | `infra/.api-state/audit.jsonl` | 审计 JSONL（已 gitignore）                                                              |

## 测试

`pnpm --filter @incident/api test`，不访问网络：Claude 用真实 SDK + 假 `fetch`；mcp-observability 与 mcp-ops 用真实 server 通过内存 transport 连接（前者接假遥测，后者接假执行器但用真实的令牌校验）。`test/api.test.ts` 覆盖告警 → 分诊 → agent → 提议 → 审批 → mcp-ops 验签执行的完整路径。

## 本机端到端验证（G2：端到端冒烟评估）

在 Mac 上执行，约 3.5 美元（10 条冒烟用例上限，目前仓库里只有 3 条合成快照）：

```bash
docker compose -f infra/compose.yaml up -d
pnpm --filter @incident/rag rag ingest                 # 已入库可跳过
export ANTHROPIC_API_KEY=... VOYAGE_API_KEY=... DATABASE_URL=postgres://incident:incident@localhost:5432/incident
export APPROVAL_SIGNING_KEY=$(openssl rand -hex 32)

# 终端 1：api 以回放模式连接 mcp-observability
OBS_REPLAY_DIR=$PWD/packages/evals/.replay pnpm dev:api

# 终端 2：真实 agent + Claude judge
cd packages/evals
EVAL_REPLAY_DIR=$PWD/.replay EVAL_INCLUDE_SYNTHETIC=true EVAL_AGENT=api EVAL_JUDGE=claude pnpm eval:smoke
```

真实录制的快照（`pnpm --filter @incident/evals record ...`）合入后去掉 `EVAL_INCLUDE_SYNTHETIC`。
