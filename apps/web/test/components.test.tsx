// @vitest-environment jsdom
import type { ActionProposal, Decision, Feedback } from "@incident/contracts"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { FeedbackForm } from "../src/components/FeedbackForm.tsx"
import { ProposalCard } from "../src/components/ProposalCard.tsx"
import type { Loaded } from "../src/lib/load.ts"
import { proposal } from "./fixtures.ts"

afterEach(cleanup)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("ProposalCard", () => {
  const setup = (result: (decision: Decision) => Loaded<ActionProposal>) => {
    const calls: Array<{ decision: Decision; comment: string | undefined }> = []
    const decided: Array<ActionProposal> = []
    render(
      <ProposalCard
        proposal={proposal()}
        decide={async (decision, comment) => {
          calls.push({ decision, comment })
          return result(decision)
        }}
        onDecided={(p) => decided.push(p)}
      />,
    )
    return { calls, decided }
  }

  it("shows what will change and requires a second click to approve", async () => {
    const { calls, decided } = setup(() => ({ _tag: "Ok", value: proposal({ status: "approved" }) }))
    expect(screen.getByRole("heading").textContent).toContain("paymentFailure")
    expect(screen.getByText("Set the flag back to its previous variant")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "批准" }))
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "确认批准并执行" }))
    await flush()

    expect(calls).toEqual([{ decision: "approved", comment: undefined }])
    expect(decided[0]?.status).toBe("approved")
  })

  it("rejects in one click, sends the trimmed comment, and shows API errors", async () => {
    const { calls, decided } = setup(() => ({ _tag: "Failed", message: "审批单已经处理过", notFound: false }))
    fireEvent.change(screen.getByLabelText("审批意见（可选）"), { target: { value: "  not the flag  " } })
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }))
    await flush()

    expect(calls).toEqual([{ decision: "rejected", comment: "not the flag" }])
    expect(decided).toHaveLength(0)
    expect(screen.getByRole("alert").textContent).toBe("审批单已经处理过")
  })

  it("offers no decision buttons once the proposal is decided", () => {
    render(
      <ProposalCard
        proposal={proposal({ status: "executed" })}
        decide={async () => ({ _tag: "Failed", message: "", notFound: false })}
        onDecided={() => {}}
      />,
    )
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("已执行")).toBeTruthy()
  })
})

describe("FeedbackForm", () => {
  it("requires a rating and omits empty optional fields", async () => {
    const sent: Array<Feedback> = []
    render(
      <FeedbackForm
        submit={async (f) => {
          sent.push(f)
          return { _tag: "Ok", value: undefined }
        }}
      />,
    )
    const submit = screen.getByRole("button", { name: "提交反馈" })
    expect(submit.hasAttribute("disabled")).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "👎 没帮助" }))
    fireEvent.change(screen.getByLabelText("实际根因（可选，会进入评估集）"), {
      target: { value: " paymentFailure flag " },
    })
    fireEvent.click(submit)
    await flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.rating).toBe("down")
    expect(sent[0]?.actualRootCause).toBe("paymentFailure flag")
    expect(sent[0] !== undefined && "comment" in sent[0]).toBe(false)
    expect(screen.getByRole("status").textContent).toBe("已提交，感谢反馈。")
  })
})
