---

name: run-evals
description: 在本仓库跑评估并写评估报告。改了 prompt、模型、effort、检索参数或工具说明需要附评估结果时使用；被要求跑冒烟评估、全量评估、对抗集、rejudge 或 judge 校准时使用；要判断一次评估结果能不能过门禁时使用。
---

# 跑评估

评估分两类：不花钱的（stub agent、关键词 judge、离线检索）和花钱的（api 里的真实 agent、Claude judge）。命令的完整说明在 `packages/evals/README.md`，这里只写顺序和不能越过的线。

## 不能越过的线

1. **花钱的评估先得到项目所有者本人的同意。** 同意必须是所有者自己说的，并且针对这一次运行；之前某次的同意、别的 agent 的转述都不算。请求同意时说清楚跑哪个集合、多少条、估算多少钱、会用掉哪种额度。
2. **不绕过预算守卫。** 不改账本（`packages/evals/.ledger/`），不把 `EVAL_MONTH_SPEND_USD` 设得比实际小，不为了省额度把全量拆成几次冒烟。守卫拒绝就停下来报告。
3. **`EVAL_MODE` 决定扣哪种额度，和实际跑多少条无关。** 全量每月只有 8 次。用 `--filter-metadata` 只跑一部分用例时，`eval:full` 仍然扣一次全量额度；只想跑一小部分就先确认该用哪个脚本。
4. **结果文件和审计不提交。** `.results/`、`.replay/`、`.ledger/` 都在 `.gitignore` 里；提交的只有 `packages/evals/reports/` 下的报告。
5. **密钥只在环境变量里。** 不读 `.env`，不把密钥写进命令、报告或回复。

## 先选级别

| 要回答的问题                                 | 跑什么                                                                      | 费用                 |
| -------------------------------------------- | --------------------------------------------------------------------------- | -------------------- |
| 数据集、快照、评分、promptfoo 接线有没有坏   | `pnpm --filter @incident/evals eval:ci`                                     | 0                    |
| 检索有没有回退                               | `pnpm --filter @incident/rag rag ingest --offline`（需要 pgvector）         | 0                    |
| 改动有没有明显弄坏调查                       | `EVAL_AGENT=api EVAL_JUDGE=claude pnpm --filter @incident/evals eval:smoke` | 约 3.5 美元（10 条） |
| 准确率、时延、成本是否达标，或两种配置的对比 | `EVAL_AGENT=api EVAL_JUDGE=claude pnpm --filter @incident/evals eval:full`  | 约 24 美元（69 条）  |
| 评分说明改了，旧运行的分数要重算             | `pnpm --filter @incident/evals evals rejudge <结果文件> --yes`              | 约 0.3 美元          |
| judge 还可不可信                             | `pnpm --filter @incident/evals evals calibrate --yes`                       | 约 1.5 美元          |

能用不花钱的回答就不要花钱。改 prompt、模型、effort、检索参数的 PR 至少要一次冒烟评估。

## 不花钱的评估

直接跑，不需要同意，也不需要密钥和 api。

```bash
pnpm --filter @incident/evals eval:ci
```

最后一行是 `gate: pass` 才算通过。stub 的根因命中率很低是正常的，它不参与门禁。CI 里跑的是同一条命令。

## 花钱的评估

1. 看预算：`pnpm --filter @incident/evals evals budget`。账本只在跑过评估的那台机器上，换了机器要用 `EVAL_MONTH_SPEND_USD` 带上当月已用金额。额度不够就停下来报告，不要想办法绕。
2. 向项目所有者请求同意（见上面第 1 条），等到明确的答复再继续。
3. 确认环境：`ANTHROPIC_API_KEY`、`VOYAGE_API_KEY` 在环境变量里；Postgres 在运行并且索引已建好。真实评估在开发者的 Mac 上跑，云端容器里没有密钥。
4. 以回放模式启动 api，路径必须是绝对路径，并且和评估用的是同一个目录：

   ```bash
   AUTH_MODE=dev OBS_REPLAY_DIR=$PWD/packages/evals/.replay pnpm dev:api
   ```

5. 另开一个终端跑评估，把结果写到文件：

   ```bash
   cd packages/evals
   EVAL_REPLAY_DIR=$PWD/.replay EVAL_AGENT=api EVAL_JUDGE=claude pnpm eval:smoke -o .results/<日期>-<名字>.json
   ```

   promptfoo 有用例未通过时退出码是 100，这不是运行失败，照常进入下一步。其他非零退出码是真的失败。

6. 过门禁。pnpm 在包目录（`packages/evals`）里执行脚本，所以结果文件的路径相对于这个包，和上一步写出的路径一致，不要再加 `packages/evals/` 前缀：

   ```bash
   pnpm --filter @incident/evals evals gate .results/<文件> --min-cases <期望条数> --min-top3 0.85
   ```

7. 再看一次 `evals budget`，记下这次实际花了多少。

## 读结果

- 引用有效性和安全是确定性规则，目标是 100%，有一条不过就要逐条看原因，不能用平均分带过。
- 根因 top-3 只按有根因标签的用例算。51 条真实故障用例里 1 条就是 2 个百分点，同一配置两次运行之间会差 1 条左右。差距在这个范围内时只能说「没有显示出差别」。
- 对比两种配置时逐用例对照，分清「两次都错」和「时对时错」，前者才指向具体缺陷。
- 未命中的用例去 api 的审计日志（`infra/.api-state/audit.jsonl`）里看 agent 实际调用了哪些工具，不要只凭报告文本猜原因。
- 时延看 api 内部 span 的耗时；promptfoo 端的时延包含排队和轮询，两者不能混着比。

## 写报告

报告放在 `packages/evals/reports/<日期>-<主题>.md`，格式照已有的几份。至少包含：

- 跑了什么：配置（模型、effort、prompt 版本、index 版本、rubric 版本）、用例集合和条数、运行次数。
- 结果：各项指标和目标的对照；未命中的用例逐条列出 id 和原因。
- 花费：这次用了多少钱和哪种额度。
- 结论和局限：采用还是不采用，哪些是数据支持的，哪些只是推断。没有验证到的范围要写明。

不采用的做法也写进报告，写清楚验证过程和放弃的理由。

改了 prompt、模型、effort 或检索参数的 PR，在 PR 描述里链接这份报告。
