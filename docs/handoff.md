# 交接文档

写给接手 Incident Copilot 的人：它现在是什么状态、东西在哪、第一天怎么跑起来、哪些事还没做。日常操作和排障在[运维手册](runbook.md)，M3 的经过和教训在 [M3 阶段复盘](retro-m3.md)。规则（技术约定、安全硬约束、审查标准）以 [`AGENTS.md`](../AGENTS.md) 为准，这里不重复。

状态截至 2026-11-15，`main` 在 #32 之后。

## 一句话

告警触发后，系统检索 runbook 和历史复盘，通过 MCP 只读查询日志、指标和链路，输出带证据引用的根因假设和处置建议；任何写操作都要一个有 approver 角色的登录用户批准，批准后由 api 签发一次性令牌，交给 mcp-ops 执行。被运维的系统是跑在开发者 Mac 上的 OpenTelemetry Demo。

## 现在的状态

| 阶段 | 内容                                                               | 状态                                    |
| ---- | ------------------------------------------------------------------ | --------------------------------------- |
| M0   | 骨架与接口约定                                                     | 完成                                    |
| M1   | 六个工作包：rag、mcp-observability、mcp-ops、evals、telemetry、web | 完成                                    |
| M2   | Agent 编排集成（apps/api）                                         | 完成，G2 通过                           |
| M3   | 评估驱动优化                                                       | 完成，G3 通过，见[复盘](retro-m3.md)    |
| M4   | 运维化与交付（没有门禁，范围自己定）                               | 进行中：登录、对抗集、CI 评估、本组文档 |

M3 结束时的数字（两次全量评估，各 51 个真实故障用例，详见 [`reports/2026-11-15-slo.md`](../packages/evals/reports/2026-11-15-slo.md)）：

| 指标              | 目标        | 结果                            |
| ----------------- | ----------- | ------------------------------- |
| 根因 top-1        | ≥ 70%       | 94.1%、94.1%                    |
| 根因 top-3        | ≥ 85%       | 96.1%、94.1%                    |
| 引用有效性        | 100%        | 51/51                           |
| 未审批写操作      | 0           | 0                               |
| 首份调查报告 p95  | ≤ 90 s      | 65.8 s、75.9 s                  |
| prompt 缓存命中率 | ≥ 70%       | 82.5%、83.0%                    |
| 单次调查成本      | ≤ 0.30 美元 | 平均 0.18，每次有 3 到 4 条超出 |

之后又有两项变化：延迟调查改为 `method-latency@3`（只在 19 条相关用例上验证过，没有重跑全量，见 [`reports/2026-11-15-callee.md`](../packages/evals/reports/2026-11-15-callee.md)）；对抗集扩到 18 条真实用例并跑过一次（见 [`reports/2026-11-15-adversarial.md`](../packages/evals/reports/2026-11-15-adversarial.md)）。

这些数字有一个必须带着读的限制：**模型认识 OpenTelemetry Demo**，runbook 语料里也写着 flag 名和症状的对应关系，所以这套用例对它偏容易，结论不能外推到陌生系统。

## 东西在哪

| 想了解                       | 看这里                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 为什么这样设计               | [设计文档](Incident%20Copilot%20Design.md)、[`docs/adr/`](adr/README.md)（10 条）                                                                |
| 一次调查的完整流程           | [`apps/api/README.md`](../apps/api/README.md)「一次调查」                                                                                        |
| 安全约束落在哪行代码         | 同上「安全约束在代码里的位置」                                                                                                                   |
| 跨包的数据结构和接口         | `packages/contracts`（各包之间唯一的依赖面，改它要单独开 PR）                                                                                    |
| 提示词和方法论               | `packages/prompts`（改了必须升版本号并附评估结果）                                                                                               |
| 检索怎么做、索引怎么换版本   | [`packages/rag/README.md`](../packages/rag/README.md)                                                                                            |
| 两个 MCP server 的工具和校验 | [`packages/mcp-observability/README.md`](../packages/mcp-observability/README.md)、[`packages/mcp-ops/README.md`](../packages/mcp-ops/README.md) |
| 评估怎么跑、用例怎么录       | [`packages/evals/README.md`](../packages/evals/README.md)                                                                                        |
| 历次评估的结论               | `packages/evals/reports/`（6 份）                                                                                                                |
| span、指标、成本计算         | [`packages/telemetry/README.md`](../packages/telemetry/README.md)                                                                                |
| 本地环境、登录、看板和告警   | [`infra/README.md`](../infra/README.md)                                                                                                          |
| 控制台                       | [`apps/web/README.md`](../apps/web/README.md)                                                                                                    |

## 第一天

1. Node.js ≥ 22.18（见 `.nvmrc`）和 pnpm。`pnpm install && pnpm check` 应当全部通过，不需要任何密钥和容器。
2. `AUTH_MODE=dev pnpm dev:api`，打开 <http://localhost:3000/docs>。这是内存实现、不认证的 api，用来看接口。
3. 再开一个终端 `pnpm --filter @incident/web dev`，打开 <http://localhost:3001>，点「发送示例告警」再发起调查。没有 `ANTHROPIC_API_KEY` 时调查会失败并打 warning，这是预期的。
4. `pnpm --filter @incident/evals eval:ci` 跑一次不花钱的冒烟评估，熟悉评估的输出。
5. 要看真实的调查，按[运维手册](runbook.md)「启动全套环境」准备密钥和容器。

## 需要的账号和密钥

