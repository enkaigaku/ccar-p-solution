import { type Alert, InvestigationId } from "@incident/contracts"
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router"
import { DateTime, Effect, Order } from "effect"
import { useEffect, useState } from "react"
import { SeverityBadge } from "../components/Badges.tsx"
import { formatTime } from "../lib/format.ts"
import { IncidentClient } from "../lib/IncidentClient.ts"
import { run } from "../lib/load.ts"
import { type Recent, readRecent, rememberInvestigation } from "../lib/recent.ts"
import { sampleWebhook } from "../lib/sampleAlert.ts"

const newestFirst = Order.mapInput(Order.flip(DateTime.Order), (a: Alert) => a.startsAt)

export const Route = createFileRoute("/")({
  loader: () =>
    run(
      IncidentClient.use((client) => client.alerts.list()).pipe(Effect.map((alerts) => [...alerts].sort(newestFirst))),
    ),
  component: AlertsPage,
})

function AlertsPage() {
  const loaded = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [starting, setStarting] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [recent, setRecent] = useState<Recent>([])

  // Storage is read after mount so the first render does not depend on browser-only state.
  useEffect(() => setRecent(readRecent()), [])

  const startInvestigation = async (alert: Alert) => {
    setStarting(alert.id)
    setError(undefined)
    const result = await run(
      IncidentClient.use((client) => client.investigations.start({ payload: { alertId: alert.id } })),
    )
    setStarting(undefined)
    if (result._tag === "Failed") return setError(result.message)
    rememberInvestigation(result.value.id, alert.name)
    await navigate({ to: "/investigations/$id", params: { id: result.value.id } })
  }

  const sendSample = async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* IncidentClient
        return yield* client.alerts.webhook({ payload: yield* sampleWebhook })
      }),
    )
    if (result._tag === "Failed") return setError(result.message)
    await router.invalidate()
  }

  return (
    <main className="page">
      <div className="page-head">
        <h1>告警</h1>
        <div className="actions">
          {import.meta.env.DEV ? (
            <button type="button" onClick={sendSample} title="仅开发环境：向 /alerts/webhook 发送一条示例告警">
              发送示例告警
            </button>
          ) : null}
          <button type="button" onClick={() => router.invalidate()}>
            刷新
          </button>
        </div>
      </div>

      {error === undefined ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loaded._tag === "Failed" ? (
        <p className="error" role="alert">
          {loaded.message}
        </p>
      ) : loaded.value.length === 0 ? (
        <p className="empty">
          暂无告警。Alertmanager 的 webhook 指向 <code>POST /alerts/webhook</code> 后，告警会出现在这里。
        </p>
      ) : (
        <div className="table-wrap">
          <table className="alerts">
            <thead>
              <tr>
                <th>严重度</th>
                <th>告警</th>
                <th>服务</th>
                <th>摘要</th>
                <th>开始时间</th>
                <th>状态</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {loaded.value.map((alert) => (
                <tr key={alert.id}>
                  <td>
                    <SeverityBadge severity={alert.severity} />
                  </td>
                  <td>{alert.name}</td>
                  <td>
                    <code>{alert.service}</code>
                  </td>
                  <td>{alert.summary}</td>
                  <td>{formatTime(alert.startsAt)}</td>
                  <td>{alert.status === "firing" ? "触发中" : "已恢复"}</td>
                  <td>
                    <button
                      type="button"
                      className="primary"
                      disabled={starting !== undefined}
                      onClick={() => startInvestigation(alert)}
                    >
                      {starting === alert.id ? "发起中…" : "发起调查"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="recent">
        <h2>最近打开的调查</h2>
        {recent.length === 0 ? (
          <p className="empty">本浏览器还没有打开过调查。</p>
        ) : (
          <ul>
            {recent.map((r) => (
              <li key={r.id}>
                <Link to="/investigations/$id" params={{ id: r.id }}>
                  {r.alertName}
                </Link>{" "}
                <code>{r.id}</code>
              </li>
            ))}
          </ul>
        )}
        <OpenById />
      </section>
    </main>
  )
}

function OpenById() {
  const navigate = useNavigate()
  const [value, setValue] = useState("")
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault()
        const id = value.trim()
        if (id !== "") void navigate({ to: "/investigations/$id", params: { id: InvestigationId.make(id) } })
      }}
    >
      <label>
        按 ID 打开调查
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="investigation id" />
      </label>
      <button type="submit">打开</button>
    </form>
  )
}
