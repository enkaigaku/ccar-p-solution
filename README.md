# ccar-p-solution

Incident Copilot：面向 CCAR-P 备考的端到端 Claude 解决方案，覆盖 RAG、评估和可观测性。

告警触发后，系统检索 runbook 和历史复盘，通过 MCP 只读查询日志、指标和链路，输出带证据引用的根因假设和处置建议；任何写操作都必须经过人工审批。

- 设计文档：<https://claude.ai/artifact/NwAJdxF4uv8qXb3f3PBjNr>
- 架构决策：[`docs/adr/`](docs/adr/README.md)
- 开发与审查规则：[`AGENTS.md`](AGENTS.md)

## 快速开始

```bash
pnpm install
pnpm check                                   # lint + typecheck + test
pnpm dev:api                                 # http://localhost:3000/docs
docker compose -f infra/compose.yaml up -d   # Postgres + pgvector
infra/scripts/otel-demo.sh up                # OpenTelemetry Demo（被运维系统）
```

## 里程碑

| 阶段 | 内容                                                               | 门禁                       |
| ---- | ------------------------------------------------------------------ | -------------------------- |
| M0   | 骨架与接口约定                                                     | 接口与 Schema 冻结         |
| M1   | 并行工作包：rag、mcp-observability、mcp-ops、evals、telemetry、web | 各包对 stub 与契约测试通过 |
| M2   | Agent 编排集成（apps/api）                                         | 端到端冒烟评估通过         |
| M3   | 评估驱动优化                                                       | SLO 达标                   |
| M4   | 运维化与交付                                                       | —                          |
