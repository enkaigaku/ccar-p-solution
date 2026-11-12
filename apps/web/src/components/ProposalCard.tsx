import type { ActionProposal, Decision } from "@incident/contracts"
import { useState } from "react"
import { describeAction, formatTime, proposalStatusLabel } from "../lib/format.ts"
import type { Loaded } from "../lib/load.ts"

export interface ProposalCardProps {
  readonly proposal: ActionProposal
  /** Shown above the buttons, e.g. when the report behind this proposal is low confidence. */
  readonly warning?: string | undefined
  readonly decide: (decision: Decision, comment: string | undefined) => Promise<Loaded<ActionProposal>>
  readonly onDecided: (proposal: ActionProposal) => void
  readonly onFailed?: () => void
}

/**
 * One approval request. Approving takes two clicks: the second one restates exactly what will run,
 * because this is the only place in the product where a human lets the system change production.
 */
export function ProposalCard({ proposal, warning, decide, onDecided, onFailed }: ProposalCardProps) {
  const [comment, setComment] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const pending = proposal.status === "pending"

  const submit = async (decision: Decision) => {
    setBusy(true)
    setError(undefined)
    const trimmed = comment.trim()
    const result = await decide(decision, trimmed === "" ? undefined : trimmed)
    setBusy(false)
    setConfirming(false)
    if (result._tag === "Ok") {
      onDecided(result.value)
    } else {
      setError(result.message)
      onFailed?.()
    }
  }

  return (
    <article className={`card proposal proposal-${proposal.status}`} aria-label="审批单">
      <header>
        <h3>{describeAction(proposal.action)}</h3>
        <span className={`badge proposal-status-${proposal.status}`}>{proposalStatusLabel[proposal.status]}</span>
      </header>
      <dl>
        <dt>理由</dt>
        <dd>{proposal.rationale}</dd>
        <dt>预期效果</dt>
        <dd>{proposal.expectedEffect}</dd>
        <dt>回滚方法</dt>
        <dd>{proposal.rollbackPlan}</dd>
        <dt>提议时间</dt>
        <dd>{formatTime(proposal.createdAt)}</dd>
      </dl>
      {pending ? (
        <div className="decision">
          <label>
            审批意见（可选）
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} disabled={busy} />
          </label>
          {warning === undefined ? null : <p className="warning">{warning}</p>}
          {confirming ? (
            <div className="confirm" role="alertdialog" aria-label="确认批准">
              <p>
                批准后系统会执行：<strong>{describeAction(proposal.action)}</strong>。确认执行？
              </p>
              <button type="button" className="danger" disabled={busy} onClick={() => submit("approved")}>
                确认批准并执行
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                取消
              </button>
            </div>
          ) : (
            <div className="actions">
              <button type="button" className="primary" disabled={busy} onClick={() => setConfirming(true)}>
                批准
              </button>
              <button type="button" disabled={busy} onClick={() => submit("rejected")}>
                拒绝
              </button>
            </div>
          )}
        </div>
      ) : null}
      {error === undefined ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}
