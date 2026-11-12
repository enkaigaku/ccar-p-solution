# @incident/mcp-observability

M1 工作包。只读 MCP server，工具契约见 `@incident/contracts` 的 `ObservabilityTools`。

**实现约束**

- 用官方 `@modelcontextprotocol/sdk`；`tools/list` 的 inputSchema 由 `Schema.toJsonSchemaDocument` 从契约生成，输入用同一 Schema 解码
- 传输：stdio（本地）与 Streamable HTTP（部署）
- 返回聚合结果而非原始数据；日志进入返回值前做 PII 脱敏，脱敏规则需单元测试
- 每个结果带 `ref`，agent 的报告只能引用出现过的 `ref`
- `REPLAY_DIR` 设置时从录制快照返回结果，供评估复现

**G1 验收**：MCP Inspector 能列出并调用全部 5 个工具；replay 模式有测试。