密钥只从环境变量读，清单和说明在 [`.env.example`](../.env.example)。仓库里没有任何密钥，CI 里也没有。

| 变量                                                                      | 用途                         | 从哪来                                |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| `ANTHROPIC_API_KEY`                                                       | 分诊、调查、judge            | Claude Console，月度上限 500 美元     |
| `VOYAGE_API_KEY`                                                          | 嵌入和 rerank                | Voyage 控制台；不绑定付款方式会被限流 |
| `APPROVAL_SIGNING_KEY`                                                    | api 签审批令牌，mcp-ops 验签 | 自己生成：`openssl rand -hex 32`      |
| `OIDC_CLIENT_SECRET`、`KEYCLOAK_ADMIN_PASSWORD`、`KEYCLOAK_DEMO_PASSWORD` | 本地 Keycloak 和控制台登录   | 自己生成                              |

API 花费由 `packages/evals` 的预算守卫记在本机的账本里（`packages/evals/.ledger/`）。**账本不在仓库里，换机器就看不到之前的用量**，换机器后用 `EVAL_MONTH_SPEND_USD` 手工带上当月已用金额。2026 年 11 月已用 73.56 美元，全量评估 8/8 用完，冒烟 17/50。

## 工作方式

- 开发在功能分支上，PR 由 Codex 审查（规则是 `AGENTS.md` 的「Review guidelines」），开 PR 的人逐条判断审查意见：成立的修改并推送，不成立的在 PR 上回复理由。
- 提交前 `pnpm check`。CI 另外跑检索评估和 stub 冒烟评估（都不花钱）。
- 改 prompt、模型、effort 或检索参数的 PR 必须附评估结果；评估报告写进 `packages/evals/reports/`，格式照已有的几份。
- 花钱的评估先看预算（`evals budget`），并且先得到项目所有者的同意。项目里有一个 Claude Code Skill 记着这套流程：[`.claude/skills/run-evals/SKILL.md`](../.claude/skills/run-evals/SKILL.md)。

## 已知的缺口

按「会不会咬人」排序。前四项是真实的功能缺口，后面是评估结论的可信度问题。

1. **api 的业务状态在内存里。** 告警、调查和提议都在 `IncidentStore` 的一个 `Ref` 里，api 重启就没了；反馈和复盘草稿已经落 Postgres（ADR 011）。审计是例外，写在 JSONL 文件里（`infra/.api-state/audit.jsonl`、`infra/.ops-state/audit.jsonl`），设计里的 Postgres 审计表没有做。
2. **控制台会话在 web 进程内存里**，重启后所有人要重新登录。单实例本地部署可以接受，理由在 ADR 010。
3. **审批令牌的「一次性」是进程内记录。** mcp-ops 重启后，一个还没过期（最长 10 分钟）的令牌可以再用一次。
4. **反馈闭环只在离线测试里验证过。** 复盘草稿生成（Sonnet）、审核后回写知识库、反馈落库并整理成评估用例都已实现（ADR 011），复盘的 prompt 只有冒烟评估（`evals postmortem-smoke`，只判断是否采用了响应者给的根因），没有完整的评估集，`curate` 也还没有在真实的线上反馈上跑过；反馈用例的快照只含 agent 当时问过的查询。
5. **两条稳定失败的用例只在小范围验证过修复。** `fc-4152bfe3`、`fc-bcd25bc1`（国际运费慢）在 `method-latency@3` 下命中，但没有重跑全量确认别的用例没有回退。
6. **单次调查成本有少数超标。** imageSlowLoad 的两条用例稳定超过 0.30 美元，贵在 frontend-proxy 的日志。试过缩短日志样本，没解决，没有合入。
7. **容器重启次数是累计值**，不能说明重启发生在故障期间。要改成窗口内的增量需要改 contracts 并重新录制快照。
8. **评估结论不能外推。** 除了模型认识 demo，还有：每种配置最多跑两次；judge 的校准样本和调过的评分说明来自同一批数据；51 个用例来自 12 个 flag，同一故障的不同强度并不独立。
9. **对抗集的新评分规则没有在真实评估里跑过。** 两条告警注入用例在旧规则下被误判，新规则下应当通过，这是推断。
10. **CI 里没有真实评估。** CI 的两项评估只查接线和回退，不调用 Claude 或 Voyage。
11. **web 的开发端口 3001 和 Grafana 的 3001 冲突**，同时运行时给 web 换端口并改 `WEB_ORIGIN`。

设计文档留给 M4 而一直搁置的还有两项：kind 上的 k8s 场景，Langfuse 对比实验（ADR 008）。

## 下一步的候选

项目所有者已经看过这四个方向，A 和 C 已做：

| 候选               | 内容                                                                   | 状态    |
| ------------------ | ---------------------------------------------------------------------- | ------- |
| A 安全与治理补全   | OIDC 登录、审批人为登录用户、对抗集扩到约 20 条                        | 完成    |
| B 反馈闭环         | 复盘草稿、回写知识库、反馈落库并挑进评估集（ADR 011）                  | 完成    |
| C 交付与团队赋能   | 交接文档、运维手册、M3 复盘、项目级 Skill、CI 评估                     | 本组 PR |
| D 检验结论能否外推 | 用改名后的服务做一组用例，补独立的 judge 校准样本。要在 Mac 上重新录制 | 未开始  |

B 没有做「业务状态和审计落库」：告警、调查、提议仍在内存，审计仍是 JSONL。如果接着只做一件，建议做它，上面第 1、3 项都以它为前提。
