# @incident/telemetry

M1 工作包。提供 `TelemetryLive` Layer（OTLP 导出到 OTel Collector）、GenAI span 辅助函数、按模型单价计算成本。

**说明**：官方 `@anthropic-ai/sdk` 自带 OpenTelemetry 支持（beta），会生成 `anthropic.messages.create` span；本包负责让它们挂到 Effect 编排 span 之下，并补充 prompt 版本、index 版本等业务属性。提示词与工具结果原文不进 span，只记哈希。

**G1 验收**：api 启动后，一次请求的 trace 能在 Grafana/Tempo 中看到；成本计算有单测。
