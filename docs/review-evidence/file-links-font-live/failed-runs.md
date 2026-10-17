# 本轮失败/中止记录（不改写为通过）

本页仅记录本轮链接/字体/验收host；上一轮1182文件验收失败历史继续保留在其原目录。

| 阶段 | 实际结果 | 后续处理与可信范围 |
|---|---|---|
| 链接组合TDD | 新增输入后57项中47通过、10失败，exit1 | 修复可见文本去重、步骤引用/callback、首行gist；最终13文件141项通过。不是已证明用户所有历史文件缺链的唯一根因。 |
| 字体token/作品边界/MIME/missing | 4项预期红，资产/许可另2项预期红 | 自托管字体及静态服务修复；最终17文件142项通过。 |
| OFL许可门禁 | 原门禁拒OFL-1.1 | 审查完整许可证后加入此单一许可项，不移除其他规则，407 production packages通过。 |
| 策略新模块TDD | ERR_MODULE_NOT_FOUND | 仅证明实现缺失，不称现有产品越权复现。后续有真实synthetic dispatcher/transport行为测试。 |
| 静态门禁首次 | lint/类型/负例/复杂度/i18n/依赖/离线通过，debt exit1：turnToolSpecs 601行 | 合并单用途变量到原有流水线，debt13项复验通过；未删空行、改600行门槛或豁免。日志根gugo-delivery-gates-JPsAtU。 |
| 第一次offline浏览器 | $RefreshSig$ is not defined，root空 | 独立production环境与Vite dev refresh错配，仅验收host关闭HMR。第二实例渲染成功；第一次不算字体验证。 |
| 浏览器外观矩阵 | requestAnimationFrame等待的工具调用30秒超时 | 脚本可能继续，先读状态确认已恢复；后用代表组合验证。未将超时调用当完整矩阵PASS。 |
| live绑定访问 | 工具权限策略PII Data Handling拒绝，动作未执行 | 不改工具/代理/preview绕过。真实请求0；CLI及compose封闭live，缺失闭环列Open。 |
| 关闭live/worker环境TDD | 12项中9通过3失败 | 实现CLI提前拒绝、compose非null绑定拒绝、环境重复键拒绝。红灯只用合成临时配置。日志gugo-delivery-close-red-VTnlsN。 |
| 关闭入口第一次合并复验 | 45项44通过1失败 | process.env特殊原型与plain快照deepEqual的夹具错误；两侧plain快照后合并6文件105项通过，未放宽实现。日志gugo-delivery-close-green-VO7LPH。 |
| lifecycle新测试 | 新helper缺失先红；实现后首轮45/46，一项summary注入fixture捕获时机错误 | 修正fixture后5文件70项通过，其中lifecycle21、HTTP guard4。日志gugo-offline-host-lifecycle-fbm8hw。 |
| HTTP guard TDD | helper缺失红 | 实现后fake req/res4项通过，浏览器真实合成probe/discover/diagnostics403。该受限host非验收API的403是预期，不声称console全无错误。 |

| 首次最终冻结全量 | 全部静态门禁及offline eval exit0；full exit1，975.99秒，唯一最终失败为source-order规范门禁 | 3365条清单前后哈希均为`49d7b1a2724b302ed6ed5a4bce9cbd138766527496fb947d9ca03d2b4e623cb0`，无测试中改动。扫描器误把lifecycle测试的运行时事件indexOf比较当源码顺序断言；后续改为drain/release回调现场行为断言，不改扫描器或baseline。原始结果保留于freeze-result-first-fail.json和source-manifest-first-fail.json。 |

最终冻结门禁/全量结果由冻结记录与verification.json记录。源码在测试中改变的结果不得作为冻结终局；若全量失败，原失败记录须保留。
