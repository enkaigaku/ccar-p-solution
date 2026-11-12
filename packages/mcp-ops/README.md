# @incident/mcp-ops

写操作 MCP server，工具契约见 `@incident/contracts` 的 `OpsTools`。用官方 `@modelcontextprotocol/sdk` 的底层 `Server` 实现，`tools/list` 的 JSON Schema 由契约 Schema 生成，入参用同一 Schema 解码。

**只有 api 的审批执行器连接本 server，不挂到 agent 上。**

## 工具

| 工具               | 动作                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `toggle_flag`      | 改 flagd 配置文件（`demo.flagd.json`）里该 flag 的 `defaultVariant`，原地写回，flagd 自动热加载      |
| `restart_service`  | `docker restart` 该 compose service 的全部容器                                                       |
| `rollback_service` | 把该 service 的镜像改为 `<当前镜像仓库>:<imageTag>`，写入覆盖文件后 `docker compose up -d --no-deps` |

## 审批令牌校验（`ApprovalVerifier`）

每次调用按以下顺序校验，任一失败即拒绝，不会触达执行器：

1. 签名：HMAC-SHA256，密钥 `APPROVAL_SIGNING_KEY`，算法见 contracts 的 `ApprovalSigning.ts`
2. 未过期：`now < expiresAt`
3. 有效期不超过 10 分钟：`expiresAt <= now + 10min`
4. 参数绑定：本次入参构造的 `OpsAction` 的 `actionHash` 等于令牌里的 `actionHash`（换工具、换参数都会失败）
5. 一次性：同一 `proposalId` 的令牌只能成功使用一次（进程内记录；令牌最长 10 分钟有效，重启窗口是唯一缺口，M2 改为查审计表）

被拒绝的调用不会消耗令牌。另外 service 名和镜像 tag 有格式校验，保证不会被当作 CLI 选项解析。

## 审计

每次调用都追加一行 JSONL 到 `OPS_AUDIT_LOG`：`rejected`（含原因）、`accepted`（执行前写入，写不进去就不执行）、`executed` / `failed` / `dry_run`。不记录签名。M2 由 api 同步到 Postgres 审计表。

## 运行

```bash
# stdio（审批执行器以子进程方式启动）
APPROVAL_SIGNING_KEY=... node packages/mcp-ops/src/main.ts

# Streamable HTTP（无状态模式），需要 bearer token
MCP_TRANSPORT=http MCP_HTTP_TOKEN=... APPROVAL_SIGNING_KEY=... node packages/mcp-ops/src/main.ts

# 用 MCP Inspector 检查（dry run 不改动 demo）
OPS_DRY_RUN=true APPROVAL_SIGNING_KEY=... npx @modelcontextprotocol/inspector node packages/mcp-ops/src/main.ts
```

| 环境变量                           | 默认值                                     | 说明                                     |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `APPROVAL_SIGNING_KEY`             | 必填                                       | ≥ 32 字符，与 api 共用                   |
| `OTEL_DEMO_DIR`                    | `infra/.otel-demo`                         | `otel-demo.sh` 克隆的 demo 目录          |
| `OTEL_DEMO_COMPOSE_PROJECT`        | `opentelemetry-demo`                       | compose 项目名                           |
| `OTEL_DEMO_COMPOSE_FILES`          | `compose.yaml,compose.extras.yaml`         | 与 `otel-demo.sh` 一致，不存在的文件跳过 |
| `FLAGD_CONFIG_PATH`                | `$OTEL_DEMO_DIR/src/flagd/demo.flagd.json` |                                          |
| `OPS_STATE_DIR`                    | `infra/.ops-state`                         | 回滚覆盖文件与审计日志（已 gitignore）   |
| `OPS_AUDIT_LOG`                    | `$OPS_STATE_DIR/audit.jsonl`               |                                          |
| `OPS_DRY_RUN`                      | `false`                                    | 只校验和审计，不执行                     |
| `MCP_TRANSPORT`                    | `stdio`                                    | `stdio` / `http`                         |
| `MCP_HTTP_HOST` / `PORT` / `TOKEN` | `127.0.0.1` / `3102` / 必填                | 仅 http 模式                             |

注意：回滚覆盖文件只在本 server 执行回滚时生效，之后用 `otel-demo.sh up` 重启 demo 会回到原镜像。

**G1 验收**：无 token、过期 token、参数被篡改的 token 三种调用都被拒绝，见 `test/OpsServer.test.ts`。
