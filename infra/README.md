# infra

本地环境运行在开发者的 Mac 上（OrbStack，建议给 Docker 分配约 12GB 内存）。

```bash
docker compose -f infra/compose.yaml up -d   # 项目自身依赖：Postgres + pgvector
infra/scripts/otel-demo.sh up                # 被运维系统：OpenTelemetry Demo 3.1.0（约 6GB 内存）
```

- OTel Demo 自带 flagd（故障注入）、OTel Collector、Prometheus 与 Grafana。Loki / Tempo 的接入与 Collector 的导出配置属于 `packages/telemetry` 和 `packages/mcp-observability` 的工作包。
- Keycloak（OIDC）在 M2 接入审批流时加入本文件。
