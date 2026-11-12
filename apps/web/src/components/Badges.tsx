import type { InvestigationStatus, Severity } from "@incident/contracts"
import type { Connection } from "../investigation/live.ts"
import { severityLabel, statusLabel } from "../lib/format.ts"

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge severity-${severity}`}>{severityLabel[severity]}</span>
}

export function StatusBadge({ status }: { status: InvestigationStatus }) {
  return <span className={`badge status-${status}`}>{statusLabel[status]}</span>
}

const connectionLabel: Record<Connection, string> = {
  connecting: "连接中",
  live: "实时",
  polling: "轮询中（API 未提供事件流）",
  ended: "已结束",
  error: "连接中断",
}

export function ConnectionIndicator({
  connection,
  message,
  onReconnect,
}: {
  connection: Connection
  message?: string | undefined
  onReconnect?: () => void
}) {
  return (
    <span className={`connection connection-${connection}`} title={message}>
      <span className="dot" aria-hidden="true" />
      {connectionLabel[connection]}
      {message === undefined ? null : `：${message}`}
      {connection === "error" && onReconnect !== undefined ? (
        <button type="button" onClick={onReconnect}>
          重新连接
        </button>
      ) : null}
    </span>
  )
}
