# apps/web

Incident Copilot 的 Web 控制台（TanStack Start 1.x，由官方脚手架 `@tanstack/cli create --blank` 生成后改造）。

## 运行

```bash
pnpm dev:api                         # 另一个终端：apps/api 内存版，http://localhost:3000
pnpm --filter @incident/web dev      # http://localhost:3001
```

`API_URL`（默认 `http://localhost:3000`）只在 Web 服务端读取。浏览器只访问同源的 `/api/*`，由 `src/routes/api.$.ts` 转发到 `apps/api`，所以不需要 CORS，前端也拿不到 API 地址或任何密钥。开发环境的告警页有「发送示例告警」按钮，用来在没有 Alertmanager 时造数据。

## 页面

| 路由                  | 内容                                                           |
| --------------------- | -------------------------------------------------------------- |
| `/`                   | 告警列表、发起调查、本浏览器最近打开的调查、按 ID 打开调查     |
| `/investigations/$id` | 调查过程时间线（SSE 实时）、根因假设与证据、处置建议审批、反馈 |

审批要点两次：第二次会复述将要执行的操作。低置信度或「信息不足」的报告有醒目标记；页面展示模型、prompt 版本、索引版本和 trace id，所有模型结论都标注「AI 生成」。

## 结构

| 路径                                        | 职责                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/lib/IncidentClient.ts`                 | 由 `@incident/contracts` 的 `IncidentApi` 经 `HttpApiClient` 派生的类型安全客户端                                      |
| `src/lib/InvestigationEvents.ts`            | `GET /investigations/:id/events` 的 SSE 客户端：逐条按 `InvestigationEvent` 解码，断线指数退避重连并带 `Last-Event-ID` |
| `src/investigation/live.ts`                 | 纯函数 reducer：把快照、事件、连接状态合成页面状态                                                                     |
| `src/investigation/useLiveInvestigation.ts` | 优先用 SSE；API 返回 404/405/501 时退回每 3 秒轮询快照，直到终态                                                       |
| `src/server/apiProxy.ts`                    | `/api/*` 反向代理，流式透传响应（SSE 可用），不转发 cookie，上游不可达时返回不含内部地址的 502                         |
| `src/lib/runtime.ts`                        | React 与 Effect 之间唯一的桥：`ManagedRuntime` + `FetchHttpClient`                                                     |

路由 loader 只在浏览器执行（`src/start.ts` 里 `defaultSsr: false`），因为 loader 返回的是解码后的契约类（`DateTime`、branded id），SSR 的序列化无法传递；服务端只负责页面外壳和 `/api` 代理。

`src/routeTree.gen.ts` 由 TanStack Router 插件生成（`pnpm dev` / `pnpm build` 时更新），提交到仓库以便 `tsc` 在 CI 中直接类型检查。

## 与 apps/api 的约定

- SSE：`data:` 是 JSON 编码的 `InvestigationEvent`；`id:` 可选，带上后断线重连能续传。调查进入终态后客户端主动断开，服务端提前关闭会被视为断线并重连。M1 的 api 还没有这个路由，页面会自动退回轮询并显示「轮询中」。
- 契约里没有「列出调查」的接口，首页的「最近打开的调查」只存在本浏览器的 localStorage 里。

## 测试

`pnpm --filter @incident/web test`：reducer、SSE 解码与重连（`TestClock`）、轮询回退、HttpApiClient 编解码、代理、审批与反馈组件（jsdom）。全部用内存 `HttpClient`，不连网络。
