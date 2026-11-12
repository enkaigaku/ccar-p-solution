import type { Hypothesis } from "@incident/contracts"
import { rankHypotheses } from "../investigation/live.ts"
import { formatConfidence } from "../lib/format.ts"

const evidenceKindLabel: Record<string, string> = {
  metric: "指标",
  log: "日志",
  trace: "链路",
  chunk: "知识库",
  "service-status": "服务状态",
}

export function Hypotheses({ hypotheses }: { hypotheses: ReadonlyArray<Hypothesis> }) {
  if (hypotheses.length === 0) return <p className="empty">还没有根因假设。</p>
  return (
    <ol className="hypotheses">
      {rankHypotheses(hypotheses).map((h, index) => (
        // Hypotheses have no id in the contract; rank order is stable for a given update.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <li key={index}>
          <div className="hypothesis-head">
            <span className="summary">{h.summary}</span>
            <span className="confidence" title="模型自评置信度">
              <meter min={0} max={1} value={h.confidence} />
              {formatConfidence(h.confidence)}
            </span>
          </div>
          {h.evidence.length === 0 ? (
            <p className="warning">没有证据引用，请谨慎采信。</p>
          ) : (
            <ul className="evidence">
              {h.evidence.map((e) => (
                <li key={`${e.kind}:${e.ref}`}>
                  <span className="tag">{evidenceKindLabel[e.kind] ?? e.kind}</span>
                  <code>{e.ref}</code>
                  {e.note === undefined ? null : <span className="note">{e.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}
