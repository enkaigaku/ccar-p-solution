# @incident/evals

评估体系：数据集、回放快照、评分、promptfoo 配置、预算守卫与故障录制脚本。设计见设计文档「评估体系」一节与 ADR 007。

## 三层评估

| 层     | 指标                               | 实现                                                         | 门槛                               |
| ------ | ---------------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| 检索   | recall@8、MRR                      | `src/scoring/retrieval.ts`（确定性，`evaluateRetrieval`）    | recall@8 ≥ 0.85，回退 ≤ 5 个百分点 |
| 端到端 | 根因 top-1 / top-3                 | `src/judge/Judge.ts`（Opus 5.5 / medium，结构化输出）        | top-3 ≥ 85%                        |
| 端到端 | 证据引用真实存在                   | `src/scoring/citations.ts`（ref 必须出现在快照的工具结果里） | 100%                               |
| 安全   | 越权提议、被注入带偏、该说信息不足 | `src/scoring/safety.ts`（确定性规则，canary 检测）           | 0 次                               |

judge 分数只有在校准通过后才作数：`datasets/calibration/` 放 30 条人工打分样本，`pnpm --filter @incident/evals evals calibrate --yes` 计算一致率（≥ 90% 才可信，约 1.5 美元）。

## 目录

```
datasets/fault/          故障集（录制产生，人工复核 groundTruth）
datasets/adversarial/    对抗集：引用某个故障快照，回放前注入载荷或删掉证据，无需额外录制
datasets/retrieval/      检索集（等 packages/rag 的语料入库后补齐约 100 条）
datasets/calibration/    judge 校准样本
fixtures/replay/<id>/    ReplaySnapshot（格式定义在 @incident/contracts）
src/promptfoo/           provider、断言、测试集生成、预算钩子
src/record/              flagd 注入、MCP 客户端、录制器、故障场景目录
```

用例 id 一律是不透明的（`fc-xxxxxxxx`、`ad-xxxxxxxx`），标准根因只在用例文件里，不进快照，避免答案泄漏给 agent。`synthetic: true` 的用例是手写的测试夹具，只在 `EVAL_INCLUDE_SYNTHETIC=true` 时参与评估。

## 运行评估

| 命令                                                                        | agent / judge                     | 费用                 |
| --------------------------------------------------------------------------- | --------------------------------- | -------------------- |
| `pnpm --filter @incident/evals eval:stub`                                   | 启发式 stub / 关键词 judge        | 0                    |
| `EVAL_AGENT=api EVAL_JUDGE=claude pnpm --filter @incident/evals eval:smoke` | api 中的真实 agent / Claude judge | 约 3.5 美元（10 条） |
| `EVAL_AGENT=api EVAL_JUDGE=claude pnpm --filter @incident/evals eval:full`  | 同上                              | 约 21 美元（60 条）  |

- 默认 `EVAL_AGENT=stub`、`EVAL_JUDGE=keyword`，直接跑 `promptfoo eval` 也不会花钱。
- api 模式下 provider 把每条用例的快照写到 `EVAL_REPLAY_DIR`（默认 `.replay/`）。api 需以 `OBS_REPLAY_DIR=<同一目录的绝对路径>` 启动：每次调查按告警 fingerprint（即用例 id）启动一个回放模式的 mcp-observability。步骤见 `apps/api/README.md`。
- 预算守卫在 promptfoo 的 `beforeAll` 钩子里执行，绕过 pnpm 脚本也生效：月度上限 500 美元，当月用量（本地账本 `.ledger/` 与 `EVAL_MONTH_SPEND_USD` 取大者）加本次估算超过 80% 时拒绝全量评估，冒烟每月最多 50 次、全量 8 次。`pnpm --filter @incident/evals evals budget` 查看当月用量。

## 录制故障快照（在 Mac mini 上执行）

录制不调用 Claude，没有 API 费用。录制器以 MCP 客户端身份启动实时模式的 mcp-observability，所以输出已经过脱敏，与回放时的 `ref` 一致。

1. 启动环境，等负载生成器跑满约 5 分钟：

   ```bash
   docker compose -f infra/compose.yaml up -d
   docker compose -f infra/observability/compose.yaml up -d
   infra/scripts/otel-demo.sh up
   ```

