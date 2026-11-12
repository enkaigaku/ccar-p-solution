# @incident/mcp-ops

M1 工作包。写操作 MCP server，工具契约见 `@incident/contracts` 的 `OpsTools`。

**实现约束**

- 只有 api 的审批执行器连接本 server，**不挂到 agent 上**
- 每次调用校验 `ApprovalToken`：签名有效、未过期、`actionHash` 与本次参数一致；任一不满足直接拒绝
- 动作通过 OTel Demo 的 flagd 与 docker compose 执行；每次执行写审计日志

**G1 验收**：无 token、过期 token、参数被篡改的 token 三种调用都被拒绝（有测试）。
