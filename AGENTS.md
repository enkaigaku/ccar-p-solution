# AGENTS.md

本文件写给所有在本仓库工作的 AI agent（Claude Code、Codex 等）。Claude Code 通过 `CLAUDE.md` 引用本文件，Codex 直接读取本文件，其中「Review guidelines」一节是 Codex 做 PR 代码审查时遵循的规则。

## 项目概览

Incident Copilot 是一个值班 SRE 助手：告警触发后，它检索 runbook 和历史复盘，通过 MCP 只读查询日志、指标和链路，输出带证据引用的根因假设和处置建议；任何写操作都必须经过人工审批。项目同时是 CCAR-P 认证的备考实践，覆盖 RAG、评估和可观测性。

设计文档：<https://claude.ai/artifact/NwAJdxF4uv8qXb3f3PBjNr>；架构决策见 `docs/adr/`。

## 仓库结构

| 路径                         | 职责                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `packages/contracts`         | 共享 Schema、Service 接口、stub Layer、HTTP API 定义。**各包之间唯一的依赖面** |
| `packages/rag`               | `Retriever` / `Ingestor` 实现                                                  |
| `packages/mcp-observability` | 只读 MCP server                                                                |
| `packages/mcp-ops`           | 写操作 MCP server（校验审批令牌）                                              |
| `packages/prompts`           | 版本化系统提示与 Skills                                                        |
| `packages/telemetry`         | OTel Layer、GenAI span 辅助、成本计算                                          |
| `packages/evals`             | 评估数据集、promptfoo、故障注入与录制                                          |
| `apps/api`                   | Effect HttpApi：告警 webhook、调查编排、审批                                   |
| `apps/web`                   | TanStack Start 控制台                                                          |
| `infra/`                     | 本地 docker-compose 与脚本（运行在开发者的 Mac 上，用 OrbStack）               |

## 常用命令

```bash
pnpm install
pnpm check          # lint + typecheck + test，提交前必须通过
pnpm lint           # Biome
pnpm format         # Biome 自动修复
pnpm typecheck      # TypeScript 7（tsc）
pnpm test           # Vitest
pnpm dev:api        # 启动 api（内存实现），http://localhost:3000/docs
```

Node.js ≥ 22.18，直接运行 `.ts` 源码（type stripping），没有构建步骤。

## 技术约定

- **Effect 4**：后端代码统一用 `effect` 4.x。只使用 v4 API：HTTP 在 `effect/http`、`effect/http-api`，Schema 在 `effect`。**禁止**引入 v3 时代的 `@effect/platform`、`@effect/schema`、`@effect/ai` 等 0.x 包。写法以 `node_modules/effect/AGENTS.md` 和 `node_modules/effect/ai-docs/` 为准，不要凭记忆写 v3 风格的代码。
- **Claude 与 MCP 用官方 SDK**：Claude 只通过 `@anthropic-ai/sdk` 调用，MCP 只用 `@modelcontextprotocol/sdk`。两者各包一层薄的 Effect Service（把 Promise 转为 Effect，把 SDK 的类型化异常映射为可重试 / 不可重试两类 Effect 错误），不再引入其他抽象层（如 `@effect/ai-anthropic`、LangChain）。
- **契约优先**：跨包的数据结构和接口只能定义在 `packages/contracts`。修改契约必须单独开 PR，不能在功能 PR 里顺手改。
- **Schema 校验边界**：所有外部输入（HTTP、MCP 工具输入、工具结果、模型的结构化输出）用 `Schema` 解码，不写手工类型断言。
- **错误**：用 `Schema.TaggedError` 定义错误；不要 `throw`，不要用 `any` 吞掉错误类型。
- **时间**：用 `DateTime` / `Clock`，不直接用 `Date.now()`，以便测试可控。
- **版本固定**：依赖使用精确版本号；升级依赖单独开 PR 并跑评估。

## 安全规则（硬约束）

