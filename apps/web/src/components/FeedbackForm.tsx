import { Feedback } from "@incident/contracts"
import { useState } from "react"
import type { Loaded } from "../lib/load.ts"

export interface FeedbackFormProps {
  readonly submit: (feedback: Feedback) => Promise<Loaded<void>>
}

/** Thumbs up/down plus the actual root cause; both flow back into the evaluation set. */
export function FeedbackForm({ submit }: FeedbackFormProps) {
  const [rating, setRating] = useState<Feedback["rating"] | undefined>(undefined)
  const [actualRootCause, setActualRootCause] = useState("")
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | undefined>(undefined)

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (rating === undefined) return
    setBusy(true)
    const cause = actualRootCause.trim()
    const note = comment.trim()
    const outcome = await submit(
      new Feedback({
        rating,
        ...(cause === "" ? {} : { actualRootCause: cause }),
        ...(note === "" ? {} : { comment: note }),
      }),
    )
    setBusy(false)
    if (outcome._tag === "Ok") {
      setResult({ ok: true, message: "已提交，感谢反馈。" })
      setRating(undefined)
      setActualRootCause("")
      setComment("")
    } else {
      setResult({ ok: false, message: outcome.message })
    }
  }

  return (
    <form className="card feedback" onSubmit={onSubmit} aria-label="调查反馈">
      <fieldset className="rating" disabled={busy}>
        <legend>这份调查报告有帮助吗？</legend>
        <button type="button" aria-pressed={rating === "up"} onClick={() => setRating("up")}>
          👍 有帮助
        </button>
        <button type="button" aria-pressed={rating === "down"} onClick={() => setRating("down")}>
          👎 没帮助
        </button>
      </fieldset>
      <label>
        实际根因（可选，会进入评估集）
        <input
          value={actualRootCause}
          onChange={(e) => setActualRootCause(e.target.value)}
          placeholder="例如：paymentFailure flag 被打开"
          disabled={busy}
        />
      </label>
      <label>
        备注（可选）
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} disabled={busy} />
      </label>
      <button type="submit" className="primary" disabled={busy || rating === undefined}>
        提交反馈
      </button>
      {result === undefined ? null : (
        <p className={result.ok ? "success" : "error"} role="status">
          {result.message}
        </p>
      )}
    </form>
  )
}
