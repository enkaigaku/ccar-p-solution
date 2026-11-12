import type { InvestigationStatus, OpsAction, Severity } from "@incident/contracts"
import { DateTime, Duration } from "effect"

/** Local wall-clock time for tables and headers, e.g. "11/12 14:03:05". */
export const formatTime = (dt: DateTime.DateTime): string =>
  DateTime.format(dt, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })

/** Offset from the first timeline entry, e.g. "+01:07". */
export const formatOffset = (from: DateTime.Utc, to: DateTime.Utc): string => {
  const seconds = Math.max(0, Math.floor(Duration.toSeconds(DateTime.distance(from, to))))
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0")
  const ss = String(seconds % 60).padStart(2, "0")
  return `+${mm}:${ss}`
}

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`

export const formatConfidence = (confidence: number): string => `${Math.round(confidence * 100)}%`

export const statusLabel: Record<InvestigationStatus, string> = {
  queued: "排队中",
  running: "调查中",
  awaiting_approval: "等待审批",
  completed: "已完成",
  insufficient_information: "信息不足",
  failed: "失败",
}

export const severityLabel: Record<Severity, string> = {
  critical: "严重",
  warning: "警告",
  info: "提示",
}

export const stepLabel: Record<string, string> = {
  triage: "分诊",
  retrieve: "检索 runbook 与复盘",
  agent_turn: "Agent 推理",
  report: "生成报告",
}

export const proposalStatusLabel: Record<string, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  expired: "已过期",
  executed: "已执行",
  failed: "执行失败",
}

/** One-line, human-readable description of what approving this action would change. */
export const describeAction = (action: OpsAction): string => {
  switch (action._tag) {
    case "ToggleFlag":
      return `将 feature flag「${action.flag}」切换为「${action.variant}」`
    case "RestartService":
      return `重启服务「${action.service}」`
    case "RollbackService":
      return `将服务「${action.service}」回滚到镜像「${action.imageTag}」`
  }
}
