import type { ActionProposal, Decision, Feedback, Investigation } from "@incident/contracts"
import { InvestigationId } from "@incident/contracts"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { ConnectionIndicator, StatusBadge } from "../components/Badges.tsx"
import { FeedbackForm } from "../components/FeedbackForm.tsx"
import { Hypotheses } from "../components/Hypotheses.tsx"
import { ProposalCard } from "../components/ProposalCard.tsx"
import { Timeline } from "../components/Timeline.tsx"
import { isLowConfidence, isTerminal } from "../investigation/live.ts"
import { useLiveInvestigation } from "../investigation/useLiveInvestigation.ts"
import { formatTime } from "../lib/format.ts"
import { IncidentClient } from "../lib/IncidentClient.ts"
import { run } from "../lib/load.ts"

export const Route = createFileRoute("/investigations/$id")({
  loader: ({ params }) =>
    run(
      Effect.gen(function* () {
        const client = yield* IncidentClient
        const id = InvestigationId.make(params.id)
        return yield* Effect.all({
          investigation: client.investigations.get({ params: { id } }),
          proposals: client.investigations.proposals({ params: { id } }),
        })
      }),
    ),
  component: InvestigationRoute,
})

function InvestigationRoute() {
  const loaded = Route.useLoaderData()
  if (loaded._tag === "Failed") {
    return (
      <main className="page">
        <p className="error" role="alert">
          {loaded.message}
        </p>
        <Link to="/">返回告警列表</Link>
      </main>
    )
  }
  const { investigation, proposals } = loaded.value
  // Keyed so navigating to another investigation starts a fresh live state and stream.
  return <InvestigationPage key={investigation.id} investigation={investigation} proposals={proposals} />
}

function InvestigationPage({
  investigation,
  proposals,
}: {
  investigation: Investigation
  proposals: ReadonlyArray<ActionProposal>
}) {
  const [state, dispatch] = useLiveInvestigation(investigation, proposals)
  const lowConfidence = isLowConfidence(state.status, state.hypotheses)
  const current = state.investigation

  const decide = (proposalId: ActionProposal["id"]) => (decision: Decision, comment: string | undefined) =>
    run(
      IncidentClient.use((client) =>
        client.proposals.decide({
          params: { id: proposalId },
          payload: comment === undefined ? { decision } : { decision, comment },
        }),
      ),
    )

  const refreshProposals = async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* IncidentClient
        return yield* Effect.all({
          investigation: client.investigations.get({ params: { id: current.id } }),
          proposals: client.investigations.proposals({ params: { id: current.id } }),
        })
      }),
    )
    if (result._tag === "Ok") dispatch({ _tag: "Snapshot", ...result.value })
  }

  const submitFeedback = (feedback: Feedback) =>
    run(
      IncidentClient.use((client) => client.investigations.feedback({ params: { id: current.id }, payload: feedback })),
    )

  return (
    <main className="page investigation">
      <div className="page-head">
        <div>
          <Link to="/" className="back">
            ← 告警
          </Link>
          <h1>
            调查 <code>{current.id}</code>
          </h1>
          <p className="meta">
            告警 <code>{current.alertId}</code> · 创建于 {formatTime(current.createdAt)} · 更新于{" "}
            {formatTime(current.updatedAt)}
          </p>
        </div>
        <div className="status-block">
          <StatusBadge status={state.status} />
          <ConnectionIndicator connection={state.connection} message={state.connectionMessage} />
        </div>
      </div>

      <dl className="versions" aria-label="生成本报告的配置">
        <dt>模型</dt>
        <dd>
          <code>{current.model}</code>
        </dd>
        <dt>Prompt 版本</dt>
        <dd>
          <code>{current.promptVersion}</code>
        </dd>
        <dt>索引版本</dt>
        <dd>
          <code>{current.indexVersion}</code>
        </dd>
        {current.traceId === undefined ? null : (
          <>
            <dt>Trace</dt>
            <dd>
              <code>{current.traceId}</code>
            </dd>
          </>
        )}
      </dl>

      {lowConfidence ? (
        <div className="banner banner-warning" role="note">
          <strong>{state.status === "insufficient_information" ? "信息不足" : "低置信度"}</strong>
          ：这份报告的结论不够可靠，请先人工核对证据，不要直接据此操作。
        </div>
      ) : null}

      <div className="columns">
        <section aria-labelledby="timeline-heading">
          <h2 id="timeline-heading">调查过程</h2>
          <Timeline items={state.timeline} />
        </section>

        <div className="side">
          <section aria-labelledby="hypotheses-heading">
            <h2 id="hypotheses-heading">
              根因假设 <span className="tag tag-ai">AI 生成</span>
            </h2>
            <Hypotheses hypotheses={state.hypotheses} />
          </section>

          <section aria-labelledby="proposals-heading">
            <h2 id="proposals-heading">处置建议与审批</h2>
            {state.proposals.length === 0 ? (
              <p className="empty">没有需要审批的操作。Agent 只能提议，任何写操作都要在这里经人工批准。</p>
            ) : (
              state.proposals.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  warning={lowConfidence ? "报告置信度低，批准前请逐条核对上方证据。" : undefined}
                  decide={decide(p.id)}
                  onDecided={(proposal) => dispatch({ _tag: "ProposalUpdated", proposal })}
                  onFailed={refreshProposals}
                />
              ))
            )}
          </section>

          <section aria-labelledby="feedback-heading">
            <h2 id="feedback-heading">反馈</h2>
            {isTerminal(state.status) || state.status === "awaiting_approval" ? (
              <FeedbackForm submit={submitFeedback} />
            ) : (
              <p className="empty">调查结束后可以在这里评价报告并填写实际根因。</p>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}
