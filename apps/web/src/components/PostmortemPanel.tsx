import { PostmortemBody, type PostmortemDecision, type PostmortemDraft } from "@incident/contracts"
import { useState } from "react"
import { formatTime } from "../lib/format.ts"
import type { Loaded } from "../lib/load.ts"

export interface PostmortemPanelProps {
  readonly postmortem: PostmortemDraft | undefined
  /** The investigation has a report to write up (`completed` or `insufficient_information`). */
  readonly finished: boolean
  /** Responder: may generate and edit a draft. */
  readonly canDraft: boolean
  /** Approver: may publish a draft to the knowledge base or reject it. */
  readonly canReview: boolean
  readonly generate: () => Promise<Loaded<PostmortemDraft>>
  readonly save: (id: PostmortemDraft["id"], body: PostmortemBody) => Promise<Loaded<PostmortemDraft>>
  readonly review: (id: PostmortemDraft["id"], decision: PostmortemDecision) => Promise<Loaded<PostmortemDraft>>
  readonly onChanged: (postmortem: PostmortemDraft) => void
}

const FIELDS = [
  { key: "title", label: "标题", rows: 1 },
  { key: "summary", label: "概述", rows: 3 },
  { key: "symptoms", label: "现象", rows: 4 },
  { key: "rootCause", label: "根因", rows: 4 },
  { key: "mitigation", label: "处置", rows: 3 },
] as const
type FieldKey = (typeof FIELDS)[number]["key"]
type Fields = Record<FieldKey, string>

const statusLabel: Record<PostmortemDraft["status"], string> = {
  draft: "草稿",
  published: "已发布到知识库",
  rejected: "已拒绝",
}

const fieldsOf = (body: PostmortemBody): Fields => ({
  title: body.title,
  summary: body.summary,
  symptoms: body.symptoms,
  rootCause: body.rootCause,
  mitigation: body.mitigation,
})

/**
 * The postmortem of a finished investigation. The model writes the draft; a responder can correct it; publishing
 * takes an approver and two clicks, because a published postmortem is what the agent reads as reference material
 * in later investigations.
 */
export function PostmortemPanel(props: PostmortemPanelProps) {
  const { postmortem, finished, canDraft, canReview, onChanged } = props
  const [fields, setFields] = useState<Fields | undefined>(
    postmortem === undefined ? undefined : fieldsOf(postmortem.body),
  )
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const perform = async (action: () => Promise<Loaded<PostmortemDraft>>) => {
    setBusy(true)
    setError(undefined)
    const result = await action()
    setBusy(false)
    setConfirming(false)
    if (result._tag === "Ok") {
      setFields(fieldsOf(result.value.body))
      onChanged(result.value)
    } else {
      setError(result.message)
    }
    return result._tag === "Ok"
  }

  const failure =
    error === undefined ? null : (
      <p className="error" role="alert">
        {error}
      </p>
    )

  if (postmortem === undefined || fields === undefined) {
    return (
      <div className="card postmortem">
        {!finished ? (
          <p className="empty">调查结束后可以在这里生成复盘草稿。</p>
        ) : !canDraft ? (
          <p className="empty">还没有复盘草稿。生成草稿需要 responder 角色。</p>
        ) : (
          <>
            <p className="empty">
              还没有复盘草稿。生成会调用一次模型，根据报告、处置结果和上面的反馈起草；先提交实际根因，草稿会更准确。
            </p>
            <button type="button" className="primary" disabled={busy} onClick={() => perform(props.generate)}>
              {busy ? "正在生成…" : "生成复盘草稿"}
            </button>
          </>
        )}
        {failure}
      </div>
    )
  }

  const isDraft = postmortem.status === "draft"
  const editable = isDraft && canDraft
  const trimmed: Fields = {
    title: fields.title.trim(),
    summary: fields.summary.trim(),
    symptoms: fields.symptoms.trim(),
    rootCause: fields.rootCause.trim(),
    mitigation: fields.mitigation.trim(),
  }
  const complete = FIELDS.every((f) => trimmed[f.key] !== "")
  const dirty = FIELDS.some((f) => trimmed[f.key] !== postmortem.body[f.key])

  return (
    <article className={`card postmortem postmortem-${postmortem.status}`} aria-label="复盘">
      <header>
        <span className={`badge postmortem-status-${postmortem.status}`}>{statusLabel[postmortem.status]}</span>
        <span className="tag tag-ai">{postmortem.edited ? "AI 起草，已人工修改" : "AI 生成"}</span>
      </header>

      {editable ? (
        <form
          className="postmortem-fields"
          aria-label="复盘草稿"
          onSubmit={(event) => {
            event.preventDefault()
            if (complete && dirty) void perform(() => props.save(postmortem.id, new PostmortemBody(trimmed)))
          }}
        >
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <textarea
                value={fields[f.key]}
                rows={f.rows}
                disabled={busy}
                onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
              />
            </label>
          ))}
          <div className="actions">
            <button type="submit" disabled={busy || !complete || !dirty}>
              保存修改
            </button>
            <button type="button" disabled={busy} onClick={() => perform(props.generate)}>
              重新生成
            </button>
          </div>
          {complete ? null : <p className="warning">五个部分都不能为空。</p>}
        </form>
      ) : (
        <dl className="postmortem-fields">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>{postmortem.body[f.key]}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="meta">
        <code>{postmortem.model}</code> · <code>{postmortem.promptVersion}</code> · 更新于{" "}
        {formatTime(postmortem.updatedAt)}
        {postmortem.reviewedBy === undefined ? null : <> · 审核人 {postmortem.reviewedBy}</>}
        {postmortem.sourceId === undefined ? null : (
          <>
            {" "}
            · <code>{postmortem.sourceId}</code>
          </>
        )}
        {postmortem.indexVersion === undefined ? null : (
          <>
            {" "}
            · 索引 <code>{postmortem.indexVersion}</code>
          </>
        )}
      </p>

      {!isDraft ? null : !canReview ? (
        <p className="empty">等待审核。只有 approver 角色可以把复盘发布到知识库或拒绝。</p>
      ) : dirty ? (
        <p className="empty">有未保存的修改。先保存，再审核。</p>
      ) : confirming ? (
        <div className="confirm" role="alertdialog" aria-label="确认发布">
          <p>发布后，这篇复盘会进入知识库，之后的调查会把它当作参考资料检索到，并且不能再修改。确认内容属实并发布？</p>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => perform(() => props.review(postmortem.id, "publish"))}
          >
            确认发布到知识库
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
            取消
          </button>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={() => setConfirming(true)}>
            发布到知识库
          </button>
          <button type="button" disabled={busy} onClick={() => perform(() => props.review(postmortem.id, "reject"))}>
            拒绝
          </button>
        </div>
      )}
      {failure}
    </article>
  )
}
