# @incident/prompts

版本化的系统提示与 Skills。每个提示导出 `{ version, text }`，调用方把 `version` 写入 span 属性和 `Investigation.promptVersion`。

| 导出                  | 用途                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `TriagePrompt`        | 分诊（Haiku 5.5 / low，结构化输出）：类别、服务、严重度、检索查询、关联告警 |
| `InvestigationPrompt` | 根因调查 agent 的系统提示（Opus 5.5 / high）                                |
| `Methodologies`       | 按告警类别渐进加载的调查方法论（设计文档里的「调查 Skill」）                |
| `AlertCategories`     | 分诊类别，每个类别对应一个方法论                                            |

调查请求里记录的 prompt 版本是 `<InvestigationPrompt.version>+<方法论版本>`，例如 `investigate@1+method-error-rate@1`。

**规则**：提示正文必须是稳定前缀（不含时间戳、随机 ID 等），以免破坏 prompt caching，`test/prompts.test.ts` 会检查。修改提示必须升版本号并跑评估。
