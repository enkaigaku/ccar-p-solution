// @vitest-environment jsdom
import type { PostmortemBody, PostmortemDecision, PostmortemDraft } from "@incident/contracts"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { PostmortemPanel, type PostmortemPanelProps } from "../src/components/PostmortemPanel.tsx"
import { describeError } from "../src/lib/errors.ts"
import type { Loaded } from "../src/lib/load.ts"
import { postmortem } from "./fixtures.ts"

afterEach(cleanup)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const setup = (
  props: Partial<PostmortemPanelProps> & { readonly fail?: string } = {},
  current: PostmortemDraft | "none" = postmortem(),
) => {
  const calls: Array<string> = []
  const saved: Array<PostmortemBody> = []
  const changed: Array<PostmortemDraft> = []
  const answer = (value: PostmortemDraft): Loaded<PostmortemDraft> =>
    props.fail === undefined ? { _tag: "Ok", value } : { _tag: "Failed", message: props.fail, notFound: false }
  render(
    <PostmortemPanel
      postmortem={current === "none" ? undefined : current}
      finished
      canDraft
      canReview
      generate={async () => {
        calls.push("generate")
        return answer(postmortem({ id: postmortem().id }))
      }}
      save={async (id, body) => {
        calls.push(`save ${id}`)
        saved.push(body)
        return answer(postmortem({ body, edited: true }))
      }}
      review={async (id, decision: PostmortemDecision) => {
        calls.push(`review ${id} ${decision}`)
        return answer(postmortem({ status: decision === "publish" ? "published" : "rejected", reviewedBy: "alice" }))
      }}
      onChanged={(p) => changed.push(p)}
      {...props}
    />,
  )
  return { calls, saved, changed }
}

describe("PostmortemPanel", () => {
  it("offers to generate a draft only for a finished investigation and a responder", async () => {
    const { calls, changed } = setup({}, "none")
    fireEvent.click(screen.getByRole("button", { name: "生成复盘草稿" }))
    await flush()
    expect(calls).toEqual(["generate"])
    expect(changed).toHaveLength(1)
    cleanup()

    setup({ finished: false }, "none")
    expect(screen.queryByRole("button", { name: "生成复盘草稿" })).toBeNull()
    cleanup()

    setup({ canDraft: false }, "none")
    expect(screen.queryByRole("button", { name: "生成复盘草稿" })).toBeNull()
    expect(screen.getByText(/需要 responder 角色/)).toBeTruthy()
  })

  it("marks the draft as AI-generated and publishes only after a second click", async () => {
    const { calls, changed } = setup()
    expect(screen.getByText("AI 生成")).toBeTruthy()
    expect(screen.getByText("草稿")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "发布到知识库" }))
    expect(calls).toEqual([])
    const dialog = screen.getByRole("alertdialog", { name: "确认发布" })
    expect(dialog.textContent).toContain("之后的调查会把它当作参考资料")
    fireEvent.click(screen.getByRole("button", { name: "确认发布到知识库" }))
    await flush()
    expect(calls).toEqual(["review pm-1 publish"])
    expect(changed[0]?.status).toBe("published")
  })

  it("saves a responder's correction trimmed, and holds the review until it is saved", async () => {
    const { calls, saved } = setup()
    const save = screen.getByRole("button", { name: "保存修改" })
    expect(save.hasAttribute("disabled")).toBe(true)

    fireEvent.change(screen.getByLabelText("处置"), { target: { value: "  Rolled payment back.  " } })
    // An unsaved edit must not be published by accident: the reviewer would approve text they are not seeing saved.
    expect(screen.queryByRole("button", { name: "发布到知识库" })).toBeNull()
    expect(screen.getByText("有未保存的修改。先保存，再审核。")).toBeTruthy()
    fireEvent.click(save)
    await flush()
    expect(calls).toEqual(["save pm-1"])
    expect(saved[0]?.mitigation).toBe("Rolled payment back.")
    expect(saved[0]?.title).toBe(postmortem().body.title)

    fireEvent.change(screen.getByLabelText("根因"), { target: { value: "   " } })
    expect(screen.getByRole("button", { name: "保存修改" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("五个部分都不能为空。")).toBeTruthy()
  })

  it("rejects in one click and shows API errors without changing anything", async () => {
    const { calls, changed } = setup({ fail: "写入知识库失败，草稿没有变化，可以稍后重试" })
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }))
    await flush()
    expect(calls).toEqual(["review pm-1 reject"])
    expect(changed).toEqual([])
    expect(screen.getByRole("alert").textContent).toBe("写入知识库失败，草稿没有变化，可以稍后重试")
  })

  it("shows a draft read-only to a viewer and lets a responder edit but not review", () => {
    setup({ canDraft: false, canReview: false })
    expect(screen.queryByRole("form", { name: "复盘草稿" })).toBeNull()
    expect(screen.getByText("The paymentFailure flag was on.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "发布到知识库" })).toBeNull()
    cleanup()

    setup({ canReview: false })
    expect(screen.getByRole("form", { name: "复盘草稿" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "发布到知识库" })).toBeNull()
    expect(screen.getByText(/只有 approver 角色可以/)).toBeTruthy()
  })

  it("freezes a reviewed postmortem and shows who reviewed it and where it went", () => {
    setup(
      {},
      postmortem({
        status: "published",
        edited: true,
        reviewedBy: "alice",
        sourceId: "postmortems/generated/2026-11-12-checkout-pm1.md",
        indexVersion: "idx-2",
      }),
    )
    expect(screen.getByText("已发布到知识库")).toBeTruthy()
    expect(screen.getByText("AI 起草，已人工修改")).toBeTruthy()
    expect(screen.getByText(/审核人 alice/)).toBeTruthy()
    expect(screen.getByText("postmortems/generated/2026-11-12-checkout-pm1.md")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })
})

describe("postmortem error messages", () => {
  it("explains each failure without echoing the api's text", () => {
    expect(describeError({ _tag: "PostmortemUnavailable", reason: "ingest", message: "internal detail" })).toBe(
      "写入知识库失败，草稿没有变化，可以稍后重试",
    )
    expect(describeError({ _tag: "PostmortemUnavailable", reason: "refusal", message: "x" })).toContain("拒绝")
    expect(describeError({ _tag: "PostmortemNotDraft", id: "pm-1", status: "published" })).toContain("published")
    expect(describeError({ _tag: "InvestigationNotFinished" })).toBe("调查还没有结束，不能生成复盘")
  })
})
