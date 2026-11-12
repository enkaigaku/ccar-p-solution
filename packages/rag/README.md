# @incident/rag

M1 工作包。实现 `@incident/contracts` 中的 `Retriever` 和 `Ingestor` Service。

**提供**：`RetrieverLive`、`IngestorLive` 两个 Layer（依赖 Postgres 连接与 Voyage API Key）。

**范围**

- Markdown 解析与切块：runbook 按 H2/H3 标题切；复盘按「现象 / 根因 / 处置」切，约 512 token、重叠 64
- 内容哈希增量更新；每次重建生成新的 `indexVersion`
- pgvector（HNSW）+ `tsvector` 混合检索，RRF 融合，Voyage rerank 取 top 8
- 检索评估集与 recall@8、MRR 的 Vitest 测试

**G1 验收**：对 `infra/compose.yaml` 中的 Postgres 跑通 ingest + search；检索集 recall@8 ≥ 0.85。
