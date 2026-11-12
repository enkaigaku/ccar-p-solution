@AGENTS.md

## Claude Code 补充说明

- 本仓库的通用规则、命令、安全约束和代码审查标准都在 `AGENTS.md`，以它为准；本节只放 Claude Code 特有的内容。
- 写 Effect 代码前先查 `node_modules/effect/AGENTS.md` 和 `node_modules/effect/ai-docs/src/` 中对应主题的示例。
- 调用 Claude API 的代码改动，先查阅 `claude-api` skill，确认模型 ID、参数和 SDK 用法是当前版本。
- 提交前运行 `pnpm check`。PR 由 Codex 审查：开 PR 的会话负责跟进 review 意见，逐条判断，成立的修改并推送，不成立的在 PR 上回复理由。
