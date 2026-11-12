# apps/web

M1 工作包。TanStack Start 1.x 控制台，在本包工作包开始时用官方脚手架生成。

**约束**

- API 客户端由 `@incident/contracts` 的 `IncidentApi` 通过 `HttpApiClient` 派生，不手写请求类型
- M1 期间对接 `apps/api` 的内存版实现（`pnpm dev:api`），不等 Agent 编排完成
- 页面：告警列表、调查详情与过程回放（SSE，事件类型见 `InvestigationEvent`）、审批、反馈