2. 按 `packages/mcp-observability/README.md` 配好实时后端地址（不要设置 `REPLAY_DIR`）。
3. 查看场景并录制。每条约 13–22 分钟（等触发 ≤ 10 分钟、故障保持 2 分钟、场景间冷却 10 分钟）。快照窗口从注入前 4 分钟开始，冷却时间必须长于「4 分钟 + 3 分钟 rate 窗口 + 约 1 分钟指标延迟」，否则快照里会混入上一个场景的故障：

   ```bash
   pnpm --filter @incident/evals evals scenarios          # ✓ 表示已有录制好的用例
   pnpm --filter @incident/evals record paymentFailure-50 cartFailure-50 adHighCpu
   ```

   录全部 50 个场景要 11–18 小时，适合挂一晚上。`--missing` 只录还没有用例的场景，中断后重跑同一条命令即可续录；`caffeinate -i` 防止 Mac 休眠：

   ```bash
   caffeinate -i pnpm --filter @incident/evals record --missing 2>&1 | tee -a packages/evals/.record.log
   ```

   录制器修改 `infra/.otel-demo/src/flagd/demo.flagd.json` 注入故障，无论成功与否最后都会把所有 flag 复位为 `off`。开始前先核对所有场景的 flag 和 variant 在该文件里都存在，缺一个就不启动。触发超时或某次工具调用失败的场景会被跳过并在最后列出，连续 3 个场景因工具调用失败则中止（后端挂了）。可用 `--flagd-file`、`--mcp "<命令>"`、`--cooldown-minutes` 覆盖默认值。
4. 复核新生成的 `datasets/fault/<id>.json`：根因描述是否准确，挑 1–2 条改成 `"smoke": true`，然后提交用例和 `fixtures/replay/<id>/`。
5. 触发条件是相对的：录制器在注入故障前先量一次触发查询的基线，注入后数值比基线高出场景的 `threshold` 才算触发，所以阈值不依赖本机的流量大小。某个场景超时不会中断后面的场景，报错里带有基线和观察到的最高值（`baseline …, highest seen …`），据此调整 `src/record/scenarios.ts` 里的阈值；显示 `no data` 说明查询的指标在本机不存在。
6. 每个服务录三次日志：`error`、`warn` 和不带级别。`level` 在实时查询里是精确匹配，很多服务把失败请求记在 `warn`，回放时按级别查询只会命中同级别的录制。
7. 指标名以本仓库 Prometheus 的写法为准（OTLP 接收端不加单位和 `_total` 后缀）：`traces_span_metrics_calls`、`traces_span_metrics_duration_bucket`。demo 的 span 指标约每分钟到一次，rate 窗口用 3 分钟。错误率类场景已按真实流量校准；延迟类和 Kafka 类场景的阈值还没有在真实环境里确认过。

### 场景目录

`src/record/scenarios.ts` 里有 50 个场景，按 OTel Demo 3.1.0 的 flag 清单校验（`test/otelDemoFlags.ts`，升级 demo 版本时一起更新）：

- 29 个单故障场景：每个 flag 的各档强度。
- 21 个带干扰项的场景（名字是 `故障+干扰项`）：同时打开第二个与告警无关的故障，例如 checkout 错误率告警的同时 ad 服务 CPU 飙高。标准根因仍是第一个故障，agent 把干扰项当成根因算错。干扰项必须不影响告警信号，配对规则见 `DistractorPairs` 的注释。用例的 `groundTruth.distractors` 记录干扰项，tag 带 `distractor`，便于分开统计两类用例的准确率。

目标是 ≥ 40 条故障用例，多出的场景留给触发不了的情况。

## 尚未打通的部分

- 检索集要等 `packages/rag` 的语料入库后才能标注；`evaluateRetrieval` 与门禁逻辑已就绪。
- 两套配置的 A/B 对比（prompt 版本、模型、effort）按 ADR 006 放在 M3。
- CI 里还没有真实冒烟评估（需要密钥和 Postgres）；现在 `pnpm test` 覆盖 stub 全链路，真实评估在本机跑。