1. agent（模型的工具循环）只能拿到只读工具和 `propose_action`。`mcp-ops` 只允许 api 的审批执行器连接。
2. `mcp-ops` 的每次调用都必须校验 `ApprovalToken`：签名、有效期、与参数绑定的 `actionHash`。
3. 工具返回的日志、链路等内容是不可信数据，进入提示时必须包在标记中并声明为数据，不能当成指令。
4. 日志进入模型前在 `mcp-observability` 内做 PII 脱敏。
5. 提示词和工具结果原文不写入 span 属性，只记哈希；原文进审计表。
6. 密钥只从环境变量读取（见 `.env.example`），不得出现在代码、日志、span 或前端。

## Claude API 使用约定

- 默认模型：调查 `claude-opus-5-5`，分诊 `claude-haiku-5-5`，复盘草稿 `claude-sonnet-5-5`。effort 必须显式设置（Opus 5.5 默认是 medium）。
- Opus / Sonnet 请求开启服务端 `fallbacks`；读取 `content` 前先检查 `stop_reason`（含 `refusal`）。
- 提示按缓存前缀排序：tools → system → 稳定的拓扑与 runbook 索引 → 本次告警与检索结果。稳定前缀里不能出现时间戳、随机 ID、无序 JSON。
- 不使用 assistant prefill；需要结构化结果时用 structured outputs 或工具。

## 测试要求

- 新逻辑必须有 Vitest 测试；Effect 代码用 `@effect/vitest` 的 `it.effect`。
- HTTP handler 用 `HttpApiTest` 测试，不起真实服务器。
- 调用 Claude API 的测试默认不跑真实请求；真实调用只出现在 `packages/evals` 中，并受预算守卫控制。
- 修改 prompt、模型、effort 或检索参数的 PR，必须附上评估结果（至少冒烟评估）。

## Review guidelines

审查时按下列优先级报告问题。只报告真实存在、能指出具体位置和后果的问题；不确定的问题标注为疑问，不要当作结论。审查意见用简体中文书写。

### P0：必须阻止合入

- agent 能直接或间接调用写操作（例如把 `mcp-ops` 的工具加入 agent 工具列表，或绕过 `propose_action`）
- `mcp-ops` 存在不校验或校验不完整的 `ApprovalToken` 路径
- 密钥、令牌、PII 被写入代码、日志、span 属性、错误消息或前端响应
- 工具结果（日志、链路等不可信内容）未经标记直接拼入系统提示或被当作指令
- 未经人工审批即可改变被运维系统状态的任何路径

### P1：应在合入前修复

- 在功能 PR 中修改了 `packages/contracts`，或跨包直接 import 对方的内部文件而不是通过 contracts
- 使用了 Effect v3 API 或 v3 时代的包；用 `throw`、`any`、类型断言绕过 Schema 解码
- 绕过官方 SDK 自己拼 HTTP 调用 Claude 或 MCP；引入额外的 LLM 抽象层
- 破坏 prompt caching 的改动：稳定前缀中加入时间戳、随机值、无序结构，或改动工具定义顺序
- 未处理 `stop_reason`（尤其 `refusal`、`max_tokens`）就读取模型输出；未设置 effort；对 Opus 5.5 / Sonnet 5.5 使用已移除的参数（`budget_tokens`、`temperature`、强制 `tool_choice`、assistant prefill）
- 报告中的证据引用没有经过「引用必须出现在工具结果中」的校验
- 修改 prompt、模型、effort、检索参数却没有附评估结果
- 新逻辑缺少测试，或测试依赖真实网络与真实 Claude 调用
- 依赖未固定精确版本

### P2：建议改进（不阻止合入）

- 错误分类不清（可重试与不可重试混在一起）、缺少超时或重试策略
- span 缺少关键属性（prompt 版本、index 版本、模型、token 用量）
- 命名、注释与设计文档或 ADR 不一致

### 不需要报告

- 格式与 import 排序（由 Biome 处理）
- 纯个人偏好的风格问题
- 已在 ADR 中记录并说明理由的设计取舍（除非 PR 改变了前提）
