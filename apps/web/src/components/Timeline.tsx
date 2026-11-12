import type { TimelineEntry, TimelineItem } from "../investigation/live.ts"
import {
  describeAction,
  formatConfidence,
  formatDuration,
  formatOffset,
  statusLabel,
  stepLabel,
} from "../lib/format.ts"

function EntryText({ entry }: { entry: TimelineEntry }) {
  switch (entry._tag) {
    case "Step":
      return (
        <>
          开始 <strong>{stepLabel[entry.step] ?? entry.step}</strong>
          {entry.turn === undefined ? null : `（第 ${entry.turn} 轮）`}
        </>
      )
    case "Tool":
      return (
        <>
          调用工具 <code>{entry.tool}</code>，耗时 {formatDuration(entry.durationMs)}
          {entry.isError ? <span className="tag tag-error">出错</span> : null}
        </>
      )
    case "Hypotheses":
      return (
        <>
          更新根因假设：{entry.count} 条
          {entry.topConfidence === undefined ? null : `，最高置信度 ${formatConfidence(entry.topConfidence)}`}
        </>
      )
    case "Proposal":
      return <>提议操作：{describeAction(entry.proposal.action)}（需人工审批）</>
    case "Status":
      return (
        <>
          状态变为 <strong>{statusLabel[entry.status]}</strong>
        </>
      )
  }
}

export function Timeline({ items }: { items: ReadonlyArray<TimelineItem> }) {
  const first = items[0]
  if (first === undefined) {
    return <p className="empty">还没有收到调查事件。Agent 开始工作后，每一步会实时出现在这里。</p>
  }
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li key={item.seq} className={`timeline-${item.entry._tag.toLowerCase()}`}>
          <span className="offset">{formatOffset(first.receivedAt, item.receivedAt)}</span>
          <span>
            <EntryText entry={item.entry} />
          </span>
        </li>
      ))}
    </ol>
  )
}
