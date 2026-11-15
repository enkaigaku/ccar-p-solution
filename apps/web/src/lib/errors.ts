import { Predicate } from "effect"

const messages: Record<string, (error: object) => string> = {
  InvestigationNotFound: () => "找不到这次调查",
  AlertNotFound: () => "找不到这条告警",
  ProposalNotFound: () => "找不到这张审批单",
  ProposalNotPending: (e) =>
    Predicate.hasProperty(e, "status") ? `审批单已经处理过（当前状态：${String(e.status)}）` : "审批单已经处理过",
  Unauthorized: () => "尚未登录或登录已过期。如果没有自动跳转，请打开 /auth/login 重新登录",
  Forbidden: (e) =>
    Predicate.hasProperty(e, "required")
      ? `当前账号没有这项权限（需要 ${String(e.required)} 角色）`
      : "当前账号没有这项权限",
  HttpClientError: () => "无法连接 API，请确认 apps/api 已启动",
  SchemaError: () => "API 返回的数据不符合契约",
  EventStreamFailed: () => "实时事件流中断",
}

/** Turns any typed failure from the client into a short message for the UI. Never shows raw payloads. */
export const describeError = (error: unknown): string => {
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) {
    const describe = messages[error._tag]
    return describe === undefined ? `请求失败（${error._tag}）` : describe(error)
  }
  return "请求失败"
}
