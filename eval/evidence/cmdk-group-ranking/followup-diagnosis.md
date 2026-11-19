# FOLLOWUP 运行为何耗尽30步

日期：2026-10-17。排查使用本机运行API、当前工具实现及无模型本地复现，未再次提交Agent任务。

## 结论：检索不收敛，最终由步数上限停止

- Session：`eba4fb38-030b-48e4-8b63-5ae5f59cdccb`，与原先15项通过的运行相同，并非新会话。
- Run：`2d06fca8-0a00-4ec3-bb3a-e8d0f42cccba`。
- 时间：`2026-10-17T04:06:05.433Z` 至 `04:07:57.073Z`，约1分52秒。
- 终态：`failed`，`execution-stopped.reason = step-limit`，不是`loop-detected`或Token预算停止。
- 30个工具调用、30个返回、30个step-finish；每步finishReason都是`tool-calls`。
- 输入1,542,627、输出1,105，累计已观测1,543,732 Token。输入是多次请求的累计，不是单次上下文长度。
- 未发生源码写入调用或写源码命令，没有构建，没有最终16项验收。新增断言执行两次，均为1失败，且均未超时。

## 实际轨迹

| 步骤 | 行为与证据 |
| --- | --- |
| 1–2 | 读取FOLLOWUP并运行新增断言。执行证据seq7保留了真正断言失败，但模型收到的seq8只有Browserslist警告。 |
| 3–8 | 读配置、定位并读测试和页面、查询Playwright版本，再次运行同一断言。这次命令增加`2>&1`，模型才收到断言详情。 |
| 9–17 | 反复搜索分组选择器及测试，读取库源码；第9/11步搜索完全相同，第10/14/17步也完全相同。目录搜索返回`.next/cache/webpack/*.pack`乱码。 |
| 18–30 | 继续搜索相关符号；第24步再次读取与第16步相同的27,188字符源码。最后一次工具返回seq94，停止事件seq96，失败状态seq97。没有转入修改。 |

## 已确认的两个工具缺陷

### 1. bash丢失真正错误，只返回stderr警告

`src/tools/bash.ts:94` 使用 `stderr || stdout || err.message`。只要stderr非空，stdout整体就不会进入模型可见结果。

本轮首次测试的执行证据记录stdout 2,941字符、stderr 204字符；stdout是期望`high-score-group`、实际`low-score-group`的断言失败，stderr只是过时Browserslist提示。模型侧返回只有警告。日志因此形成了“执行证据知道真错，模型不知道真错”的分歧。

本地最小复现：命令向stdout写断言失败、向stderr写警告并exit1。调用现有`createBashTool`后，证据有断言，返回值没有断言。断言检查全部符合这一缺陷。修正应同时保留两路输出及退出码，而不是要求每条测试命令额外写`2>&1`。

### 2. grep把二进制构建缓存当源码检索

`src/tools/index.ts:197–206`只排除`node_modules/.git/dist`和少量图片字体扩展，没有排除`.next`，也没有二进制内容识别。第10/13/14/17/29步均出现`.next/cache/webpack/*.pack`内容。

同时，工具最多收集50条匹配（`:201–213`），模型侧结果又受3,000字符限制。缓存既污染结果，也可能先耗尽匹配额度，使真实测试源码根本不返回。

本地最小复现：在临时test目录放入含NUL和51条匹配的`.next/cache/webpack/0.pack`，另放一条真实测试源码匹配。调用现有grep，结果包含缓存而缺失源码。修正应默认跳过生成缓存及二进制，并保留对正常文本源码的搜索。

## 为什么已有死循环检测没拦住

`src/agent/loop-detection.ts:185–245`关注相同工具和精确参数重复，以及两个参数模式交替；窗口30次，警告阈值5、严重阈值8。改变搜索词就成为不同参数，本轮同一精确调用最多重复3次。

