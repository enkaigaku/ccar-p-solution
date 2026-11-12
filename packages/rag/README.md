# @incident/rag

M1 工作包。实现 `@incident/contracts` 中的 `Retriever` 和 `Ingestor` Service：Markdown 切块、Voyage embedding、Postgres（pgvector HNSW + `tsvector`）混合检索、RRF 融合、Voyage rerank，以及带评估门禁的索引版本管理。

## 对外提供

| 导出                                                                     | 说明                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `RetrieverLive`                                                          | contracts 的 `Retriever`，查询当前 active 版本                                            |
| `IngestorLive`                                                           | contracts 的 `Ingestor`，增量更新并立即激活（用于复盘草稿审核后写回）                     |
| `RagIndexLive`                                                           | 本包内部的索引管理：全量重建（不自动激活）、评估、激活 / 回滚、清理旧版本。只给本包脚本用 |
| `MemoryChunkStoreLayer`、`HashingEmbedderLayer`、`IdentityRerankerLayer` | 离线实现，用于测试和无 Voyage key 的本地验证，不能用于生产索引                            |

三个 Live Layer 都需要外部提供 Postgres 的 `SqlClient`（例如 `PgClient.layerConfig`），这样 api 的业务表、审计表和检索共用一个连接池。构建时会自动跑本包的迁移（迁移记录在 `rag_migrations` 表，不与其他包冲突）。

```ts
import { PgClient } from "@effect/sql-pg"
import { IngestorLive, RetrieverLive } from "@incident/rag"

const RagLive = Layer.mergeAll(RetrieverLive, IngestorLive).pipe(
  Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
)
```

## 环境变量

| 变量                     | 默认值                        | 说明                                          |
| ------------------------ | ----------------------------- | --------------------------------------------- |
| `VOYAGE_API_KEY`         | 必填                          | 只在服务端读取，不进日志、span 和错误消息     |
| `VOYAGE_BASE_URL`        | `https://api.voyageai.com/v1` |                                               |
| `RAG_EMBEDDING_MODEL`    | `voyage-4`                    | 输出维度固定 1024（与 `vector(1024)` 列一致） |
| `RAG_RERANK_MODEL`       | `rerank-2.5`                  |                                               |
| `VOYAGE_TIMEOUT`         | `20 seconds`                  | 单次请求超时；429 / 5xx / 超时最多重试 3 次   |
| `RAG_TEXT_SEARCH_CONFIG` | `english`                     | 记录在每个索引版本上，查询时用版本自己的配置  |

## 管道

1. **切块**（`src/chunking/`）：runbook 按 H2/H3 切，复盘按 H2（现象 / 根因 / 处置）切；超过 512 token 的段落按段落、句子、字符逐级拆分，窗口之间重叠 64 token。代码块里的 `#` 注释不会被当成标题。front matter 支持 `service` 和 `alerts`（逗号分隔的告警名）。
2. **块 ID**：`<sourceId>#<标题路径 slug>`，例如 `runbooks/checkout.md#high-error-rate/diagnosis`；同一节拆成多个窗口时后续窗口加 `.2`、`.3`。正文修改不会改变 ID，只有改标题才会变，所以检索集标注和报告里的引用在文档更新后仍然有效。
3. **嵌入**：嵌入的文本是「标题路径 + 告警名 + 正文」，正文本身作为 `Chunk.text` 返回给调用方引用。内容哈希没变的块直接复用上一版本的向量，不再调用 Voyage。
4. **检索**：先按 `service`（同时保留没有 service 的通用文档）和 `corpora` 过滤，向量 top 30 与全文 top 30 并行，RRF（k=60）融合后 Voyage rerank 取 top `limit`（默认 8）。
5. **降级**：查询嵌入失败时只用全文检索；rerank 失败时返回 RRF 顺序；都会写 warning 日志，并在 span 上记录 `rag.degraded`。只有数据库失败才返回 `RetrievalError`。
6. **可观测性**：`rag.search` / `rag.ingest` span 记录 index 版本、embedding 模型、各路候选数、top-1 分数、降级原因。查询原文不进 span，只记 `rag.query_hash`。

## 索引版本

- 每次写入都生成新版本（`idx-<UTC 时间>-<随机>`），版本上记录 embedding 模型、全文检索配置和切块参数。
- `Ingestor.ingest(docs)`：在 active 版本基础上替换这些来源，新版本立即激活。传入空 markdown 可删除一个来源。并发写入用 advisory lock 串行，基线变化时自动重试。
- `RagIndex.rebuild(docs)`：生成只包含 `docs` 的候选版本，**不激活**。脚本对候选版本和当前版本跑检索集，recall@8 低于 0.85 或比当前版本下降超过 5 个百分点就不切换（设计文档的门禁）。
- 候选版本只有在它的基线版本仍是 active 时才能激活，避免覆盖期间的增量写入；退役版本可以随时重新激活（回滚）。
- embedding 模型变化时，增量写入会被拒绝，需要走一次全量重建。

## 命令

```bash
pnpm --filter @incident/rag rag ingest            # 重建 corpus/ → 评估 → 门禁通过才激活
pnpm --filter @incident/rag rag ingest --offline  # 不调用 Voyage，只验证 SQL 路径
pnpm --filter @incident/rag rag eval              # 评估当前版本
pnpm --filter @incident/rag rag versions          # 列出版本
pnpm --filter @incident/rag rag activate <version> # 激活 / 回滚
pnpm --filter @incident/rag rag prune 3           # 只保留最近 3 个非 active 版本
```

需要 `DATABASE_URL`；`ingest` / `eval` 不带 `--offline` 时还需要 `VOYAGE_API_KEY`。

## 语料与检索集

- `corpus/runbooks/`：OTel Demo 主要服务的 runbook（11 篇），按 flagd 故障场景组织诊断与处置步骤。
- `corpus/postmortems/`：6 篇内部复盘。
- `eval/retrieval-seed.json`：42 条「查询 → 应召回的块 ID」，覆盖精确告警名、症状描述、带 service 过滤和只查复盘的情况。完整的约 100 条检索集在 `packages/evals`，本文件是本包自己的回归基线。

## 测试

```bash
pnpm --filter @incident/rag test                  # 单元测试 + 内存实现的管道测试，不连网络
RAG_TEST_DATABASE_URL=postgres://incident:incident@localhost:5432/incident \
  pnpm --filter @incident/rag test                # 额外跑 Postgres 集成测试（临时建库，结束后删除）
```

离线模型（特征哈希嵌入 + 原序 rerank）在种子检索集上的 recall@8 为 96.4%、MRR 0.890，只能说明切块、全文检索和融合没有退化；真实质量以 Voyage 的结果为准。

**G1 验收**：对 `infra/compose.yaml` 中的 Postgres 跑通 ingest + search；检索集 recall@8 ≥ 0.85。
