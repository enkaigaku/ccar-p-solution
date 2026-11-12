# @incident/prompts

版本化的系统提示与 Skills。每个提示导出 `{ version, text }`，调用方把 `version` 写入 span 属性和 `Investigation.promptVersion`。

**规则**：提示正文必须是稳定前缀（不含时间戳、随机 ID 等），以免破坏 prompt caching。修改提示必须升版本号并跑评估。