将本次30条实际工具调用及返回按顺序重放到现有`detect/recordCall/recordResult`后，**没有任何warning或critical**。它能识别机械重复，识别不了这次“不断换关键词但不进入下一阶段”的执行形态。最终由`src/agent/loop.ts:369–370`的30步硬上限终止，失败提示正确显示。

## 旧会话放大了上下文负担

本次任务沿用原来26步运行的session。`src/runtime/service.ts:392`向worker传入完整session.messages，`src/agent/loop.ts:150–155`每步继续提交当前消息；相同FOLLOWUP用户指令在会话内出现两次。

本轮第1步输入已达40,052 Token，第30步为67,245。旧历史及本轮重复读取都会增加累计输入。新会话能减掉历史负担，但不会修复输出丢失和缓存检索问题。

## 下一步顺序

1. 先修Cheese的bash结果和grep搜索质量，以以上本地复现作为回归；不动cmdk候选，不先增加maxSteps或Token预算。
2. 再针对真实轨迹设计无进展提醒：要求整理新证据、定位假设或明确阻塞；不能把正常的多次只读调查直接判为失败，也不能强迫模型盲目写代码。
3. 工具问题修好后，才由用户在同一工作目录的新会话执行FOLLOWUP，并按原15项加新增1项验收。

原始当前run事件和修复前本地复现结果分别保存在`/private/tmp/cheese-followup-diagnosis/events.json`与`reproductions.json`。以上为修复前诊断，修复结果见下节。

## 修复与本地验证

用户授权修复后，完成三项改动：

1. `src/tools/bash.ts`：失败结果同时保留stdout、stderr和退出码。两路较长时分别截断头尾，合计留在工具结果额度内，不再让全局截断挤掉其中一路；原有只传command及单路输出入口保留。
2. `src/tools/grep.ts`：从原tools/index抽出搜索实现，保留原导出与参数。遍历排除`.next/.cache`，跳过含NUL或非法UTF-8文件；显式文本文件搜索仍可用，包括缓存内指定文件。
3. `src/agent/investigation-progress.ts`：最近最多12次只读返回中，至少8次调用且出现3次重复证据时提示重新评估。它比较工具名与实际输出，而非搜索词；新证据持续出现时不告警。修改/未知工具或工具执行错误后清空记录。提醒在完整assistant/tool交换后加入下一次请求，持久化为`execution-warning`，不硬停、不强迫修改。现有精确调用熔断和预算保持不变。

先新增回归，观察到5个预期失败；实施后相关18项通过。最后调整混合读写步的重置后，12项bash/终止测试通过；并行运行时新调查测试进程出现一次Node序列化通信错误（`Unable to deserialize cloned data`），仅补跑该文件，3/3通过。grep的3项在实现不变时复用通过证据。另有1项真实worker/工具集成通过；`npm run build`通过。全部使用本地命令和可控模型，无付费调用。

使用本次实际数据做非模型回放：

- 首次失败输出经过修复后的bash和ToolRegistry，仍同时包含断言信息和Browserslist警告。
- 当前真实cmdk测试目录的grep返回测试源码，没有`.next`乱码。
- 修复前30步的工具返回送入新提醒器，在第17步产生重复取证提醒；这是轨迹回放，不代表模型收到提醒后的真实行为已经验证。

结果见`/private/tmp/cheese-followup-diagnosis/fixed-replay.json`及`fix-tests-final.txt`、`fix-progress.txt`、`fix-worker.txt`。工具修复时cmdk候选没有代改。Web每次运行都会新建源码worker，新运行会加载修复，无需中断服务或重启既有会话。

## 后续真实运行及独立验收

用户随后在新会话单条执行FOLLOWUP，run `a8741e90-e752-4c4c-9e6e-ce1a0787a5c6`以completed结束，23步、22次工具调用、约4分19秒、498,933 Token。先复现失败，再修改库源码，构建及16项通过；主代理在干净副本以外置固定断言再次构建和16项通过，未调用模型。详见[followup-result.json](./followup-result.json)。该轮无`execution-warning`事件，工具修复与新会话的贡献未做因果拆分；后续不再重跑本案例。
