# 无界面研究服务

`src/app/services/research.ts` 持有通用 Quant 会话、运行和观察者。构造服务不需要 TUI、浏览器或 HTTP Server；`src/app/workbench/service.ts` 保留兼容导出，HTTP RPC 调用同一服务与参数校验。Quant/Pi 仍拥有模型上下文、工具和 journal，服务不复制 Agent 执行循环。共享输入和投影类型位于 `src/types/workbench.ts`。

旧单股研究的协调逻辑在 `services/research-workspace.ts`，继续使用原 manager 和 study store。继续操作保留 conversationId、固定证据和原终态历史，为新执行分配 runId；原取消运行不会被改回 running。删除先读取完整元数据，再按修订保存并返回持久化后的完整项目列表，保留 #44 的并发修改和损坏文件保护。它与通用 Quant 服务使用各自已有的数据格式，不互相冒充或自动迁移。

## 身份与提交

工作区由 storage resolver 选择的 `.ohquant` 根确定。服务先解析真实路径，消除链接或 junction 别名；Windows 仅在大小写变体确实指向同一文件系统对象时折叠大小写。当前入口的 `cwd` 不另造工作区。工作区身份不直接暴露根路径；移动数据根、迁移旧别名下的历史和跨机器同步不在本接口范围内。

`submit` 要求 workspaceId、sessionId、requestId、expectedRevision 和 text。接受提交前校验身份、修订、活动运行与恢复限制，先持久化接受状态再执行 Agent。同一存活服务内，相同 requestId 与相同操作/输入返回原接受结果，改变任一字段则冲突。回执只在内存中；服务重启后不得自动重试未知结果的提交。

`continue` 与 `followup` 还要求 previousRunId。两者保留 sessionId、创建新 runId，并在用户轮次中记录操作与前序身份。追问要求上一轮已完成；继续要求存在未完成的原上下文。未知、已取消或仍在执行的工具结果阻止继续；已完成或失败的工具仅在注册表声明其没有效果或全部效果为 local-read 时允许继续。网络、写入及未知工具均保守拒绝继续，避免只靠模型提示词防止重复副作用。用户核对后可明确提交新问题，但新问题不是自动去重或外部结果对账保证。中断确认不等于允许重放工具；完整副作用对账仍待 #77 完成。

旧检查点中当前运行的 assistant 记录缺失、重复、状态不符，或工具记录缺失、身份重复时，不能推断没有工具执行。重启后保留原记录并要求用户核对；即使核对后也不能用 `continue` 猜测恢复资格。已确认的不完整记录可以作为上下文供用户明确提出新问题，并不证明外部副作用已对账。

用户主动停止时，已经开始且可能带副作用的工具结果仍属未知：运行保持 `cancelled`，新问题须先针对原 run 和修订显式确认。确认不自动继续，也不把工具标成完成；确认后提出的新问题仍可能触发新的工具操作。无副作用的纯计算或只读工具按注册表效果判断，未知工具保守处理。旧版取消记录按这些规则投影，读取不重写文件。

工具抛错或返回结构化错误不证明外部副作用已回滚。同一运行的有副作用工具按顺序派发；一项失败后阻止后续此类调用，未派发项显示为未运行。即使模型随后结束、失败或等待输入，该运行仍要求针对原 run 确认；旧检查点按同一规则只读投影。该约束不能撤销已开始的操作，也不是外部恰好一次执行的证明。

重命名要求 workspaceId、sessionId、expectedRevision 和 title；中断确认还要求 runId。两者拒绝陈旧修订及保存、复核、删除中的并发修改。读取参数与可编辑偏好也使用共享校验；偏好的只读展示字段不能作为写入字段提交。

`needs_input` 来自服务组装的 `ask_user` 工具成功提出明确问题。该工具通过现有 Quant/Pi 执行并记录 journal，仍受已声明任务的工具范围限制；普通问句或任务证据 blocked 不会被猜测为等待输入。问题最多 1000 字，公开投影隐藏已知凭证。澄清请求给出后，服务阻止后续工具执行；Pi 按现有批次终止规则结束本轮，界面显示问题并停止运行计时。取消或错误仍优先于完成投影。

等待输入的状态与问题写入 checkpoint；重开只读取，不重问或续跑。用户通过带 previousRunId 和修订的 `followup` 回答，创建新 run 并保留旧轮次；普通 `submit` 在等待期间会被拒绝；其他研究可新建会话。不能以无回答的 `continue` 代替，也不能将未解决的澄清保存为已完成成果。

`cancel` 必须传递完整 workspace/session/run 身份。重复取消同一终态运行不再执行；旧运行不能取消新运行。释放订阅仅移除观察者，既不取消也不续跑。关闭服务拒绝新的修改，等待已接受的保存/复核操作并收束活动运行。

## 终端能力与同一运行所有者

在当前 #76 工作分支，服务的 `terminal` 入口与普通 `client` 共用会话表、journal、运行接受、修订检查和取消逻辑。终端运行复用既有技能、扩展与单组合约束；扩展注册表由 Host 持有，视图断开不销毁它。动态工具也必须在 checkpoint 提交后才执行。服务关闭先收束运行，再释放扩展。

每次终端 run 接受时固定当时的研究观察组及其标的，提示词和任务约束在该 run 内都使用这份选择。Host 在初始化后、模型提交前、工具调用前、结果结束前与排队输入接收时核对当前选择，并在运行期间约每 250 毫秒检查一次持久化选择；发现变化或无法读取时停止对应的旧终端 run，不把新组带入原研究。多个旧终端 run 分别按原身份停止，之后基于新组启动的 run 不受影响；浏览器拥有的 run 不由这一终端策略取消。检查是采样而非跨进程事务，极短暂的切换可能没有被采样到，但不会改变运行中固定的范围。

HTTP `/api/host/terminal` 要求普通连接 token、私有 control token 和当前 instanceId；浏览器 bootstrap 不返回控制能力。普通 RPC 不接受权限选择字段，Web 运行继续过滤系统工具并禁用动态技能。权限仅属于这次明确接受的调用，不写进历史作为未来自动执行授权；同一 requestId 不能跨权限路径复用。随后从浏览器继续同一会话仍按 Web 权限重建运行。

当前 #76 默认 TUI 已接入共享视图：AppRuntime 不在该模式创建 Agent 或扩展，普通输入、活动运行中的队列输入与已接入的会话命令交给 Host；退出只解除订阅和 presence，显式停止才取消对应命令或运行。纯界面面板仍复用原实现。旧报告恢复及完整终端展示仍未完成，不能以基础提交代替全部兼容验收。

私有 `enqueue` 携带 workspace/session/run/request 身份和 text。它要求原运行仍由终端创建、仍接收输入且未取消或进入澄清；不向浏览器创建的运行追加本地能力。流式修订会持续增长，因此此接口绑定 run，不要求界面刚刚读到的修订。引用展开前后均核对同一 Agent 与运行，随后复用 `enqueueAgentMessage`：工具执行期间 steer，否则 follow-up。最终接收边界由 Agent 保证，服务不能仅凭 running 状态承诺已入队；这依赖 #124 的核心修复。

同一服务内重复的相同请求返回原回执，变更内容或与提交/命令共用 requestId 则冲突。回执仅表示队列已接受，不承诺已执行；失败、取消或进程退出可能清空尚未消费的输入。网络结果不明时不得自动重试，重启不重放队列。`queue_update` 只投影原始显示文本到私有 context 的 composerQueue，不另建执行队列，也不把队列文本写入浏览器快照。终端切换视图、运行结束和取消后清空相应显示；断开观察不取消原运行。

私有 `context({ workspaceId, sessionId })` 供终端读取已有上下文：活动期间读取唯一 Agent 的消息、模型返回的思考文本与当前上下文用量；空闲时只读原 journal 分支，复用旧终端的消息/工具呈现转换，不创建 Agent、调用模型、重写历史或执行工具。空会话返回空上下文；原 journal 丢失时明确失败。未知的历史工具结果不显示为仍在执行。此接口返回普通会话快照用于身份与修订核对，但完整工具参数、结果及思考文本不会加入普通快照、SSE 或 checkpoint。

私有上下文同时返回原 journal 的会话编号、创建时间与消息/压缩/分支条目计数，不包含文件路径。TUI 的无参数 `/resume`（含 `/session`）打开原历史选择面板，选择行仍经 Host 恢复；空视图清除旧的当前会话标记。上下文读取串行化，切换后等待新视图读取再应用命令结果，迟到的旧读取不能覆盖新选择。空闲恢复不构造模型连接，用量返回 null；面板可展示同一 journal 已记录的用量，不沿用前一会话的数据。

上下文只通过私有控制接口读取，过滤当前及在途请求已知的凭证值，不返回模型鉴权配置、系统提示或可调用工具对象。读取期间会话切换或修订变化会要求重新读取；终端视图也丢弃被新读取、选择、公开修订或 detach 超越的结果。AppRuntime 合并在途读取，运行时定期刷新，空闲后停止轮询；关闭后不再更新界面。空闲恢复不虚构实时 token 用量，思考文本只取活动 Agent 已提供的内容。完整工具呈现及 HUD 延迟指标仍待验收。

`terminal-answer-review.ts` 提取原 AppRuntime 的绩效、权重、年报、基金、因子、风险、新闻与组合答案复核；旧入口和 Host 调用同一实现。终端运行结束后，Host 在释放 Agent 前核对最终回答，保留原文并将警告写入同一 checkpoint，视图断开不跳过复核。

启用既有 `artifactGeneration.auto` 后，终端运行的量化分析回答通过复核、且不需要澄清时，Host 复用 `generateCurrentSessionArtifact` 保存固定报告并追加原有 `artifact_export` 上下文。普通聊天、浏览器运行、失败或已取消的回答不触发自动报告。报告保留原核心会话 ID 与不可变版本格式；Host 仅公开标题、哈希和来源 run，不打开浏览器或返回本机路径。显式 Web 保存仍使用其既有工作台报告链。

报告元数据只有在会话 checkpoint 提交后才进入公开投影。生成失败保留回答与原文件并显示失败提示；报告已提交而 checkpoint 失败时保留不可变文件，不宣称成功或自动重试。若取消发生在报告落盘后的上下文写入期间，已保存报告仍记入会话，运行保持 cancelled。断开视图不取消上述收尾工作。终端完整状态栏、报告恢复与显式打开报告尚待接入，不能据此声称全部原终端行为已迁移。

## 终端会话命令

私有终端 `command` 当前接入 `/compact`、`/resume`（含 `/session` 别名）、`/clear`、`/skill`、`/mcp` 和 `/config --extensions`，复用 `src/cli/registry.ts` 的解析、校验和原命令回执。请求携带 workspaceId、sessionId、requestId、expectedRevision 和完整命令文本。压缩接受时检查修订并占用会话操作锁，等待当前研究收尾后，使用与研究相同的恢复入口重新打开原核心 journal；空会话返回原命令的提示，不创建空上下文或调用模型。

扩展管理复用 Host 的同一注册表，查询不创建 Agent 或 journal。启停/重载扩展、选择/移除/重载技能及安装/删除 MCP 配置要求所有会话均无活动研究或命令；修改期间拒绝新研究和会话命令，避免另一入口在资源切换中取得执行权。取消和重复请求沿用私有命令身份与回执，不自动重复修改。MCP 仍只编辑 Pi 配置或导出模板，不连接服务器；`--local` 使用 Host 会话的工作目录。TUI 多行命令结果仅保存在当前视图，在上下文刷新后保留，切换视图或开始新运行时清除，不写入研究 journal。

技能管理复用原安装、缓存选择和发现实现。Host 目录合并已启用扩展的技能，拒绝重名；列表与详情不构造模型会话，也不代表某个请求已获执行权限，真正调用仍使用 Agent 的资源与能力策略。补全建议从私有目录命令提取名称、描述和作用域，丢弃切换/退出后迟到的结果；建议读取不成为 Ctrl+C 的取消目标。无参数 `/skill install` 仍仅列出目录，不下载；移除选择保留共享缓存与本地修改。

`/clear` 显式停止来源运行，再创建空工作台视图供发起端选择；旧 journal、旧视图和其他会话保留。新视图首次提交时才建立新的核心上下文，清屏本身不调用模型。重复 requestId 返回同一选择，不重复创建会话；其他视图不会被强制切换。

技能调用（`/skill run`、`trigger`、名称及 `/skill:NAME`）在同一会话中创建 Host 所有的研究 run，保留原 handler 的技能发现、额外指令与 `--image` 校验。图片像素只用于当前执行的模型请求，journal 保存原有图片元数据，后续独立请求不重放像素。界面沿用 `SKILL.NAME`；普通浏览器不能调用该私有命令。技能运行期间允许私有上下文读取，仍拒绝同会话并发修改；视图断开不取消执行，按 run 或 command 身份显式取消才停止对应运行。最终 checkpoint 失败返回失败，不把模型已回答当作保存成功，也不自动重复执行。

终端普通文本在 Host 中复用 `ComposerReferences` 展开文件、证据和会话引用，传给模型的内容与界面保留的原始输入分离。引用不存在或无法读取时，在模型调用前结束本轮；浏览器尚未开放引用读取，会在提交前拒绝显式引用，不把它作为普通文本发送给模型。

默认 TUI 的引用建议通过私有 `suggestReferences` 接口读取。文件相对于所选会话的 Host 工作目录；当前证据来自活动 Agent 的分支，空闲时只读同一核心 journal，缺失时明确失败。建议不会创建 Agent、调用模型、切换会话或改写历史；响应带 workspace/session/run 身份，读取期间所有者变化则拒绝返回。终端客户端继续过滤新查询、切换会话、新 run 和 detach 后迟到的结果，建议请求不占用研究的取消目标。普通浏览器 `references` 接口仍不开放本地文件能力。

共享终端的结构化研究通过私有 `submitResearch` 接受任务、会话修订、任务修订和请求标识。Host 使用原单组合约束和 `QuantResearchHarness` 校验并追加任务声明，再由同一个 run 展开引用并提交问题；模型提交前校验失败或取消不会发送模型请求，提交后的取消不会抹去已经发生的请求。声明已提交但后续引用或模型失败时，任务记录留在原 journal，客户端可检查后明确操作，不自动重复声明或执行。相同标识和内容返回原回执，改变内容会冲突；普通浏览器 RPC 不提供该接口。终端等待固定 run 的终态，显式取消绑定原身份，detach 只停止本地等待。

`/resume --task` 继续使用原命令的任务投影，默认 TUI 将有效结果交给原研究任务面板，不额外请求模型或写 journal。活动研究期间也可读取；新 run、切换会话或 detach 后迟到的结果不打开旧面板。

终端报告选择通过私有 `restoreReport` 恢复原会话和报告，不在 Host 进程打开浏览器。服务固定报告版本、校验来源与 provenance，并锁定发起会话及报告来源会话；来源正在运行、被其他操作占用或需要核对时拒绝恢复。未映射的旧 journal 先沿用只读导入路径建立唯一视图。原恢复实现负责物化 HTML、定位报告的固定分支并追加上下文说明；服务重新投影该分支，清除不再对应当前分支的工作台输出，再提交 checkpoint。旧报告版本和原 journal 条目保留，恢复不调用模型。

移动 journal 前，服务先在既有 checkpoint 写入需要人工核对的中断状态；恢复和最终 checkpoint 成功后才清除此状态。若移动后无法确认或保存，当前 Host 禁止继续使用该会话；重启后的 checkpoint 仍要求核对，不自动重试。报告文件路径只通过受控制能力保护的回执返回，发起终端确认选择未过期后才打开。该恢复会改变原 journal 的当前分支；工作台的只读 `reload` 是另一项操作，不会移动分支。

命令占用期间，同一会话的新研究、保存和其他修改被拒绝；其他会话仍可运行。同一实例中的重复 requestId 返回原回执，改变内容或跨研究请求复用该标识会被拒绝。成功压缩提交新 leaf 和 checkpoint 修订后才发布更新，已有公开对话及固定报告保持不变。journal 与 checkpoint 仍不是跨文件事务：未知结果必须重读核对，不自动重试或回滚已完成的压缩。

`cancelCommand` 使用 workspace/session/request 身份，只取消指定命令；取消排队命令不取消它所等待的研究。命令在五分钟后自动请求取消，关闭 Host 时先同时通知命令和活动研究取消，再等待各自收尾，避免相互等待。断开终端或切换视图不取消命令；视图通过请求身份与选择序号过滤迟到结果。命令和取消接口均要求私有控制能力，普通浏览器 RPC 不提供它们。默认 TUI 已使用这些命令入口，剩余命令仍须逐项完成兼容验收。

`/resume` 的目录范围和完整核心会话 ID 匹配规则沿用原实现。无参数时列出历史，`--task` 只读取当前 Quant 任务；选择目标时，通过 `CommandContext.sessionCommands` 调用 Host 的会话选择能力，原 handler 仍负责输出。已有工作台会话返回 `selectedSessionId`，仅发起命令的视图切换订阅，不修改来源会话或取消其研究；来源仍在初始化、目标仍在运行时也不另建 Agent。迟到的选择结果不能覆盖用户后来的视图选择。

旧终端 journal 尚未对应工作台记录时，`legacy-session.ts` 只读其当前分支，在既有 checkpoint 格式中记录 coreSessionId、leaf 和经过凭证过滤的用户/助手文本，隐藏推理与内部上下文。原 journal 不复制、不改写，导入和恢复不请求模型或执行工具。并发恢复复用同一映射；重启从 checkpoint 头恢复映射。明确删除工作台记录后可以重新建立视图，核心历史仍保留。无法确认损坏记录的映射时拒绝创建替代记录；导入提交失败保留原文件，当前实例不自动重复导入。

已完成的旧历史以 idle 视图打开，runCount 为零。未完成历史使用独立恢复标识及 interrupted 状态表示待检查的旧结果，该标识不代表新执行。缺少结果的工具标为 unconfirmed，沿用已有核对门槛；确认中断也不授权自动重放。只有用户后续明确提交才创建新的执行 run，并继续使用同一核心 journal。

## 保存、只读重开与独立复核

`save` 要求完整 run 身份、expectedRevision 和 expectedArtifactRevision（首次保存为 null）。仅保存已完成且拥有固定 journal 位置的运行。终态在现有私有 checkpoint 中记录可选 coreLeafId；旧 checkpoint 仍能读取，但缺少此位置时不会猜测最新 journal 内容并保存为旧成果。

保存使用已有 artifact generator 和不可变 report store。每个工作台会话拥有自己的报告版本链，结果包含 artifactId、递增版本、内容哈希、创建时间和来源 runId。报告头的预期哈希在存储写锁内校验；旧版本仍按固定哈希读取。本保存接口不通过普通 RPC 状态返回完整 HTML、原始轨迹或源文件路径。

工具返回的独立 `HTML:` 行若包含绝对本地 `.html` / `.htm` 路径，公开工具结果、回答与思考会隐藏该完整路径及 JSON 转义形式；流式前缀先暂存，后续运行从原 journal 分支重新识别这些值。URL、财务数字和日期不因此重写。该规则不识别任意格式、变形或不带该标记的路径；旧检查点读取时也会隐藏能从工具文本识别出的路径，原文件不自动迁移；用户输入也不是任意敏感信息过滤器。私有 journal 和原报告不修改。

保存期间，该会话拒绝新的提交、重命名、删除或第二次保存；只有 checkpoint 提交后，读取与订阅才显示新成果。对话 checkpoint 与 report head 分别原子提交，并非跨文件事务：如果报告已提交而 checkpoint 随后失败，服务返回失败并保留已生成的不可变报告，不删除它伪装回滚，也不自动重试。需核对磁盘记录再处理，不能把未知结果当作成功保存。

`reload` 选择所属会话中的固定 artifactId/hash，返回该运行截至保存点的公开对话、报告元数据与固定证据引用。它不读取新行情、不生成新报告、不调用模型、不改变当前运行。损坏版本返回错误，不退回更新版本或重建原报告。公开对话是工作台投影，不等于私有 HTML 的完整审计轨迹。

`review` 另外要求 requestId、来源会话的 expectedRevision 和复核问题。来源有待核对工具结果时不能启动复核；确认前仍可只读重开已有报告。服务校验报告引用及原 journal 分支哈希，通过已有 SessionRepo.fork 在报告的固定 leaf 创建新核心会话，再创建新的工作台 session/run。分叉前后均核对磁盘 checkpoint 修订；另一客户端已修改来源时拒绝启动复核。新会话保留 source 中的报告身份；不会移动原会话的 leaf，也不会把报告保存后追加的问题带入旧版本复核。原分支损坏或注入的仓库不支持 fork 时拒绝复核，不改用空上下文。复核的接受回执同样只在当前服务中去重。

### 原始 HTML 的私有读取

`readReport` 接收与 `reload` 相同的 workspace/session/artifact/revision 身份，但返回经过不可变快照校验的原始 HTML、UTF-8 字节数及独立内容 SHA-256。先确认报告属于指定会话，再读指定版本；旧版本不被当前 head 替代。它不启动 Agent、不读取新行情，也不改变当前运行。空报告返回零字节；缺失、损坏或不属于该会话的版本返回 `ARTIFACT_UNAVAILABLE`，超过 8 MiB 返回 `ARTIFACT_TOO_LARGE`。该限制约束导出大小，不是底层快照文件读取的内存上限。

HTTP 使用 `POST /api/workbench/report`，JSON body 为 `ArtifactRequest`，沿用当前 Host 的 token、origin 与实例身份校验。成功响应为原始 UTF-8 HTML attachment，携带 `X-Report-Revision`、`X-Report-Content-SHA256`、Content-Length、no-store、nosniff 和禁止执行/嵌入的 CSP。报告快照 revision 包含元数据，不能拿它替代 HTML 内容哈希。导出不经过对话脱敏重写；若原文包含当前 Host 的连接或控制 token，则拒绝导出并保留文件。

这是显式私有下载能力，不是公开分享，也不代表已实现工作台交互预览。原始 HTML 可能包含私有轨迹、脚本与外部引用；保存到文件后打开的行为不受下载响应头保护。界面接入与隔离预览由独立实现验收。

### 人工假设基线与事件复核

`establishThesis` 将用户明确填写的一条 A 股数值假设登记为私有基线。输入引用当前会话内已有报告的精确版本，并给出观察组、股票、指标口径和阈值；生效时间由服务在保存时设定。已有 HTML 不被自动推断为历史结构化假设，基线设立前的事件仍标为待核验。

`saveThesisReview` 只接收这条基线的精确引用和本次事件、固定证据、截止时间、可选价量快照及明确的人工决定。旧假设由服务读取，不接受调用者重写。纯比较器将结果分为价格观察、假设复核、待核验或无实质变化；人工决定单独保存，不由分类推断。未来截止时间被拒绝；缺少证据可保存待核验报告，声明了快照却没有匹配保留原文则返回 `THESIS_EVIDENCE_UNAVAILABLE`。原文 SHA-256 绑定保留字节，只证明归档完整性，不证明用户摘录或指标计算符合外部事实。

三项操作 `establishThesis`、`saveThesisReview` 和 `readThesis` 通过现有认证 RPC 暴露；写入校验工作区、会话、报告归属、会话修订和忙状态，不创建 Agent 或调用行情服务。请求体仍受 Host 的共同大小上限约束。固定输入和保留原文保存在不可变快照的 `privateResearch` 中，见 [Storage](storage.md)；报告摘要只增加可选的基线/复核类型。`readThesis` 返回经过校验的假设、比较结果和来源摘要，不返回保留原文正文，也不建立公开分享副本。原始 HTML 读取复用上文的私有导出。

请求标识在同一工作区/会话内绑定规范化输入。并发相同请求共享结果；跨重启重试复用原始版本和字节，不重新设立时间或生成报告；改变输入则返回 `REQUEST_CONFLICT`。会话修订不属于业务指纹，允许刷新后重试。先写不可变快照、再写会话 checkpoint；后一步失败不会把失败候选加入会话。重启后重试相同输入，可验证并接回该候选，避免重复版本。归档缺失、损坏、基线不匹配或来源不属于该会话时拒绝读取，不回退到最新版本。活动研究可以读取既有基线；新的人工写入等待运行结束。

`collectThesisTsp` 显式读取已有基线的股票，经过同一认证 RPC 发起一次 TSP 观察采集；`readThesisTsp` 只读取精确固定版本，不连接服务。采集复用 [Pi 的 MCP 连接与只读配置](../quant-harness/community-tools.md)，只调用 `get_recent_alerts` 和 `get_kline`，不创建模型会话。服务在连接前验证基线归属和修订，采集中持有既有资源读租约并阻止同一会话的新运行或修改；关闭服务取消采集并等待子进程清理。活动研究期间仍可读旧记录，新采集需等待运行结束。

原始 JSON、工具参数、来源、采集时间、配置声明的权限和摘要保存在 `tsp-observation` 私有 Artifact 中；界面只接收有界摘要与精确引用，不把大段原文回传给 Host。原始 HTML 导出展示保留的结果文本和不可用原因。原文上限为每个工具 512 KiB；缺失工具或无效返回保留为不可用，不伪造空数据。相同请求的并发、重启和 checkpoint 故障重试复用同一快照，不再次调用 TSP；新的显式采集须使用新的请求标识。配置声明不是服务端授权证明，合法 JSON 和哈希也不是基本面认证；行情窗口、当日未完成 K 线和成交量单位仍须按来源核实。

复核可附加 `tsp` 精确选择：观察 Artifact ID/revision、可选提醒原始索引及日线起止日期/成交量单位。服务从已归档 JSON 提取同股票有效提醒，保留最多 20 条可选记录并显示其他记录数量；不会绑定空股票批量提醒。选择提醒时事件内容必须与原记录一致且类型为价格，存在有效提醒价格时生成带原文摘要的价格证据；缺失价格仍可能待核验。基本面复核可不选提醒，只附行情背景，仍须提供自己的披露证据。

日线必须匹配股票与 stock 类型，日期、OHLCV 和唯一性通过检查后按日期排列，只保留北京时间采集日之前的数据。用户选择固定范围并明确确认成交量单位；服务按这个窗口读取原始数据，固定前复权口径，不接受界面覆盖的 TSP 蜡烛。保存与重开均核对观察归属、基线、原始摘要、选中事件、派生证据及图表；损坏或缺失来源直接不可用，不再调用 TSP。原始 HTML 仍可按其固定字节导出，这不等于通过当前来源校验。

`src/app/services/test/thesis-review.test.ts` 使用隔离工作区、合成来源及真实 Pi stdio 传输验证认证 RPC、固定版本重开、原文完整性、重复提交、checkpoint 故障恢复、人工决定、资源租约、取消清理及活动运行保护。真实 TSP 和用户体验验收仍须使用后续提供的实例配置；这些测试不证明外部来源可用或数据正确。

显式来源核对由 `collectThesisSources` 与 `readThesisSources` 提供，绑定当前会话的精确假设基线。采集复用研究操作的资源租约、幂等请求和检查点：配置行情与可选公告 PDF 并行读取，关闭服务会取消并等待两者结束；重复请求复用已有来源快照。日期窗口必须在上海当日之前且不超过 366 个自然日。未取到来源保留不可用原因，不补造数据，也不运行模型。

读取接口默认只返回行情/公告摘要，显式页码最多返回 20,000 个字符；完整分页文本保存在私有快照。复核的 `checks` 引用精确来源版本，可选择不超过 4,000 字符的逐字原文、页码及用户声明的发布时间、指标与确认状态。服务核对归属、基线、取得截止、正文摘要及引文确实存在；用户确认不是自动认证发行人或财务事实。未确认的引用作为解释判断，不能单独支持基本面成立。

与 TSP 或手动固定行情的比较仅覆盖同口径、同日期集合的 OHLC；缺失、过期、未知复权或不完整窗口显示不可比。重开不重新取证，DatasetRef 或来源损坏时拒绝验证，已保存报告字节仍保留。TSP 提醒不替代公告原文，两个工具一致也不证明上游独立。
## 删除与失败边界

`deleteSession` 明确删除工作台会话 checkpoint，要求 workspaceId、sessionId 和 expectedRevision。活动运行及保存/复核中的会话不可删除。存储在同一写锁内验证文件格式、工作区身份和字节修订后删除；已损坏的文件即使哈希已知也保留。它不删除核心 journal 或不可变报告版本，也不等同于旧单股项目的删除。

删除最后一个会话后，列表为空，identity 返回 SESSION_NOT_FOUND；客户端可显式 createSession。已删除会话不再提供其工作台重开投影，底层固定报告仍保留。当前 Web 页面没有新增这些报告/删除操作按钮，交互接入归 #50；终端共享连接与旧命令兼容由 #76 负责。

直调和 HTTP 使用同一运行时参数校验，拒绝额外字段、任意路径、缺失身份和无效修订。模型凭证不作为偏好或普通快照返回。这里的本机可信存储不是同一账户内恶意进程的隔离边界；Host 的唯一写入者、发现与退出协议由 #75 负责。

回归位于 `src/app/services/test/research.test.ts`、原单股研究测试和 storage 的 artifact/checkpoint 测试，覆盖两客户端陈旧写入、请求去重、精确取消、固定分支、损坏保留与异步关闭。完整门禁为 `bun run check:release`；受控模型测试不证明真实 provider 质量或已安装 Desktop 行为。

## 资源持续测量

`src/app/host/test/resource-duration.ts` 在指定的干净、固定 revision 上运行受控研究和 SSE 重连。调用形式为 `bun src/app/host/test/resource-duration.ts CHECKOUT RECEIPT INTERVAL_MS DURATION_MS`；回执父目录须已存在，回执不得覆盖已有文件。间隔至少一秒，总时长至少两个间隔；实际多日测量须明确选择相应时长，并保证机器持续运行。

每轮创建合成会话，最多保留 40 条，等待研究、订阅和依赖清理结束后记录内存、observer、清理计数和 Agent 弱引用。回执绑定源码 revision、harness/锁文件哈希及运行环境，只保存聚合值；独立临时工作区与 loopback provider 不使用真实凭证。单个进程也包含 provider 和采样开销，不能把全部资源占用归因于 Host。

采样缺口超过容差、清理失败、未收敛、样本不足或检测到源码变化时，结果标为 `incomplete`；缺少最终回执也不能算完成。请求 GC 后弱引用仍存活不单独证明泄漏。短回归覆盖正常结束、强引用正对照、清理失败及模拟时钟缺口，只验证测量机制；实际连续多日数据和后续资源决策仍归 #146，不因合入测试而完成。

短回归使用独立的稀疏 clone，只展开 `src/` 和根目录清单，并共享原仓库的只读 Git 对象及已安装依赖。它固定 HEAD、检查源码干净，不注册临时 worktree，也不复制 app、site、docs 资源或修改调用者的 Git 配置。Git 子进程保留有限时长，并在清理前等待退出及输出读取完成。初始化失败保留原始命令、退出状态与诊断；若清理也失败，两份错误一并报告，并指出保留的临时目录。清理仅处理经路径校验的自有目录，先断开外部依赖链接。这些机制不解释历史 runner 的具体变慢原因，也不替代真实多日测量。

## 显式行情采集任务

已认证的工作区客户端可通过 `startObservationJob` 对一个沪深京标的提交日线、指定分钟周期或复权因子采集，再用 `readObservationJob` 查询，或用 `cancelObservationJob` 请求取消。请求必须指定有界 UTC 毫秒窗口；日线最多 366 天、分钟最多 31 天、因子最多 3660 天，K 线明确指定复权口径。服务使用本机已保存的当前数据源，不接受请求中携带凭据；单个 Host 同时只执行一个采集任务。

任务完成时返回空结果或已提交的精确归档引用；错误只返回固定代码，不传递供应商响应或本机路径。取消只是请求中止，若写入已经提交，最终仍返回真实归档结果。任务状态仅保留在 Host 内存中，最多保留 20 条；Host 停止会取消并等待在途任务，重启后状态不可恢复，已提交归档仍留在本机。调用方需要保存引用。[数据设置](../quant-harness/web-ui.md)提供手动采集入口；采集结果保留未验证的权限与覆盖边界。归档语义见[存储](./storage.md#版本化行情观察归档)。

Runtime 的 `deriveTspArchiveIndicators` 接受精确的 v2 日线归档引用，按交易日排序并用最早一行初始化 TSP 口径的 RSI6/14/24 和 ATR14。结果绑定归档修订、公式版本与 TSP 源码修订，并保留来源、采集时间、复权方式、请求区间和实际首末交易日。计算逐行使用归档已有数据，缺失日期保持为空缺；更换输入窗口可能改变重叠日期的结果。覆盖率和 K 线最终状态仍为未知，结果用于预览。缺失、损坏、取消或无效版本直接失败。此内部入口只读本地归档，由后续 Host 和界面接入。公式细节见 [TSP 列目录](../quant-harness/tsp-list-catalog.md)。

板块采集入口 `collectSectorObservations` 使用设置中选定的数据源，一次采集一个指定交易日的行业或概念目录，或一个板块的成分。当前支持 Tushare 的东方财富分类，目录和成分各自保存实际端点、交易日、采集时间和精确归档引用。供应商成功返回空列表时，回执仍带 `status: "empty"` 和可离线读取的引用。错误或取消若发生在归档提交前，调用直接失败。覆盖范围继续标记为未知，交易日与采集时间各自保存，历史发布时间和成分生效区间仍未知。

行业和概念排行可通过 `replayTspSectorRanking` 离线计算。调用方提供市场横截面、一个板块目录和所选板块成分的精确归档引用。回放校验供应商、市场、交易日、分类体系和板块身份，用横截面中的股票池限制参与标的，将涨跌幅百分点换算成比例、成交额从千元换算成人民币元。结果保留市场、目录和成分的归档引用和采集时间，并区分未采集板块与已采集但成分为空的板块。输出使用 `provider-dated-snapshot` 口径描述供应商为该交易日返回的快照，覆盖保持未知，历史发布时间和生效区间仍未知。

`replayTspSectorRotation` 接受多份单日排行的归档请求，在本地按交易日计算板块涨幅排名和名次变化。每个输入日保留市场、目录和成分引用与覆盖信息。无可比收益的日期仍保留在证据中，并中断与下一个交易日的名次比较。重复日期、混用市场范围或分类口径、损坏归档和取消会使回放失败。

`replayTspMarketLadders` 使用调用方提供的上海交易日序列、同日期的市场横截面归档和每只股票的生效限价归档。在未复权行情与限价同时存在的日期，回放复用 WhyJ 日线涨跌停规则，再计算连续封板、首板和各档宽度、晋级率及封板率。每个结果保留市场和限价的归档引用与采集时间。缺失的交易日、价格或限价保持不可用，连板长度在下一次观察到未封板前保持未知。调用方需提供实际相邻的交易日，归档采集时间仍独立于交易日。

历史分时入口 `collectHistoricalMinuteObservations` 按设置选择数据源。Tushare `stk_mins` 返回的上海时间、成交股数和成交额直接保存到不可变归档。空结果不生成归档引用，覆盖范围、复权口径和数据最终状态继续保留为未知。归档引用可用于 `deriveTspArchiveIntraday` 离线重算 11 项分时特征和 4 项穿越信号。

回放使用 `tushare-stk-mins-end-time-v1` 时间标签约定。该约定依据供应商文档样例，将常规右端标签映射为这一分钟的起点，例如 `09:31` → `09:30`、`15:00` → `14:59`。结果同时保留原始标签。原始 `09:30` 开盘边界单列，不参加常规分钟的成交量和 VWAP。遇到无法映射的标签立即失败；盘中缺口沿用 Quant 的显式空值语义。可选昨收来自同一标的的精确涨跌停价归档，调用方须明确确认价格口径相容。缺失昨收时，昨收收益率和零轴穿越仍为空。

认证采集任务支持 `{ dataset: "historical-minute-bars", symbol, startDate, endDate }`。日期窗口至多 31 天并早于上海当天。可选认证 RPC `readObservationIntraday` 接收 `{ archiveRef, tradeDate, previousClose? }`，只返回指定日期的指标和开盘边界。日期必须在归档请求窗口内，窗口内无记录的日期返回空行并保留未知覆盖。若补充昨收，`previousClose` 须同时含精确限价引用 `ref` 和 `priceBasis: "caller-confirmed-same-basis"`。归档受损和缺失返回同一固定诊断。旧 Host 通过 `METHOD_NOT_FOUND` 表明缺少此可选方法。

`readObservationIndicators` 是可选的认证 RPC。它接收 v2 日线归档的版本和摘要，返回指标序列、公式身份及输入来源。`daily` 返回 WhyJ 生产的 37 个日线字段，包含单独的公式身份与按日取值；预热不足的值为 `null`。`input.source` 标识所归档输入的供应商，`daily.producer` 标识执行计算的 WhyJ。Desktop/Web 按类别查看归档最新日的各项指标，并分别展示供应商、公式、预热空值与数值零。旧版 Host 若只返回 RSI6/14/24 和 ATR14，界面使用对应的四项预览；缺少整个方法则显示版本提示。归档在 Host 重启后仍可按同一引用回放。无效引用返回参数错误，缺失和损坏共用固定的不可用诊断。调用只读本机归档。

`dailySignals` 从同一固定归档回放 WhyJ 的 20 个日线规则。每个交易日的规则结果用 `true` 表示命中，`false` 表示有足够输入且未命中，`null` 表示预热或输入不足。涨停、跌停、炸板和翘板需要额外的生效限价和未复权价格，只有基本日线归档时保持 `null`。规则有自己的公式 ID 和版本。旧 Host 可省略此部分。

Runtime 的 `collectTradingLimitObservations` 将选定来源的每日生效限价采集为固定引用。`deriveTspArchiveIndicators` 可额外接收限价引用和同标的未复权日线引用，以交易日精确对齐。主日线已是未复权时可复用该引用。Quant 将生效价分别减去或加上 0.005 元，得到与固定 TSP 公式一致的比较价。缺日或缺项保持 `null`，返回值保留两个输入的引用和来源。

Runtime 的 `replayTspPriceDeviation` 接收标的、按升序排列的上海交易日、前复权日线归档引用和可选的基准指数归档引用。逐日返回股票收益率与指数收益率的差值，单位为比例，窗口为 3、10、30 个交易日。股票和指数使用同一组起止日。窗口端点缺少任一收盘值时保留对应日期并返回 `null`。范围内与交易日清单不一致的归档行会被拒绝。

回执保留所用股票和指数归档修订、来源、采集时间、价格口径及 WhyJ 公式版本。调用方可显式选择板块的基准指数或备用指数，回放期间不会切换基准。省略基准引用可检查股票归档和窗口，但偏离值为空。回放只读本地归档。

选定 TickFlow 后，可用以下命令采集北证 50 基准和股票前复权日线，再用对应回执的 `data.ref.revision` 填写偏离回放清单。

```powershell
whyj --json observation collect-benchmark --symbol 899050.BJ --start 2025-02-10 --end 2025-03-31
whyj --json observation collect-daily --symbol 920001.BJ --start 2025-02-10 --end 2025-03-31 --adjustment forward
whyj --json observation replay-price-deviation --manifest deviation.json
```

清单包含 `symbol`、`sessions`、`stockRevision` 与可选的 `benchmarkRevision`。将实际交易日按升序完整列入 `sessions`。计算 30 日偏离至少需要连续 31 个交易日和两份归档各自的窗口端点。

输出的 `proximity` 为每个已结束的交易日记录 3、10、30 日偏离的方向阈值、接近度、主导窗口和状态。接近度以比例表示，由 WHYJ 基于固定 TSP 阈值口径计算。缺少股票或基准窗口端点时，对应接近度为空。[指标与阈值口径](../quant-harness/tsp-list-catalog.md#completed-session-stock-price-deviation)

`collectDepthSnapshot({ tradeDate, symbols })` 对当前上海日期的明确 A 股标的清单发起 TickFlow 批量盘口采集。Runtime 按 Source 的请求上限依次读取各批，成功后生成一个固定归档。回执保留请求范围、批次数、实际归档行数、缺少的标的，以及因日期或接收时刻不匹配而排除的标的。所有批次成功但没有有效盘口时仍生成空归档。批次失败或采集取消时保留已有归档。

Runtime 的 `collectFinancialObservations` 通过本机配置采集单只 A 股。`report-financial-indicators` 接受起止报告期，`financial-disclosure-dates` 接受一个精确报告期。收据包含实际来源、端点、采集时间、记录数和精确归档引用。Tushare 明确返回空响应时，状态为 `empty` 且仍保存捕获证据。无权限、取消或不支持时直接失败。采集与归档保留两类响应的独立时间，回放使用的财务版本需另行校验其可用时点。

Host 的认证采集任务支持 `{ dataset: "daily-trading-limits", symbol, startDate, endDate }`，凭证来自已保存的选定来源。非空收据包含带种类的归档引用。可选认证 RPC `readObservationExchangeIndicators` 以 `{ archiveRef, tradingLimitArchiveRef, rawArchiveRef? }` 回放，两种归档缺失或损坏均返回固定的不可用诊断。原有 `readObservationIndicators` 继续接收单份日线归档引用。旧 Host 对可选新方法返回 `METHOD_NOT_FOUND`。

Runtime 的 `collectMarketCrossSection` 通过配置的数据源采集指定交易日的股票池、日线和每日交易统计。当前接口使用 Tushare 的三个独立响应。股票池为空时返回空结果，缺失的行情行保留为缺失，已经捕获的原始行和供应商单位由 Storage 按摘要保存。

`collectRiskWarningObservations` 通过配置的 Tushare 查询指定交易日的 `stock_st`，返回来源、交易日、采集时刻、行数和精确归档引用。成功返回空名单时，回执仍包含可离线读取的引用。观察覆盖保持未知，交易日名单由历史股票池回放按需使用。

`collectBenchmarkIndexObservations` 通过配置的 Tushare 采集一个沪深基准指数在指定日期范围内的 `index_daily` 数据。回执包含指数代码、请求范围、采集时刻、单位、行数和精确归档引用。供应商成功返回空列表时保留可离线读取的引用，状态为 `empty`。采集只保存供应商点位和涨跌幅，市场环境指标在回放时计算。

当选定来源是 TickFlow 时，同一采集入口接受其 `/v1/klines` 返回的沪深指数和北证 50。归档保留实际来源、交易日和原始时间戳，缺少的昨收、点差和涨跌幅保持为空。拒绝的来源响应会结束本次采集，原有归档仍可回放。

`replayTspMarketEnvironment` 按指定交易日历连接市场截面、前复权价格历史、交易所涨跌停和基准指数归档。WhyJ 用连续复权收盘价计算个股涨跌幅，涨跌幅中位数在样本数为偶数时取中间两项的平均。强涨跌占比的分母是股票池中匹配到日线的行数，站上 MA20 要求复权收盘严格高于有效均线。基准指数按同一交易日读取供应商涨跌幅并换算为比例。结果保留价格、梯队、基准和覆盖证据。阶段默认按因果模式回放，`retrospective-tsp` 模式标记使用后续观测作为起点的字段。股票池以传入的市场归档为准，历史风险警示剔除需要对应日期的独立证据。

`replayTspMarketEnvironment` 和 `replayTspMarketLadders` 可通过 `riskWarningRefs` 启用按日筛选。当天名单中同时出现在股票池的标的从涨跌幅、MA20 和梯队的统计范围剔除。原始行情与交易所上下限仍用于计算标的跨日连板。上一交易日缺少名单或标的在当时被剔除时，晋级率保留覆盖不足的状态。回放记录名单引用、采集时刻和实际剔除的标的。成功的空名单保留当日股票池，缺失名单时当日的新强弱和梯队计算为空。名单的供应商覆盖保持未知。

`replayTspMarketMainline` 复用梯队回放的逐股连板和成交额，按交易日连接固定的行业或概念目录及成分归档。计算使用统计范围内的全部逐股输入，并保留市场、交易所涨跌停、风险警示、目录和成分引用。缺少市场或成分归档、启用筛选时缺少风险警示名单，均会在当日标明原因。已捕获的空目录仍形成可验证的空结果，部分成分缺失时保留缺项和实际参评范围。

`deriveTspMarketBreadthArchive` 按精确引用离线关联三个响应。它将手转成股、千元转成元、供应商涨跌幅百分数转成比例，并保留各端点的采集时间、匹配数量和原始覆盖状态。WhyJ 输出市场宽度、涨跌幅分布、成交额和换手率统计及排名。没有滚动历史时，五日量比、均线宽度和新高新低保留为空；供应商量比随原数据归档。

可选的 `history.priceArchives` 提供股票池内标的的精确前复权日线归档。归档须结束于截面交易日，末日收盘与截面收盘一致时才计算 MA5/20/60 宽度及 60 根日线收盘高低点。回放记录每个归档的匹配结果，历史不足时保留空值。`history.volumeArchives` 提供至多五个严格递增的此前市场截面。只有五个输入日期都存在该股的同单位成交量，且平均成交量大于零时，才用当日成交量除以这五个观测的均值。结果保留这些输入的日期和来源；输入日期的覆盖与历史可得性仍需数据使用方确认。

CLI 使用已配置的 Tushare 采集一个交易日的市场截面，将回执的 `data.ref.revision` 传给离线回放。结果保留股票池覆盖、三份响应的供应商、缺失记录和 WhyJ 公式版本。

```powershell
whyj --json observation collect-market --date 2024-01-05
whyj --json observation replay-market --revision MARKET_SHA
```

`--price-revisions` 接受逗号分隔的前复权日线归档修订。大量标的可用 `--price-revisions-file` 提供相同修订的 JSON 字符串数组。`--volume-revisions` 接受按交易日递增的至多五个市场截面归档修订。仅传单日市场归档时，均线宽度、新高新低和五日量比保持不可用。

市场强弱和周期回放使用单独的归档清单。用配置的 Tushare 采集市场截面、涨跌停和基准指数，用支持前复权的数据源采集股票日线。将各回执的 `data.ref.revision` 填入清单。

```bash
whyj --json observation collect-market --date 2024-01-05
whyj --json observation collect-limits --symbol 600000.SH --start 2024-01-02 --end 2024-01-05
whyj --json observation collect-benchmark --symbol 000001.SH --start 2024-01-02 --end 2024-01-05
whyj --json observation collect-daily --symbol 600000.SH --start 2023-12-01 --end 2024-01-05 --adjustment forward
whyj --json observation replay-market-environment --manifest environment.json
```

```json
{
  "sessions": ["2024-01-05"],
  "marketRevisions": ["MARKET_SHA"],
  "limitRevisions": ["LIMIT_SHA"],
  "priceHistory": [{"tradeDate": "2024-01-05", "priceRevisions": ["PRICE_SHA"]}],
  "benchmark": {"symbol": "000001.SH", "revisions": ["BENCHMARK_SHA"]},
  "phaseMode": "causal"
}
```

按升序列出实际交易日，并将占位符替换成 64 位十六进制摘要。需要保留跨日的连板和阶段状态时，清单应包含相邻交易日、每日市场截面和覆盖这些日期的涨跌停记录。允许空的价格历史、涨跌停或基准修订列表，回放会报告缺失输入。`phaseMode` 默认是 `causal`，使用 `retrospective-tsp` 时输出会标记用到的后续观测。回放在数据源离线时也可运行。

如需按日剔除风险警示股，用 `whyj --json observation collect-risk-warnings --date 2024-01-05` 采集名单，并把回执摘要加入清单的可选字段 `riskWarningRevisions`，例如 `["RISK_WARNING_SHA"]`。字段省略时使用完整的归档股票池。填入空数组会显式开启筛选，但每个交易日都会标为缺少名单。名单本身为空时，填入该空名单的归档摘要以保留当日计算。

运行 `whyj --json observation replay-market-mainline --manifest mainline.json` 可用归档回放行业或概念主线。将市场截面和涨跌停回执填入清单，并在 `sectorHistory` 逐日填入对应的目录和成分摘要。一份清单使用同一分类维度、数据源和分类体系。可按需加入 `riskWarningRevisions` 和板块成员数筛选。

```json
{
  "sessions": ["2024-01-04", "2024-01-05"],
  "marketRevisions": ["MARKET_PREVIOUS_SHA", "MARKET_SHA"],
  "limitRevisions": ["LIMIT_SHA"],
  "sectorHistory": [
    {"tradeDate": "2024-01-05", "catalogRevision": "CATALOG_SHA", "memberRevisions": ["MEMBERS_SHA"]}
  ],
  "filter": {"minMembers": 4, "maxMembers": 600, "blacklist": []}
}
```

较早的市场截面可为连板提供预热。某日缺少可用的目录、成分或风险名单时，回放会注明缺少的输入及已有引用。部分成分已归档时，结果同时报告实际参与评分的板块和未采集的板块代码。

Runtime 的 `replayTspMarketEmotion` 用升序交易日和固定归档回放最后一个交易日的六维看板情绪。请求沿用连板回放的 `sessions`、`marketRefs`、`limitRefs` 和可选的 `riskWarningRefs`，另传 `priceRefs`、`indexRefs` 与可选的 `sectors.concept`、`sectors.industry`。行业和概念分别指定同日目录及成分归档。

个股涨跌幅用目标日与紧邻前一交易日的前复权收盘计算。五日量比只用目标日之前紧邻的五个交易日市场截面。缺失的归档、个股前收或板块覆盖保留在回执中。目标日市场缺失，或启用了 ST 筛选但没有目标日快照时，回执保留目标日期和缺失原因。`dashboard` 记录 WhyJ 的公式版本、输入值、结果与覆盖范围。

使用 TickFlow 基准时，市场环境和情绪回放都通过同一份归档的目标日及紧邻前一交易日收盘点位计算指数收益。回执的 `derivedReturn` 记录 WhyJ 计算的百分点、两个端点以及可用性。前一交易日未列入清单、归档缺少该日点位或点位分属两个修订时，收益保持为空。Tushare 环境回放继续读取原始涨跌幅，Tushare 情绪回放继续使用同日收盘和昨收点位。

`replayTspMarketRegimeSummary` 复用市场环境回放清单。可加上 `window: {start, end}` 指定闭区间，起止均须属于所给交易日历。阶段算法仍从完整输入序列计算，区间统计只使用窗口内日线。可选的 `concepts` 包含按日引用的概念板块归档及排名筛选规则，复用相同的市场截面、限价和风险警示范围。

逐日回放的 `daily` 增补涨跌分布、成交额和限价统计。涨跌家数来自已观测的复权收益，分布比例以有当日行情的合资格标的为分母，MA20 占比以已知 MA20 为分母。成交总额与单股均额以 Tushare 同日 `daily` 的非空成交额计算，从千元换算为元，零额参与均值。涨停、跌停和炸板各返回已知数量、观测事件数和应覆盖的标的数量。只有覆盖完整且股票池非空时才返回精确事件数。

响应的 `history` 和 `mainline` 保留归档证据，`summary` 提供状态分布、节奏、阶段段落、指标分位和段内主导概念。已观测但没有入榜概念的交易日与缺少归档的交易日分别计数。具体字段见 [市场状态页](../quant-harness/tsp-panel-coverage.md#market-regime-panel)。

```sh
whyj --json observation replay-market-regime-summary --manifest ./regime-summary.json
```

CLI 清单沿用 `replay-market-environment` 的字段，可额外指定 `window` 和 `concepts`。可声明 `version: 1`，已有无版本字段的清单也可读取。其中 `concepts.sectorHistory` 的每项包含 `tradeDate`、`catalogRevision` 和 `memberRevisions`，可附 `concepts.filter`。读取和计算均在本地归档上完成，清单校验由 Runtime 共用。

```sh
whyj --json observation archive-market-regime-manifest --manifest ./regime-summary.json
whyj --json observation replay-market-regime-summary --revision MANIFEST_SHA256
```

显式导入会校验清单并返回 `data.ref.revision`。按修订回放会重新校验清单和底层输入，读取相同内容时与文件路径回放一致。修订号可以引用超过工作台普通请求大小上限的完整清单。

Runtime 可接受 `depth: { ref, asOf, maxAgeMs }`。盘口归档的交易日必须与目标日相同，采集时刻必须早于或等于截止时刻，两项时间参数使用毫秒。回执分别列出已请求、已返回和参与封板判定的股票。盘口只修正符合条件的涨跌停候选，ST 筛选剔除的股票不参与。缺少盘口、空档和过期观测保持可见，原始价格梯队随回执保留。省略盘口归档时，五档盘口修正状态为不可用。

有盘口证据的市场回放同时返回 `depthQueue`。该结果使用同一批涨跌停候选及其未复权收盘价，分别测量涨停买一和跌停卖一排队量。入口可传 `depth.queue.volumeUnit` 指明该归档的已确认单位（`hand` 或 `share`）。`volumeUnitBasis` 会记录该单位由调用方声明，`input.depth.volumeUnit` 仍保留原归档的单位。未知单位只返回原始量。可选 `depth.queue.rule` 使用 `sealed_vol`（手）或 `sealed_amount`（元）及非负 `threshold`，返回该候选是否达到预警阈值。

在 CLI 中用 `whyj --json observation replay-market-emotion --manifest emotion.json` 回放。清单中的摘要取自每条采集回执的 `data.ref.revision`。补齐目标日以前的连续交易日及对应市场截面，才能验证五日量比和连板所需历史。

```json
{
  "sessions": ["2025-01-02", "2025-01-03"],
  "marketRevisions": ["JAN_02_MARKET_SHA", "JAN_03_MARKET_SHA"],
  "limitRevisions": ["LIMIT_SHA"],
  "priceRevisions": ["ADJUSTED_PRICE_SHA"],
  "indexRevisions": ["CORE_INDEX_SHA"],
  "sectors": {"concept": {"catalogRevision": "CATALOG_SHA", "memberRevisions": ["MEMBER_SHA"]}}
}
```

`sectors` 与 `riskWarningRevisions` 可省略。行业目录放在 `sectors.industry`，格式与概念相同。每只核心指数只选一份覆盖目标日的归档。缺少涨跌停、复权日线或指数输入时，可用空数组运行部分回放，JSON 会保留缺失状态。无效清单返回 `invalid_arguments`，不可读取或不匹配的归档返回 `observation_archive_unavailable`。

已有固定盘口归档时，可加入 `"depth": {"revision": "DEPTH_SHA", "asOf": "2025-01-03T15:00:05+08:00", "maxAgeMs": 5000}`。截止时间须带时区，并与目标交易日一致。`maxAgeMs` 是盘口相对截止时间允许的最大年龄。归档基于其原始采集时间绑定到该截止时间，回执保留实际匹配的股票和封板修正依据。

如果已确认该盘口归档以股计量，可在 `depth` 内添加 `"queue": {"volumeUnit": "share", "rule": {"metric": "sealed_amount", "threshold": 25000}}`。结果在 `data.depthQueue` 返回每只候选的手数、人民币金额及阈值结果，原始单位保留在 `data.input.depth.volumeUnit`。省略 `queue` 时，回放仍提供盘口原始排队量。无效单位或阈值返回 `invalid_arguments`。

选定 TickFlow 后，用 `whyj --json observation collect-depth --date YYYY-MM-DD --symbols-file symbols.json` 采集当前上海日期的盘口。`symbols.json` 是形如 `["600000.SH", "000001.SZ"]` 的股票代码数组。将回执中的 `data.ref.revision` 传给市场情绪清单的 `depth.revision`，将采集时刻 `data.observedAt` 作为 `depth.asOf`，并按用途选择 `maxAgeMs`。采集回执会列出缺少的标的。

`collectQuotePollCapture` 使用选定 Source 分批采集指定股票当日的 TickFlow 快照。一轮全部请求成功后才写入单个不可变归档，回执列出缺失标的和时间不符的报价。`replayTspQuotePollDelta` 读取前后两轮的精确归档，要求请求范围一致、采集时间有序且不重叠。回放结果附带两轮归档来源和单位依据。省略上一轮时标记缺少基准，跨连续竞价时段时标记时间边界。已确认的单位可由调用方明确提供。

用 `whyj --json observation collect-quote-poll --date YYYY-MM-DD --symbols-file symbols.json` 采集一轮，保存回执的 `data.ref.revision`。用 `whyj --json observation replay-quote-poll-delta --manifest polls.json` 离线比较指定的两轮。清单包含 `"version": 1`、`currentRevision` 和可选的 `previousRevision`。已确认单位时可添加 `volumeUnit`（`share` 或 `hand`）和 `amountUnit`（`CNY` 或 `CNY-thousand`）。可选的 `rule` 包含 `metric`（`volume` 或 `amount`）和大于等于 1 的 `threshold`，分别用手和人民币元比较。输出保留原始增量和换算结果。参数无效返回 `invalid_arguments`，归档缺失或两轮范围不匹配返回 `observation_archive_unavailable`。

Runtime 的 `collectTspQuoteMonitorAlerts` 使用同一采集入口取得一轮当日股票快照，以该轮采集结束时间评估规则。调用方提供固定 `roster`、`maxAgeMs`、规则版本及可选的前序快照引用 `priorCaptureRefs`。前序快照用于重建本轮判断所需的冷却状态，返回的 `evaluation` 仅包含本轮判断。`replayTspQuoteMonitorAlerts` 接受相同规则和口径，用 `captureRefs` 离线重算全部指定时间点。各轮的请求标的必须一致，且采集时段按时间顺序排列并保持不重叠。

支持最新价 `price` 或 `close`、昨收 `prev_close`、涨跌额 `change_amount`、涨跌比例 `change_pct`、累计量 `volume` 和累计额 `amount`。只有独立确认价格为未复权人民币行情时，才提供 `priceBasis: "caller-confirmed-unadjusted-CNY"`。已确认的量额口径由 `volumeUnit` 和 `amountUnit` 声明，条件用手和人民币元比较。未确认口径、不可用的零价格、未返回或超过时效的报价不会触发相应数值条件。归档仍保留原始数值及其未知单位标记，判断结果保留实际报价时间、收包时间和可复现事件 ID。[快照告警](https://github.com/yangjingo/WhyJ-Quant/issues/679)

用下列命令采集一轮或离线回放。两个清单均包含 `version: 1`、`roster`、`maxAgeMs` 和 `rule`，规则结构与日线告警相同。条件可比较上述快照字段，并填写匹配的数值单位。按已确认的口径填写 `priceBasis`、`volumeUnit` 或 `amountUnit`。

```powershell
whyj --json observation collect-quote-monitor-alerts --manifest ./quote-alert-collect.json
whyj --json observation replay-quote-monitor-alerts --manifest ./quote-alert-replay.json
```

采集清单填上海当天的 `tradeDate`，可选的 `priorCaptureRevisions` 按时间顺序提供前序归档。采集返回新归档的 `data.capture.ref.revision`。离线清单用 `captureRevisions` 按顺序放入前序版本和本轮版本，沿用同一规则及口径设置。离线回放无需访问供应商。清单无效返回 `invalid_arguments`，采集失败返回 `observation_collection_failed`，回放归档不可用返回 `observation_archive_unavailable`。[CLI 接入](https://github.com/yangjingo/WhyJ-Quant/issues/681)

`replayTspSectorMonitor` 固定同一天的板块目录、成分归档和按采集时间排序的股票快照重算板块分钟变化。板块涨跌幅取可用成员的 `lastPrice / previousClose - 1` 平均值，覆盖率分母取完整归档成分。允许快照未返回部分成分。请求范围与板块成分的交集在各轮保持一致。窗口按快照收包时间比较，原始报价时段和成分采集时点随证据返回，成分在历史具体时点的可得性仍未知。指数分支复用已结束交易日的同源分钟归档和前一交易日收盘价，时间轴保留供应商原始时间戳标签。

用 `whyj --json observation replay-sector-monitor --manifest monitor.json` 回放。两种清单均包含 `"version": 1`。行业或概念用 `"kind": "sector"`，填写 `catalogRevision`、`memberRevision` 和按时间排序的 `quoteRevisions`。指数用 `"kind": "index"` 与 `minuteRevision`，可选 `name` 和 `previousClose`。后者包含 `dailyRevision` 及 `calendar`（`revision`、`previousTradeDate`、`tradeDate`）。两种清单均可选 `rule`，包含 `trigger`（`change_pct` 或 `momentum`）、`direction`（`up` 或 `down`）、小数比例 `thresholdFraction` 和毫秒 `cooldownMs`。分钟异动还需给出 `windowMinutes`（1、3、5、10 或 15）。清单无效返回 `invalid_arguments`，引用的归档缺失或不匹配返回 `observation_archive_unavailable`。

Runtime 的 `deriveTspArchiveAnalytics` 用精确的 v2 日线引用生成归档末日的 77 个研究因子字段和 11 组图表价格位。Tushare 的手数和千元成交额按明确单位参与计算，TickFlow 成交单位未确认时，对应因子保持空值。估值财务、历史换手和连板输入需独立归档。结果标记价格位的量分布口径、原行情来源、归档范围、可用成交额计数及两个计算的公式版本。读取只使用指定归档。

可选认证 RPC `readObservationAnalytics` 接收一份 v2 日线引用，返回归档末日的研究因子及价格位。调用方可读取各组的公式版本与同一份行情证据。归档缺失或损坏时返回固定诊断，旧 Host 对此可选方法返回 `METHOD_NOT_FOUND`。

可选的 `turnoverArchives` 指定市场截面归档。Runtime 按日线归档的实际交易日和标的代码读取 Tushare `daily_basic` 换手率（百分点），供换手因子、滚动量化和价格位的量分布衰减使用。返回值逐日保留来源、采集时间、归档引用和缺失状态，零换手仍为零。重复日期或超出日线实际日期的引用会失败。历史采集时间无法确认当日的可得时间，覆盖仍为未知。

可选的 `financialArchives` 只补充日线归档末日已经可用的财务版本。返回值保留报告期、实际披露日、两类精确引用及采集时间，并带回供应商原始数值和单位。六项财务指标使用 Tushare 的 ROE、销售毛利率、销售净利率、营业收入同比、归母净利润同比和资产负债率。默认保留 PB 为空。调用方有独立币种证据时，可用 `bookValueBasis` 声明特定报告期和精确财务归档版本的每股净资产与未复权收盘价同为人民币。只有声明与实际选中的财报匹配且每股净资产为正，才计算 PB。 [Tushare 财务指标字段](https://tushare.pro/document/2?doc_id=79)

CLI 可用当前已保存的数据源凭证采集和回放同一份归档。配置来源后，用 `whyj --json doctor --phase data` 检查凭证是否可用，再运行以下命令。用第一条返回的 `data.ref.revision` 替换第二条的 `SHA256`。

```powershell
whyj --json observation collect-daily --symbol 600000.SH --start 2026-01-05 --end 2026-04-30
whyj --json observation replay-daily --revision SHA256
```

采集默认请求未复权日线。`--adjustment forward` 适用于支持该口径的选定来源。空采集返回 `status: "empty"` 和空引用。回放可离线进行，返回 37 个日线字段、日线信号和对应公式版本，保留输入的供应商、复权口径和归档引用。

Runtime 的 `replayTspDailyMonitorAlerts` 从精确的 A 股日线归档重建盘后告警。请求提供规则版本、固定股票范围、上海交易日与同日盘后评估时间、复权口径及每只股票的归档引用。可选的同标的未复权行情和涨跌停价归档用于内置交易所信号。规则可读取 37 项日线字段、20 个内置信号及当日 OHLCV 和成交额。涨跌幅使用比例，价格使用人民币，成交量使用已确认的手数，成交额使用元。单位未知的绝对量保持为空。

响应列出缺失的标的交易日、实际命中的条件和操作数、冷却期内被抑制的次数、规则与行情证据版本。事件 ID 由规则、回放时点和归档证据计算。回放窗口从空冷却状态开始，调用方应带上需要影响后续判断的前序交易日。结果是 `historical-reconstruction`，归档采集时点随结果返回。实际推送和告警历史另行接入。[日线告警回放](https://github.com/yangjingo/WhyJ-Quant/issues/673)

用 `whyj --json observation replay-daily-monitor-alerts --manifest ./daily-alert.json` 离线回放。下面的 `evaluatedAt` 是上海时间 2026-03-11 15:10 对应的 Unix 毫秒数。把 `DAILY_SHA256` 换成 `collect-daily` 返回的归档版本。

```json
{
  "version": 1,
  "adjustment": "none",
  "sessions": [{ "tradeDate": "2026-03-11", "evaluatedAt": 1773213000000 }],
  "roster": ["600000.SH"],
  "histories": [{ "symbol": "600000.SH", "dailyRevision": "DAILY_SHA256" }],
  "rule": {
    "id": "close_threshold",
    "revision": "close-threshold-v1",
    "assetType": "stock",
    "type": "price",
    "scope": { "kind": "all" },
    "logic": "and",
    "cooldownMs": 86400000,
    "severity": "info",
    "conditions": [{ "field": "close", "op": ">=", "value": 10, "unit": "CNY" }]
  }
}
```

`scope.kind` 也接受 `symbols` 和 `watchlist_group`，两者都填写 `symbols`，自选分组还需填写固定的 `membershipRevision`。内置信号条件使用 `op: "truth"`，数值条件填写 `unit`。使用交易所信号时，给相应历史添加 `limitsRevision`。技术字段使用前复权日线时，再提供同标的未复权 `rawRevision` 供该信号使用。清单本身无效返回 `invalid_arguments`，引用缺失、损坏或不匹配返回 `observation_archive_unavailable`。

历史分时通过配置的 Tushare `stk_mins` 采集。一次请求一个 A 股标的，日期窗口至多 31 天并且早于上海当天。采集完成后，用第一条返回的 `data.ref.revision` 离线回放。

```powershell
whyj --json observation collect-minutes --symbol 600000.SH --start 2026-01-05 --end 2026-01-09
whyj --json observation replay-intraday --revision SHA256
```

回放含 11 项指标、4 项穿越信号、原始时间标签和单列开盘边界。已有同一标的的涨跌停价归档时，可同时传入 `--previous-close-revision SHA256 --price-basis caller-confirmed-same-basis`，使用其中同日的昨收证据。只有确认两份归档价格口径相容时才声明该选项。

Runtime 的 `replayTspIntradayMonitorAlerts` 接受固定规则、A 股标的范围、分钟归档引用和按时间排序的 `slots`。每个时段用 `{ tradeDate, minute }` 指定上海交易分钟的起点。例如 `09:30` 使用归档中标记为 `09:31:00` 的完整分钟，评估时点是 09:31。开盘边界只随归档证据计数。缺少相应分钟时返回缺失标的，保留已有指标对跨缺口穿越的处理。

监控条件可计算全部 11 项分时指标、4 个内置分时穿越及分钟 OHLCV 和成交额。分钟成交量使用股数，成交额使用元。需要昨收时，沿用绑定同标的归档和价格口径确认的要求。可在 `customSignals` 中传入显式定义，例如 `id` 为 `cross_ten` 的规则用 `csgi_cross_ten` 作为布尔条件，只在自定义规则的触发分钟为真。输出保留规则、公式、输入归档版本和命中操作数。评估按显式时段记录冷却状态，历史重建结果保留归档采集时间与原始分钟标签。 [盘中告警回放](https://github.com/yangjingo/WhyJ-Quant/issues/675)

`collectDatedTickFlowStockMinutes` 按指定个股和上海日期采集并保存 TickFlow 原始分钟记录，空结果也有归档引用。`replayTspTickFlowStockMinutes` 接受同一标的按交易日升序排列的 `refs`。调用方须在 `interpretation` 明确 `timestampLabel`（`minute-start` 或 `minute-end`）和 `priceBasis: "caller-confirmed-unadjusted-CNY"`。经确认的 `volumeUnit` 可填 `share` 或 `hand`，`amountUnit` 可填 `CNY` 或 `CNY-thousand`。未确认的量额保持为空。输出保留原始毫秒时间戳，并列出开盘边界、非整分钟和交易时段外的未参与行。

`replayTspIntradayMonitorAlerts` 的 TickFlow 历史输入使用同一份 `refs` 与 `interpretation`。可提供 `previousClose`，绑定同标的交易所昨收归档及 `caller-confirmed-same-basis`，逐日取精确日期的昨收。缺少该日期的证据时，相应比例和穿越保持为空。分钟指标和告警由 WhyJ 计算，来源与口径随结果返回。[TickFlow 分时接入](https://github.com/yangjingo/WhyJ-Quant/issues/685)

选定 TickFlow 后，可用以下命令采集一个已结束的上海交易日，再离线回放。多天行情可分别采集，按交易日升序将 `data.ref.revision` 放入清单的 `minuteRevisions`。

```powershell
whyj --json observation collect-tickflow-stock-minutes --symbol 600000.SH --date 2026-01-05
whyj --json observation replay-tickflow-stock-minutes --manifest ./tickflow-minute.json
```

```json
{
  "version": 1,
  "minuteRevisions": ["MINUTE_SHA256"],
  "interpretation": {
    "timestampLabel": "minute-end",
    "priceBasis": "caller-confirmed-unadjusted-CNY",
    "volumeUnit": "share",
    "amountUnit": "CNY"
  }
}
```

示例中的标签和单位是调用方声明。只有得到相应证据时才填写；未知量额可省略。需要昨收时可加 `previousClose`，填写 `revision` 和 `priceBasis: "caller-confirmed-same-basis"`。无效清单返回 `invalid_arguments`，采集失败返回 `observation_collection_failed`，不可读或范围不匹配的归档返回 `observation_archive_unavailable`。[CLI 接入](https://github.com/yangjingo/WhyJ-Quant/issues/687)

用 `whyj --json observation replay-intraday-monitor-alerts --manifest ./intraday-alert.json` 回放。Tushare 历史项用 `minuteRevision` 填写 `collect-minutes` 返回的版本。TickFlow 历史项填写 `symbol`、`minuteRevisions`、`interpretation` 及可选的 `previousClose`。自定义信号在 `customSignals` 中声明，并用 `csgi_` 加规则 ID 作为监控条件。

```json
{
  "version": 1,
  "slots": [{ "tradeDate": "2026-01-05", "minute": "09:31" }],
  "roster": ["600000.SH"],
  "histories": [{ "symbol": "600000.SH", "minuteRevision": "MINUTE_SHA256" }],
  "customSignals": [
    { "id": "cross_ten", "conditions": [{ "left": "price", "op": "cross_up", "right": 10 }] }
  ],
  "rule": {
    "id": "price_cross", "revision": "price-cross-v1", "assetType": "stock", "type": "signal",
    "scope": { "kind": "all" }, "logic": "and", "cooldownMs": 60000, "severity": "info",
    "conditions": [{ "field": "csgi_cross_ten", "op": "truth" }]
  }
}
```

使用昨收时，在对应 `histories` 项填写 `previousClose`，包含 `revision` 和 `priceBasis: "caller-confirmed-same-basis"`。`slots` 必须按时间升序且不能重复。无效清单返回 `invalid_arguments`，不可读取或不匹配的归档返回 `observation_archive_unavailable`。

用已配置的 Tushare 采集同一交易日的行业或概念目录，再按板块代码采集所需成分。

```powershell
whyj --json observation collect-sector-catalog --date 2025-01-02 --kind concept
whyj --json observation collect-sector-members --date 2025-01-02 --sector-code BK1184.DC
whyj --json observation replay-sector-rank --market-revision MARKET_SHA --catalog-revision CATALOG_SHA --members-file members.json
```

`MARKET_SHA` 取自同日 `collect-market` 回执，`CATALOG_SHA` 取自目录采集回执，均为 `data.ref.revision`。将每条成分回执的 `data.ref.revision` 保存为 `members.json` 中的 JSON 字符串数组。空数组 `[]` 可查看目录中哪些板块尚未采集。回放使用本地归档，输出 WhyJ 排行、归档修订和板块覆盖范围。

多日轮动使用 `whyj --json observation replay-sector-rotation --manifest sessions.json --days 12`。`sessions.json` 是按交易日归档集合的 JSON 数组，提交顺序不限。每个对象包含 `marketRevision`、`catalogRevision` 和 `memberRevisions`，值来自同一交易日的采集回执。以下占位符替换成对应的 SHA256 修订。

```json
[
  { "marketRevision": "FIRST_MARKET_SHA", "catalogRevision": "FIRST_CATALOG_SHA", "memberRevisions": ["FIRST_MEMBER_SHA"] },
  { "marketRevision": "SECOND_MARKET_SHA", "catalogRevision": "SECOND_CATALOG_SHA", "memberRevisions": ["SECOND_MEMBER_SHA"] }
]
```

默认显示最新 12 个有可比排名的交易日，窗口限制为 7–30 个比较日。发生缺口的日期及其归档仍出现在 `input.sessions` 中。同一板块在上一已提供交易日缺少可比排名时，`rankMovement` 保持 `null`。

### 异动截面回放

`replayTspAbnormalSnapshot` 用固定市场截面和指定股票的日线归档重建七类异动快照。调用方提供交易日历、共同复权口径和所需的当日限价证据。市场截面须匹配日历最后一日。缺少某股当日行情或信号输入时，相关标志计入未知覆盖。

命中按信号优先级、绝对涨跌幅和代码排序，计数先于列表截取。结果分开记录 Tushare 原报收盘、涨跌和换手，与 WHYJ 计算的振幅、量比、连板和信号。历史回放与实时异动时间线的采集口径独立。[异动列表口径](../quant-harness/tsp-list-catalog.md#abnormal-snapshot-ranking)

CLI 读取本地版本 1 清单。

```sh
whyj --json observation replay-abnormal-snapshot --manifest ./abnormal-snapshot.json
```

清单包含 `version: 1`、`marketRevision`、按日期升序排列的 `sessions`、`adjustment` 和 `histories`。历史条目包含 `symbol`、`dailyRevision`，并可指定 `limitsRevision` 和配套的 `rawRevision`。可选 `limit` 控制输出行数。

### 自定义盘中信号回放

`replayTspIntradaySignal` 在固定分钟归档上计算自定义条件。沿用分钟回放的上海时间、收盘标签及可选昨收证据。结果保留供应商原始时间、WHYJ 分钟起始标签、公式版本、归档引用及命中时的特征。事件 ID 由标的、规则与公式修订、交易日和分钟共同决定，同一事件在扩展归档中保持原 ID。

回放为只读，输出已检查的完成分钟数、交易日数和开盘边界数。事件可以供后续监控判断重复。条件、最少分钟数和断档行为见[指标目录](../quant-harness/tsp-list-catalog.md#custom-minute-signal-events)。

CLI 使用本地清单。

```sh
whyj --json observation replay-intraday-signal --manifest ./intraday-signal.json
```

版本 1 清单包含 `version: 1`、`minuteRevision` 和 `rule`。规则例如 `{"id":"vwap_cross","conditions":[{"left":"price","op":"cross_up","right":{"field":"vwap"}}]}`，也可加入 `minBars`。需要昨收时可填写 `previousClose` 对象的 `revision` 和 `priceBasis: "caller-confirmed-same-basis"`。

### 竞价风向标采集和回放

`collectAuctionBenchmark(tradeDate)` 使用扶摇专用凭证读取一个上海交易日，返回采集元数据、行数和不可变归档引用。空名单也会归档。调用失败或提交前取消时不会返回成功引用。

`replayTspAuctionBenchmark` 按调用方提供的日历修订、交易日及相邻交易日，组合风向标归档和最多三份 Tushare 市场截面归档。回放按精确交易日取未复权价格，只匹配已归档名单中的标的。缺少某天归档或该标的行情时，受影响的指标保留为空。结果分别返回扶摇名单观察、价格归档来源及 WhyJ 的三种价格变化和高开标记。回放只访问本地归档，交易日相邻性由调用方所用日历确定。未复权收盘价变化可能包含公司行动影响。

在本地运行环境设置 `WHYJ_QUANT_FUYAO_API_KEY` 后，用以下命令采集和复算。价格归档引用来自同一交易日或相邻交易日的 `collect-market` 回执。

```text
whyj --json observation collect-auction --date 2025-01-03
whyj --json observation replay-auction --manifest auction.json
```

将竞价回执和价格回执的 `data.ref.revision` 写入清单，并填入日历修订及相邻日期。日期已知而对应归档缺失时，从 `marketRevisions` 省略其引用。未知的相邻日期填 `null`。

```json
{
  "auctionRevision": "AUCTION_SHA256",
  "calendar": {
    "revision": "exchange-calendar-revision",
    "tradeDate": "2025-01-03",
    "previousTradeDate": "2025-01-02",
    "nextTradeDate": "2025-01-06"
  },
  "marketRevisions": ["MARKET_SHA256"]
}
```

### 龙虎榜采集和回放

`collectDragonTigerBoard(tradeDate, boardKind)` 读取一个指定交易日的扶摇全部榜、机构榜或游资榜。成功回执包含供应商时间戳、采集时间、两组计数和归档引用。成功的空榜也可保存与读取。

`replayTspDragonTiger({ tradeDate, refs })` 只加载一至三份精确归档，同一榜种只接受一份同日捕获。返回的 `input` 包含供应商记录和归档来源，`metrics` 保存 WhyJ 的四组排名。缺失榜种返回 `null`，空榜保留为空。不同榜种各有采集时间，历史发布时间及覆盖范围仍未知。

在本地运行环境设置 `WHYJ_QUANT_FUYAO_API_KEY` 后，可分别采集全部榜、机构榜和游资榜。将同一交易日的一至三个 `data.ref.revision` 用逗号连接，传入回放命令。回放只访问本地归档。

```text
whyj --json observation collect-dragon-tiger --date 2026-07-01 --board all
whyj --json observation collect-dragon-tiger --date 2026-07-01 --board org
whyj --json observation collect-dragon-tiger --date 2026-07-01 --board hot_money
whyj --json observation replay-dragon-tiger --date 2026-07-01 --revisions ALL_SHA256,ORG_SHA256,HOT_MONEY_SHA256
```

### 沪深个股资金流

`collectDatedMoneyFlow` 通过当前选定的 Tushare 数据源采集上海交易日的沪深个股资金流，返回行数、来源、采集时刻、原始单位和归档引用。成功但没有数据时返回 `empty` 和有效归档引用。`replayDatedMoneyFlow` 按引用离线重开固定版本，保留每股四档的买卖量与金额和供应商独立报告的净流入。覆盖范围和供应商首发时间保持未知。


在 Source 设置中选择 Tushare，并配置具备 `moneyflow` 权限的凭据。采集后将回执中的 `ref.revision` 交给回放命令。回放仅访问本地归档。

```bash
whyj --json observation collect-money-flow --date 2024-09-03
whyj --json observation replay-money-flow --revision MONEY_FLOW_SHA256
```

### A 股历史人气榜

`collectDatedPopularityList` 通过扶摇采集一个北京时间自然日的历史人气榜。回执标记 `archived` 或 `empty`，并保留自然日、上海零点、采集时刻和归档引用。`replayDatedPopularityList` 仅按固定引用读取，原样返回供应商名次和行顺序。上海零点用于标识日期，供应商发布时间和覆盖仍为未知。

在本地运行环境配置 `WHYJ_QUANT_FUYAO_API_KEY`，按供应商支持的一年内自然日采集。回放读取采集回执的 `ref.revision`，只使用本地归档。

```bash
whyj --json observation collect-popularity --date 2026-06-21
whyj --json observation replay-popularity --revision POPULARITY_SHA256
```

### 财务数据的历史时点

`replayFinancialResearchInputs` 读取指定标的的财务指标及实际披露日期精确引用。每个上海交易日只考虑此前已独立采集的两类记录。实际披露日须已发生，财务指标采集日不能早于实际披露日。对同报告期采用交易日前最近的有效采集版本。同一时点存在不同指标行或互相冲突的实际披露日期时，该报告期不可用。新一期满足条件前可以继续使用此前已知的报告期。结果保留具体选用的报告、披露日及两类归档引用和采集时间；缺失与歧义可区分。此接口保留供应商原始单位和未知币种，供研究因子计算使用。

CLI 分别采集报告指标和披露日期。`--start` 与 `--end` 指报告期，两端均包含。用两次采集各自返回的修订替换命令中的 `REPORT_SHA` 和 `DISCLOSURE_SHA`，再传入现有日线归档的 `DAILY_SHA`。

```sh
whyj --json observation collect-financial-indicators --symbol 600000.SH --start 2024-12-31 --end 2024-12-31
whyj --json observation collect-disclosure-dates --symbol 600000.SH --period 2024-12-31
whyj --json observation replay-analytics --revision DAILY_SHA --financial-report-revisions REPORT_SHA --financial-disclosure-revisions DISCLOSURE_SHA
```

`replay-analytics` 可完全离线运行，并返回 77 个研究因子字段与 11 组图表价位。引用列表可用逗号连接，`--turnover-revisions` 接收逐日市场截面归档。仅在掌握币种证据时使用 `--confirm-unadjusted-cny-book-value REPORT_SHA,2024-12-31` 确认特定版本和报告期。未确认的 PB 保持为空，后于回放日期采集的财务指标也保持不可用。

符合时点要求的报告在 `input.financialInput.report` 返回基本 EPS、币种证据及其他原报字段。报告归档来自尚未请求 EPS 的版本时，旧记录没有这两个字段。新归档里的 `null` 表示该次响应没有提供基本 EPS。

### 因子检验归档回放

`replayTspFactorEvaluation` 对固定交易日日历内的股票日线重算选定研究因子。每只股票可传入多个同来源、不重叠的日线归档，股票间使用同一复权口径。`evaluationStart` 之前的日线只用于因子预热。正式区间内的截面因子值、Rank IC、年度统计、衰减、分组净值、换手和理论多空都从同一份输入复算。

换手率按标的和交易日读取固定截面归档。涨停因子使用同日未复权收盘价和交易所有效涨停阈值。财务因子使用信号日前已经采集并披露的报告和独立披露证据，PB 还需要对该归档版本和报告期确认未复权人民币口径。每个缺口保留为空，相邻日期和后续财务修订不会补写更早的信号。回放结果保留输入归档出处，历史价格和交易所数据的原始发布时点及覆盖范围仍未知。

`replayTspFactorSignificance` 接受同一批 `factorIds` 和与单因子回放相同的日历、预热边界及归档引用。Runtime 共用这批归档，为每个因子生成日频单日向前的 Rank IC。显著性沿用 TSP 对四位小数 IC 计算滞后一阶 Newey–West t 值的约定，q 值按这批可检验因子计算。无 IC 的因子仍保留在结果中。输出包含每条 IC 的交易日、收益日和有效样本数，以及整批输入档案的版本。

`replayTspFactorMiningScreen` 使用相同的归档、日历和预热规则，接受候选 `factorIds`、`correlationThreshold` 和 1、3 或 5 个交易日的 `forwardSessions`，默认 5。训练区间从 `evaluationStart` 到 `sessions` 的最后一天。按全市场交易日序列找到目标日，用同一标的的收盘价之比减一计算标签。目标日缺价时标签为空，仍将该行纳入因子覆盖率。目标日越过训练截止日时整行排除，归档内晚于截止日的价格不会进入计算。

因子值和收益标签按 TSP 挖掘面板的 Float32 精度传入计算。回放保留信号日和目标日的对应关系、有效和缺失标签数、排除行数、归档出处及 WhyJ 公式版本。结果包括训练期 Rank IC、IR、覆盖率、换手、相关矩阵及去重结果。 [TSP 目标收益及训练口径](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/backend/app/backtest/mining_runtime.py#L708)

使用 `whyj --json observation replay-factor-evaluation --manifest factor.json`。用各采集回执中的 SHA-256 摘要替换示例占位符。提供完整的交易日序列，`evaluationStart` 可省略，默认从第一天检验。每个标的至少有一份日线归档。换手、财报、披露、涨跌停和分组设置均可按所选因子省略。日线已是不复权时，`exchange.rawRevisions` 可以省略。示例的费用和印花税为比例，滑点为基点。

```json
{
  "factorId": "pb_latest",
  "rebalance": "daily",
  "sessions": ["2026-01-05", "2026-01-06", "2026-01-07"],
  "evaluationStart": "2026-01-06",
  "symbols": [
    {
      "symbol": "600001.SH",
      "dailyRevisions": ["DAILY_SHA256"],
      "financialReportRevisions": ["REPORT_SHA256"],
      "financialDisclosureRevisions": ["DISCLOSURE_SHA256"],
      "bookValueBasis": [
        {
          "reportRevision": "REPORT_SHA256",
          "periodEnd": "2025-09-30",
          "basis": "caller-confirmed-unadjusted-CNY"
        }
      ],
      "exchange": {
        "rawRevisions": ["RAW_DAILY_SHA256"],
        "limitRevisions": ["LIMIT_SHA256"]
      }
    },
    { "symbol": "000001.SZ", "dailyRevisions": ["SECOND_DAILY_SHA256"] }
  ],
  "turnoverRevisions": ["DAILY_`ET_SHA256"],
  "groups": {
    "groupCount": 5,
    "weight": "factor_weight",
    "feesFraction": 0.0002,
    "commissionFraction": 0.0002,
    "stampTaxFraction": 0.0005,
    "slippageBps": 5
  }
}
```

JSON 响应中的 `panel` 是计算使用的正式区间截面，`information` 和 `grouping` 分别提供 Rank IC 和分组结果。财务因子需要足够的同期证据，示例中缺少相应报告的股票保留空值。输入格式错误会返回 `invalid_arguments`。无法重放的因子或归档会返回 `observation_archive_unavailable`。

使用 `whyj --json observation replay-factor-significance --manifest factors.json` 可批量复算因子显著性。沿用示例中的 `sessions`、`evaluationStart`、`symbols` 和 `turnoverRevisions`，将 `factorId` 改为 `factorIds` 数组，增加 `"schemaVersion": 1`，并省略 `rebalance`、`groups` 和 `marketEnvironment`。日频检验、单日向前收益和滞后一阶由报告口径确定。JSON 的 `series` 提供每个因子的 IC，`significance` 提供 t、p、q 值和样本计数，`input` 保留精确归档来源。无效清单返回 `invalid_arguments`，无法重放的归档或因子返回 `observation_archive_unavailable`。

因子检验可以传入固定的市场环境归档。服务以因果模式复算环境，核对正式检验日历和已知的预热前驱，再将前一交易日的状态与分数传给 IC 分层计算。响应保留复算清单、前驱日期以及实际使用的市场状态。缺少内部前驱状态或日期顺序不同会使该次回放失败。

使用 `whyj --json observation replay-factor-mining-screen --manifest mining.json` 回放训练期因子筛选。沿用显著性清单的 `schemaVersion`、`factorIds`、`sessions`、`evaluationStart`、`symbols` 和可选的 `turnoverRevisions`。最多 48 个因子。额外提供 `correlationThreshold`，取值大于 0 且不超过 1，以及可选的 `forwardSessions`，取值为 1、3 或 5，默认 5。JSON 返回 `input` 归档来源、`targets` 标签对齐及覆盖数和 `screen` 筛选结果。无效清单返回 `invalid_arguments`，缺档、未知因子或没有训练区间内的目标日样本返回 `observation_archive_unavailable`。

`whyj --json observation replay-mining-candidate --manifest candidate.json` 汇总候选的固定样本外折次。清单包含 `schemaVersion: 1`、`candidateId`、`profile`（`exploratory`、`balanced` 或 `strict`）和 `folds`。每折提交 `window`（`index`、`trainStart`、`trainEnd`、`testStart`、`testEnd`）、`testSessionCount`、`evaluationKind`（`selected`、`cross` 或 `benchmark`）和 `outcome`。

有效折使用 `outcome.status: "valid"`，并在 `outcome.metrics` 写入 `totalReturnFraction`、`sharpe`、`maxDrawdownFraction` 和 `tradeCount`。缺测字段填写 `null`，观察到的零填写 `0`。跳过折使用 `outcome.status: "skipped"` 并填写 `outcome.reason`。返回各折、汇总结果、指标覆盖折数和 WhyJ 公式版本。训练和测试日期重叠、重复折号及无效字段返回 `invalid_arguments`。 [样本外指标定义](../quant-harness/tsp-panel-coverage.md#mining-candidate-out-of-sample-report)

返回的 `gate` 给出候选指标是否达标、原因码、规则版本和阈值。严格档按 TSP 发布检查纳入最差折 Sharpe。复算仍使用同一份样本外清单。

### 策略健康度复验

`whyj --json observation plan-strategy-guardian --manifest plan.json` 接受 `schemaVersion: 1`、基线数据截止日 `dataAsOf` 和严格升序的交易日 `sessions`。可在 `thresholds` 覆盖 `minNewTradingDays`、`maxSegments`、`watchFraction`、`retireFraction` 或 `maxSoftDrawdownFraction`。规划默认要求基线后至少有 30 个交易日，选择最多 4 个分段，每段至少 14 个自然日。结果返回分段起止日期，或数据量不足的具体原因。

`whyj --json observation replay-strategy-guardian --manifest check.json` 沿用规划字段，并接受 `strategyId`、`objective`（例如 `sharpe`）、`baselineScore`、`baselineTradeCount` 和 `segments`。每段按规划顺序提交 `start`、`end`、目标得分 `objective`、`tradeCount` 和有符号的回撤比例 `maxDrawdownFraction`。缺测填 `null`。规划跳过时提交空数组。

复验返回基线、当前分段稳健得分、相对退化比例、交易数、最差回撤及原因码。结果状态为 `healthy`、`watch`、`retired`、`skipped` 或 `unavailable`。这两条命令只读取本地清单。格式、阈值或分段不符时返回 `invalid_arguments`。 [策略健康度指标定义](../quant-harness/tsp-panel-coverage.md#strategy-guardian)

`whyj --json observation replay-strategy-guardian-history --manifest history.json` 读取一个策略的固定检查历史。清单使用 `schemaVersion: 1`、`strategyId` 和按归档追加顺序排列的 `checks: [{ verdict?, error? }]`。无判定时省略 `verdict` 或填 `null`。响应给出 WhyJ 公式版本、检查总数、尾部连续无错误观察次数和达到两次时的告警。命令只读取本地清单，格式错误返回 `invalid_arguments`。

`whyj --json observation replay-strategy-monitor-alerts --manifest strategy-results.json` 从固定策略结果回放买卖信号和股票池、ETF 池变动。清单使用 `schemaVersion: 1`、`rule` 和按时间升序排列的 `captures`。规则填写 `id`、`revision`、`strategyId`、`strategyRevision`、`assetType`（`stock` 或 `etf`）、`eventTypes` 和毫秒 `cooldownMs`，也可以填写包含边界值的 `scoreMin` 与 `scoreMax`。事件类型可选 `buy_signal`、`sell_signal`、`pool_entry` 和 `pool_exit`。

每条采样填写 `revision`、Unix 毫秒 `evaluatedAt`、对应上海日期 `tradeDate` 和 `status`。`completed` 还需要 `rows: [{ symbol, score }]`、`buySignals: [{ symbol, signals }]` 和 `sellSignals: [{ symbol, signals }]`，没有结果时传空数组，缺失分数用 `null`。`unavailable` 只填写身份和日期字段，沿用上一轮已完成状态。首个 `completed` 在输出中标为 `baseline`。输出保留每轮的结果、规则与策略版本、告警类型和批次成员。输入不符时返回 `invalid_arguments`。 [策略告警计算](../quant-harness/tsp-dashboard-audit.md#alert-inputs-and-delivery)

在因子检验清单中增加可选的 `marketEnvironment` 对象，即可启用前一交易日的市场状态分层。对象沿用 `replay-market-environment` 的 `sessions`、`marketRevisions`、`limitRevisions`、`priceHistory` 和 `benchmark` 格式，也可以提供 `riskWarningRevisions`。其日历须连续包含正式的因子检验区间和已知前驱。`phaseMode` 可省略或填 `causal`。`data.information.marketRegime` 返回分层统计及每个使用日期的前驱、状态和分数。

### 回测交易稳健性

使用 `whyj --json observation backtest-robustness --manifest trades.json` 计算已实现交易的稳健性。输入收益都是小数比例，持仓天数为非负整数，未知可填 `null`。可选的 `periodicReturns` 只替换 Sortino 的样本，并省略初始权益快照。默认 `periodsPerYear` 为 252，`includeMonteCarlo` 为 `true`。自助重抽样仅用清单里的已实现交易，不读取行情或连接数据提供商。

使用 `whyj --json observation replay-backtest-portfolio --manifest portfolio.json` 从固定组合证据重放 [TSP 组合绩效](../quant-harness/alpha-backtest.md#固定证据的-tsp-组合绩效)。清单的 `schemaVersion` 为 `1`，包括 `initialCapital`、按日期递增的 `equityCurve` 和 `trades`。净值行包含 `date`、`equity` 和小数比例 `exposureFraction`。交易行包含 `pnlFraction` 和 `holdingDays`。将 `includeMonteCarlo` 设为 `false` 可跳过重抽样。JSON 中的 `portfolio` 和 `realizedTrades` 分别报告组合净值与已实现交易的统计。空净值曲线返回 `status: "unavailable"`，无效清单返回 `invalid_arguments`。命令只读取本地清单。

`whyj --json observation replay-paper-ledger --manifest ledger.json` 从固定成交台账还原模拟账户的现金与持仓。清单包含 `schemaVersion: 1`、`accountId`、`currency`、`initialCash`、`asOf` 和按日期、台账顺序排列的 `entries`。成交项提供 `kind: "fill"`、`entryId`、`tradeDate`、`symbol`、`assetType`（`stock` 或 `etf`）、`currency`、`side`、`quantity`、`price`、`fee`。公司行动项提供 `kind: "corp_action"`、`entryId`、`tradeDate`、`symbol`、`factor`。将输出的 `cash`、`initialCash`、`positions` 原样用于同日的 `replay-paper-valuation`。`lots` 保留各批持仓的取得日期，`availableQuantity` 为较早批次的可卖整股数。

使用 `whyj --json observation replay-paper-statistics --manifest account.json` 复算模拟账户统计。清单包含 `schemaVersion: 1`、`accountId`、三字母大写 `currency`、按台账顺序排列的 `fills` 和按日期递增的 `finalizedNav`。成交行包含 `fillId`、`tradeDate`、`symbol`、`side`（`buy` 或 `sell`）、整数股数 `quantity`、成交单价 `price`、手续费 `fee` 和 `currency`。净值行包含 `tradeDate`、`nav` 和同一 `currency`。

输出的 `roundTrips` 保留买卖成交 ID 和每次配对股数，`summary` 提供已实现盈亏、胜率、盈亏比、持有天数、定版净值回撤和覆盖计数。无有效正净值时回撤为空。缺少可匹配的买入成交、币种不一致或顺序无效时返回 `invalid_arguments`。该命令以本地清单为输入。 [模拟账户指标定义](../quant-harness/tsp-panel-coverage.md#simulated-account-round-trip-and-nav-statistics)

`replayTspPaperValuation` 从固定归档取得模拟账户估值价格。调用方确认 `priceBasisConfirmation: "caller-confirmed-unadjusted-CNY"`。定版估值逐只读取指定股票日线归档，只使用同日未复权收盘价。盘中估算读取一份同日 TickFlow 快照归档，只使用该次轮询的最新价。调用方提供账户现金、持仓成本、持仓数量及可卖数量，也可附带已定版净值序列。

归档回执保留来源、接口、版本、接收时间和所用报价的源时间。日期匹配但未返回价格或价格为零时，相应持仓按成本估值。回执区分请求后缺价和未提供归档。定版估值可另传 `etfDailyRefs`，以同日未复权 ETF 收盘价标记对应持仓。盘中估值使用普通股票的 `quoteRef` 或覆盖股票及 ETF 的 `valuationQuoteRef`。该回放只读指定归档。

`collectValuationQuotePollCapture` 从显式选择的 TickFlow 采集一轮估值行情，接受普通 A 股和沪深 ETF 的交易代码。它按接口上限拆批，保留逐笔供应商时间和接收时间，全部批次完成后保存一个 `valuation-quote-poll` 归档。回放使用该轮采集的报价，并标记请求外或缺价的持仓。

`collectDatedEtfDailyBars` 在显式选择的供应商上读取单只 ETF 的指定交易日区间并保存固定归档。回执包含原始单位、日期、接口、实际来源、SHA-256 版本和行数。空窗口仍生成可回放的空归档。

使用 `whyj --json observation replay-paper-valuation --manifest valuation.json`。清单包含 `schemaVersion: 1`、`accountId`、`tradeDate`、`currency: "CNY"`、`cash`、`initialCash` 及上述 `priceBasisConfirmation`。每笔 `positions` 提供 `symbol`、`assetType`（`stock` 或 `etf`）、`currency`、`quantity`、`averageCost` 和 `availableQuantity`。可选的 `finalizedNav` 沿用模拟账户统计的格式。

`basis: "finalized"` 使用 `dailyRevisions` 数组，可另传 `etfDailyRevisions` 数组。只有 ETF 持仓时可将 `dailyRevisions` 设为空数组。`basis: "snapshot"` 必须在股票专用的 `quoteRevision` 与支持股票和 ETF 的 `valuationQuoteRevision` 中选一项。各版本字段均使用采集回执中的 SHA-256。格式或版本号错误返回 `invalid_arguments`，无法复算的归档或账户输入返回 `observation_archive_unavailable`。

使用 `whyj --json observation collect-valuation-quotes --date YYYY-MM-DD --symbols-file symbols.json`，为 JSON 数组中的股票和 ETF 采集一轮当日估值行情。将回执的 `data.ref.revision` 填入 `valuationQuoteRevision`，即可离线复算。报价缺失或价格为零的持仓使用成本估值，结果保留报价源时间和接收时间。

`replayTspPaperComparison` 使用同一交易日、CNY 和估值价格口径复算多个模拟账户。每个账户提供持仓、资金、成交与定版净值，并绑定独立的 `dailyRefs`、可选的 `etfDailyRefs` 和活跃账户可选的 `snapshotRef`。快照可引用股票归档或混合估值归档。返回的每个账户保留采用的收盘价证据和快照时间，同时输出定版净值归一化序列。引用不可用或与给定范围冲突时，整份比较失败。

使用 `whyj --json observation replay-paper-comparison --manifest comparison.json`。顶层提供 `schemaVersion: 1`、`tradeDate`、`currency: "CNY"`、`priceBasisConfirmation: "caller-confirmed-unadjusted-CNY"` 和 `accounts`。每个账户提供 `accountId`、`status`（`active` 或 `frozen`）、`cash`、`initialCash`、`positions`、`fills`、`finalizedNav` 和 `dailyRevisions`，可另传 `name` 与 `etfDailyRevisions`。账户内的资金、持仓、成交与净值沿用单账户回放格式。活跃账户可选一项 `quoteRevision` 或 `valuationQuoteRevision`。没有日线、成交或净值记录时，对应的必填数组可为空。

使用 `whyj --json observation collect-etf-daily --symbol 510330.SH --start 2025-06-17 --end 2025-06-18`，从显式选择的供应商采集未复权 ETF 日线。将回执的 `ref.revision` 放入收盘估值清单的 `etfDailyRevisions`，回放时读取估值日对应的收盘价。价格缺失会在回执中保留并使用成本估值。 [ETF 日线来源及归档](../quant-harness/source-data-providers.md)

```json
{
  "trades": [
    {"pnlFraction": 0.05, "holdingDays": 3},
    {"pnlFraction": -0.03, "holdingDays": 2},
    {"pnlFraction": 0.08, "holdingDays": null}
  ],
  "periodicReturns": [0.02, -0.01, 0.03],
  "periodsPerYear": 252,
  "includeMonteCarlo": true
}
```

响应包含 Sortino 样本口径、单笔最好与最差收益、中位收益及平均持仓天数。模拟 P50 和 P95 是带符号的回撤比例。少于三笔时两项分位为空，关闭模拟时省略该结果。

### 滚动样本外验证

用 `whyj --json observation replay-walk-forward --manifest folds.json` 重算已完成的训练与测试窗口。`trainDays`、`testDays` 和 `stepDays` 以日历日为单位，起止日期为闭区间。`minHeldOutTrades` 默认 10，设为 0 可关闭门槛。命令最多输出 7,000 个窗口。

```json
{
  "start": "2024-01-01",
  "end": "2024-05-01",
  "trainDays": 90,
  "testDays": 30,
  "stepDays": 30,
  "objective": "sortino",
  "direction": "max",
  "folds": [
    {
      "window": {
        "index": 0,
        "trainStart": "2024-01-01",
        "trainEnd": "2024-03-31",
        "testStart": "2024-04-01",
        "testEnd": "2024-05-01"
      },
      "training": {
        "candidateId": "candidate-a",
        "objective": 2
      },
      "heldOut": {
        "candidateId": "candidate-a",
        "objective": 1.5,
        "totalReturn": 0.1,
        "tradeCount": 12
      }
    }
  ]
}
```

`training` 或 `heldOut` 缺失时填 `null`，未知目标值也填 `null`。输出包含跳过原因、目标均值、退化、复利收益和各测试窗口结束时的权益。重叠测试窗口会标记在 `overlappingTestWindows`，它们的复利可能重复计入相同交易日。输入由用户显式提供，命令只做本地回放。计算规则见 [TSP 指标目录](../quant-harness/tsp-list-catalog.md#walk-forward-evaluation)。
### 参数稳健性

用 `whyj --json observation replay-parameter-robustness --manifest candidates.json` 比较固定参数在多个独立日历区间的表现。下例使用 2 个各 14 天的区间。每组候选参数提供按日期排序的 `segments`，`objective` 为原始目标值。默认使用 `max` 方向并要求累计 30 笔交易。

```json
{
  "start": "2024-01-01",
  "end": "2024-01-28",
  "segmentCount": 2,
  "objective": "sortino",
  "candidates": [
    {
      "params": {"period": 20},
      "segments": [
        {"start": "2024-01-01", "end": "2024-01-14", "objective": 1.4, "tradeCount": 18},
        {"start": "2024-01-15", "end": "2024-01-28", "objective": 1.2, "tradeCount": 15}
      ]
    }
  ]
}
```

无法得到目标值时填 `null`。失败的候选可设 `failed: true`，并保留失败前已完成的区间。可选 `fullWindow` 使用同样的观测字段，日期须覆盖完整请求区间。输出包括各段原值、排名、冠军收敛与网格邻域诊断。命令对调用方提供的证据做本地计算。详见 [TSP 指标目录](../quant-harness/tsp-list-catalog.md#parameter-robustness)。

### 指数分钟行情回放

`collectDatedIndexMinutes` 使用当前 Source 捕获指定指数和历史上海日期，返回固定归档引用。空响应也有可回放的引用。`replayDatedIndexMinutes` 按引用读取原始分钟和 WhyJ 派生指标。若提供昨收输入，还须提供日线归档及调用方确认的相邻交易日对与日历版本。仅使用同 TickFlow 指数在该上一交易日的收盘点位。查询范围内缺少该观察时，分时涨跌为空。本地回放无需供应商访问。时间戳和量额单位保留供应商标记。 [指标口径](../quant-harness/tsp-dashboard-audit.md#index-minute-chart-returns)

用 `whyj --json observation collect-index-minutes --symbol 000001.SH --date 2024-04-08` 获取指定日期的分钟引用。执行 `whyj --json observation replay-index-minutes --revision MINUTE_SHA256` 离线读回原始证据。若需昨收涨跌，再加 `--daily-revision DAILY_SHA256 --previous-date 2024-04-03 --date 2024-04-08 --calendar-revision CALENDAR_ID`。日线引用可用同一 TickFlow 指数的 `collect-benchmark` 取得。返回的 `input` 记录供应商观察和日期，`metrics` 记录 WhyJ 计算及公式版本。

`previewCurrentIndexMinutes` 明确读取当前上海日期的指数分时，返回供应商原始分钟、请求窗口与采集时间，标记为 `provisional`。`before-window` 表示窗口尚未开始，`empty` 表示供应商返回空帧。可选昨收引用沿用历史回放的日期和来源匹配规则。WHYJ 涨跌幅另列，缺少昨收时为 `null`。临时读数无需写入分钟归档。

执行 `whyj --json observation read-current-index-minutes --symbol 000001.SH --date YYYY-MM-DD` 按上海当前日期读取临时分时。需要涨跌幅时，同时提供 `--daily-revision`、`--previous-date` 和 `--calendar-revision`。参数无效返回 `invalid_arguments`，供应商请求或归档证据读取失败返回 `observation_collection_failed`。

### 指数日线指标回放

`collectDatedIndexDailyBars` 捕获固定上海日期窗口的原始指数日线，空响应也返回归档引用。`replayDatedIndexDailyBars` 根据该引用输出原始数据和 WhyJ 派生的 15 个指标字段，覆盖 MA、MACD、RSI、KDJ 和布林带。可选显示范围必须在归档查询范围内，归档里早于显示起点的观测参与预热，晚于显示终点的观测不进入计算。返回实际计算首末日期和参与条数，短历史按公式返回空值。不会基于查询范围推断交易日数据齐全。 [指标与来源映射](../quant-harness/tsp-panel-coverage.md#index-panel)

通过 `whyj --json observation collect-index-daily --symbol 000001.SH --start 2024-02-23 --end 2024-03-01` 捕获包含预热历史的窗口。执行 `whyj --json observation replay-index-daily --revision DAILY_SHA256` 离线读回原始数据和指标。若只看其中一段，可同时传入 `--start` 和 `--end`。两者只控制显示范围，响应中的 `calculationWindow` 列出实际参与计算的观测范围。

`readDatedIndexDailyWithQuote` 接受同一归档引用和显式上海交易日历（修订号、目标日与前一交易日）。查询当前上海日期时，为该指数读取一次 TickFlow 快照。报价和观测时间均须位于目标日期，且报价时间不能晚于观测时间。结果保留原始报价和标记为 `provisional` 的日 K。报价开高低为零时采用最新价作为临时图表值，记录替代字段。历史查询保持离线。

历史中的当日行不参与临时指标计算。前一交易日与实际预热末日相符时，WHYJ 使用相同价格公式计算 MA、MACD、RSI、KDJ、布林带和 ATR。盘中成交量与历史成交量的口径尚未确认，量比保留为空。固定归档、原始报价和临时计算各自带有来源或公式证据。

CLI 用 `whyj --json observation read-index-daily-quote --revision DAILY_SHA256 --date YYYY-MM-DD --previous-date YYYY-MM-DD --calendar-revision ID` 读取该结果。可用 `--start` 和 `--end` 控制固定归档的显示窗口。返回 `fixed`、`calendar` 和 `provisional`。日历或参数格式无效时返回 `invalid_arguments`，归档无法读取或显示窗口越界时返回 `observation_archive_unavailable`。报价不可用时仍返回固定图表结果。

### 从归档重建日线选股候选

`replayTspScreener` 读取固定市场截面和调用方指定的股票日线修订。每个标的须属于当日股票池，同一次回放使用共同的前复权或未复权口径。归档晚于截面日期会报错，缺当日行情则显示不可判定。日线和交易所限价信号沿用同一固定归档回放逻辑。

调用方可指定内置日线信号的任一或全部匹配条件。回放保留每只股票的实际信号、归档和命中状态，再把命中集合交给横截面评分。评分可使用 WHYJ 日线指标、WHYJ 流通市值及截面的未复权收盘、成交额、换手率、PE TTM 和 PB。返回的字段来源、公式和候选修订用于复核。调用方指定的股票范围与归档股票池规模分别记录。

CLI 读取本地版本 1 清单并执行相同的归档回放。

```sh
whyj --json observation replay-screener-archives --manifest ./screener-archives.json
```

清单包含 `version: 1`、`marketRevision`、`adjustment`、`strategy` 的 `id` 和 `revision`、`weights` 和 `histories`。每条历史包含 `symbol`、`dailyRevision`，可选 `limitsRevision` 和配套 `rawRevision`。可选的 `signalGate` 接收 `mode` 和内置信号 ID 数组 `signals`，设定入选条件。排序与上限的配置和评分回放一致。

`replayTspScreenerUnion` 接收同一市场截面、复权口径及股票历史归档，以及有序且策略 ID 唯一的 `strategies`。每项独立设定信号条件、权重和策略结果排序，并保留完整回放凭据。汇总使用各策略完整命中结果。每只股票占一行，首个命中策略提供 `score` 和 `scoreStrategyId`，`hits` 保留每个策略的原分数。展示按评分降序，缺分置后，同分保留首次出现顺序。调用方应按可复现的顺序传入策略。 [TSP 参考实现](https://github.com/shy3130/tick-stock-panel/blob/f9cb383c5918c6a88a412f3ce43d59fe81b94ccc/frontend/src/pages/Screener.tsx#L530)

```sh
whyj --json observation replay-screener-union --manifest ./screener-union.json
```

汇总清单在顶层提供 `version: 1`、`marketRevision`、`adjustment`、`histories` 和有序的 `strategies`。每项策略含 `strategy` 的 `id` 和 `revision`、`weights`，可选 `signalGate`、`orderBy` 和 `descending`。命令离线输入固定归档，返回汇总行和各策略的完整回放。

### 选股候选评分回放

```sh
whyj --json observation replay-screener-score --manifest ./screener-score.json
```

清单外层是 `{ "version": 1, "input": { ... } }`。输入包含 `tradeDate`、`candidateRevision`、`strategy` 的 `id` 和 `revision`、有序的 `candidateSymbols`、每列为 `{field, values}` 的 `columns`，以及每项为 `{field, weight, direction?}` 的 `weights`。每个值数组和候选代码对齐，可用 `null` 记录缺值。两个修订号是调用方提供的 SHA256 标识。可选的 `orderBy`、`descending` 和 `displayLimit` 控制排序及展示上限。

命令离线计算，返回市场日期、WHYJ 公式版本、参与评分的字段覆盖与排名结果。候选集合及因子值由上游生成，策略执行和信号判定的证据随上游提供。评分与缺值口径见[指标目录](../quant-harness/tsp-list-catalog.md#screener-strategy-scores)。

### 自选与选股的历史列表行

`replayTspListRows` 在固定 A 股市场截面上按请求顺序组装股票行。调用方提供 `marketRef`、日线指标的 `adjustment` 和有序的 `stocks`。每项包含 `symbol`，也可附上 `history.ref` 及交易所限价信号所需的 `history.exchange`。

选股列表可附上 `screener: { histories, strategies }`，沿用[多策略回放](#从归档重建日线选股候选)的历史范围和策略顺序。评分以 `histories` 中的候选为准，与 `stocks` 的展示顺序和数量无关。`metrics.screener` 返回完整汇总中的排名、首个命中策略提供的分数和全部命中策略。每项评估区分命中、明确未命中、证据不足或不在评估范围。列表级 `screener` 附带策略、候选和公式修订以及评分字段的来源。行情观察和报价保留各自的数据口径。

列表也可提供以该交易日结束的 `deviationCalendar: { revision, sessions }`，再给有需要的股票项附上 `deviation: { stockRef, benchmarkRef? }`。偏离计算使用该股票的前复权历史和对应板块的指数点位。行内 `metrics.deviation` 保留 3、10、30 个交易日偏离值、对应起算日和独立版本的阈值接近度，以及股票与指数归档凭据。缺少指数或对应日行情时，相关窗口保留为空，实际零偏离保留为 0。

供应商观察保留未复权 OHLC、除权参考昨收、涨跌额、涨跌百分比、成交量和成交额，以及 `daily_basic` 的换手率和 PE/PB 等。接口同时提供换算为股的成交量和换算为元的成交额，原始数值和单位仍随响应返回。WHYJ 流通市值、换手率、日线技术指标及信号各自保留公式版本。WHYJ 日线指标中的昨收与涨幅来自同复权序列，涨幅为小数比例。

提供 `watchlistMembershipRevision` 时，Runtime 读取当前保存的这一版自选清单，每行通过 `membership` 返回原始加入时间、保存代码和工作区修订。每只股票可另附 `watchlistHistoryRef`，以匹配的前复权日线计算截至列表交易日的加入以来收益率。`metrics.watchlistReturn` 保留历史证据、实际起止交易日与收盘价、公式版本和收益率。省略历史引用时该计算结果为 `null`。晚于加入日的首条历史无法提供基准，价格相等则收益率为 0。自选清单修订变更、股票缺席或历史口径不符时，回放返回错误。

Runtime 调用方可为每只股票附上 `financialArchives`，用[历史时点解析](#财务数据的历史时点)选择在列表交易日前已经获取、且有实际披露证据的报告。`observations.financial` 保留报告期、披露日、归档版本与获取时间，以及供应商记录的基本 EPS、BPS、ROE、利润率、增长率和资产负债率。旧归档可能缺少 EPS 字段，报告币种和比率单位沿用归档口径。无法匹配符合条件的报告时返回不可用原因。日期估值仍来自同一市场截面的 `daily_basic`。

提供 `history.exchange` 或单独的 `tradingLimitsRef` 后，`observations.tradingLimits` 保留 `stk_limit` 的原始人民币阈值、归档版本及观测时间。同一股票只接受其中一种限价引用。当日归档缺行时 `row` 为 `null`，日期相邻的记录不会代填。提供以列表交易日结束的 `limitCalendar: { revision, sessions }` 时，`metrics.limitStreaks` 从历史限价信号计算连续涨停与跌停次数，保留日历和公式版本。缺少信号、交易日证据或此前未触板的起算点时，相应次数为 `null`。已知未触板将该方向的计数重置为 0。

Runtime 调用方可通过 `history.candleBars` 请求 5 至 60 根日 K。`observations.dailyCandles` 从同一份 `history.ref` 中返回最后若干条已观察行情，保留日期、源时间戳、原始 OHLC、量额、单位、复权口径和归档信息。历史记录不足时返回已有行，实际结束日期和缺口随原始日期保留。日 K 切片与当日报价分别保留各自的来源。省略参数时沿用现有响应结构。

Runtime 股票项可提供 `intraday: { ref, interpretation, previousClose? }` 回放与列表股票和交易日相同的一份 TickFlow 分钟归档。`observations.intraday` 保留源纪元时间、量额、原始单位、分钟标签解释和被排除的记录。`metrics.intraday` 保留 WHYJ 计算的逐点收盘均线、以实际昨收计算的涨跌幅，以及图表基准。`previousClose` 使用同价格口径的确认证据。缺少昨收或当天归档为空时，对应涨跌幅保留为空，图表仍可根据已有点显示。

缺少行情或财务估值观察的标的仍占一行，对应观察为 `null`。日线历史缺少目标交易日时，技术指标和信号为 `null`，已有历史归档的实际结束日期随行返回。调用方可用这份结果展示固定日期，实时行情覆盖需要独立的报价时间和价格口径。

```sh
whyj --json observation replay-list-rows --manifest ./list-rows.json
```

清单包含 `version: 1`、`marketRevision`、`adjustment` 和 `stocks`。每项至少提供 `symbol`，附上 `dailyRevision` 可回放技术指标与信号。如需交易所限价信号，可同时提供 `limitsRevision` 及必要的 `rawRevision`。

每项也可以提供 `financialReportRevisions` 与 `financialDisclosureRevisions` 两组归档版本。报告回放以市场截面的交易日为准，支持单独请求财务证据。历史列表与当日报价命令读取相同的清单字段。

`replayTspListRowsWithLiveQuotes` 可为同一列表读一批最多 100 只股票的当日报价。市场截面必须对应当前上海日期，报价时间和获取时间也要属于该日。历史列表与空列表不发起报价请求。批次获取失败仍返回固定列表，缺报价、日期不匹配、时间晚于获取时间与缺有效价格分别标记。

结果的 `fixed` 保留原始历史列表，`quotes` 单独记录 TickFlow 的端点、获取时间、原始数量和行情时间。供应商数量单位仍为未知。WHYJ 以该报价自己的昨收计算涨跌额与小数涨幅，应用可按时间戳展示同日快照。报价请求成功无法证实实时权限或延迟。

```sh
whyj --json observation read-list-quotes --manifest ./list-rows.json
```

`read-list-quotes` 复用同一份清单，且仅在市场截面对应当前上海日期时请求已配置的 TickFlow。固定归档回放继续使用离线的 `replay-list-rows`。

两条列表命令的清单也可填写 `watchlistMembershipRevision`，可从 `replay-watchlist-return` 的 `input.membership.revision` 取得当前修订。每只股票的 `watchlistHistoryRevision` 指向前复权日线。带历史修订但未填写清单修订时返回 `invalid_arguments`，清单已变更或归档无法回放时返回 `observation_archive_unavailable`。查看 `membership.addedAt` 和 `metrics.watchlistReturn` 获取原始加入时间和收益率证据。

两条列表命令均接受 `limitCalendar: { revision, sessions }`。按交易日升序列出计算区间，最后一天须等于列表交易日。仅需供应商涨跌停价时，在股票项填入 `tradingLimitsRevision`，可省略日线。需要连板计数时使用带 `limitsRevision` 的日线信号历史。同一项只接受一种限价修订字段。

两条列表命令的股票项可同时填写 `dailyRevision` 和 `candleBars`，其中 `candleBars` 为 5 至 60 的整数。`replay-list-rows` 和 `read-list-quotes` 的固定结果均从同一归档提供 `observations.dailyCandles`。无效窗口或缺少 `dailyRevision` 返回 `invalid_arguments`，已有引用找不到归档时返回 `observation_archive_unavailable`。

两条列表命令还可从 `screener: { histories, strategies }` 读取完整的选股候选范围和策略配置，字段格式与 `replay-screener-union` 相同。在 `stocks` 中只填需要展示的标的，评分与排名仍基于 `histories` 中的候选。重复策略或候选代码、无效清单字段返回 `invalid_arguments`，归档不可用或与列表范围不符返回 `observation_archive_unavailable`。

股票项也可附上 `deviation: { stockRevision, benchmarkRevision? }`，清单需同时提供以列表交易日结束的 `deviationCalendar: { revision, sessions }`。两个命令的固定结果都返回该日的窗口偏离、接近度及归档证据。引用格式或日历结构错误返回 `invalid_arguments`，归档不可用或与列表范围不符返回 `observation_archive_unavailable`。

两条列表命令的股票项接受 `intraday`，其中包含 `minuteRevision`、`interpretation` 和可选的 `previousClose`。用 `interpretation.timestampLabel` 指定 `minute-start` 或 `minute-end`，并以 `priceBasis: "caller-confirmed-unadjusted-CNY"` 确认分钟价格口径。可确认的 `volumeUnit` 为 `share` 或 `hand`，`amountUnit` 为 `CNY` 或 `CNY-thousand`。若要计算昨收涨幅，提供 `previousClose: { revision, priceBasis: "caller-confirmed-same-basis" }`。`observations.intraday` 和 `metrics.intraday` 分别返回原始证据和 WhyJ 图表计算。

`previewCurrentTspListIntraday` 为指定股票批量读取上海当天的 TickFlow 临时分钟帧。原始结果保留在 `input.minutes`。明确提供分钟标签和确认的未复权价格口径时，逐股返回 WHYJ 价格线、累计均价和昨收收益。没有解释时返回原始行情，`metrics` 为空。可用的昨收引用必须与股票和交易日相符，缺少昨收仍可绘制价格线。被排除的时间标签及原因单独记录。临时预览不写入完成归档。

CLI 使用 `whyj --json observation read-current-stock-minutes --manifest PATH` 读取这一预览。JSON 清单须提供 `version: 1`、上海当天的 `tradeDate` 和 1 至 100 只互异的沪深京股票 `stocks: [{ "symbol": "600001.SH" }]`。只需要原始行情时可省略 `interpretation`。要计算 WHYJ 图表指标，须提供 `interpretation: { timestampLabel, priceBasis: "caller-confirmed-unadjusted-CNY" }`，其中 `timestampLabel` 取 `minute-start` 或 `minute-end`。计算昨收收益时，在对应股票下附上 `previousClose: { revision, priceBasis: "caller-confirmed-same-basis" }`，引用当天的涨跌停归档。输出保留 `input.minutes`、逐股状态和可用的 `rows[].metrics`。供应商请求失败返回 `observation_collection_failed`。

Runtime 的 `previewCurrentTspEtfIntraday` 对沪深 ETF 支持同一套临时价格线与累计均价。请求用 `etfs` 指定目标。可选昨收包含同一 TickFlow ETF 的日线归档 `dailyRef`、调用方提供的 `calendar: { revision, previousTradeDate, tradeDate }`，以及 `priceBasis: "caller-confirmed-same-basis"`。读不到该日已归档收盘价时保留分时图和空收益；交易日期或来源不符会使请求失败。临时帧仍保留 ETF 身份和原生行情字段。

CLI 使用 `whyj --json observation read-current-etf-minutes --manifest PATH`，清单包含 `version: 1`、上海当天的 `tradeDate` 和 1 至 100 只互异 ETF 的 `etfs: [{ "symbol": "510300.SH" }]`。配置 `interpretation` 后可查看 WHYJ 临时指标。对应 ETF 可提供 `previousClose: { dailyRevision, calendar, priceBasis }`，其中 `calendar` 的日期与 Runtime 契约一致，`dailyRevision` 引用同一 TickFlow ETF 的日线归档。输出保留原始帧和可用的逐标的指标。

股票和 ETF 的 Runtime 分时预览可通过 `quoteTail: { maxAgeMs, priceBasis: "caller-confirmed-same-basis" }` 显式追加一次同供应商的 TickFlow 报价读取。需同时声明分钟标签和价格口径，`maxAgeMs` 为非负安全整数。源分钟和报价分别保留在 `input.minutes` 和 `input.quoteTail`。WHYJ 只使用时间戳晚于分钟帧接收时刻、同标的、同一连续交易时段且符合新鲜度要求的报价。应用报价的点带有 `priceSource: "quote"`，逐标的 `quoteTail` 记录应用状态。报价缺失、过期或接口不可用时保留原分时曲线。行情原生量额保留各自的单位，新增分钟的量额未知。

### 流通市值与换手率回放

`replayTspListLiquidity` 以固定市场截面归档和交易所限定的股票代码查询两个列表指标。Runtime 在同一交易日关联 Tushare `daily` 的未复权收盘价与成交量、`daily_basic` 的流通股数。成交量从手换算为股，流通股数从万股换算为股。标的须属于归档股票池，归档内缺失的源记录和计算值以 `null` 表示。

`observations` 保留两条源记录的端点、时间与原始单位，包括供应商原报的流通市值和换手率。`metrics` 记录 WHYJ 的计算结果、公式版本、人民币元与百分点单位。计算基于选定归档，归档修订使用独立引用。

CLI 使用现有市场截面归档的 SHA256 修订号，无需联网。

```sh
whyj --json observation replay-list-liquidity --revision SHA256 --symbol 600519.SH
```

### 自选加入以来涨跌幅

`replayTspWatchlistReturn` 从本地自选成员记录读取加入日期，再按明确的截止日回放一份前复权股票日线归档。输出把成员代码、日期和文件版本与供应商行情引用分开记录，并返回实际用到的基准和期末行情。可指定已读取的成员版本，后续若发生编辑会拒绝回放。仅在旧的六位代码可归一为归档里的交易所限定代码时使用兼容路径。读取不修改自选记录或请求供应商。 [指标口径](../quant-harness/tsp-list-catalog.md#return-since-watchlist-addition)

通过 `whyj --json observation replay-watchlist-return --revision DAILY_SHA256 --as-of 2024-03-04` 读取已归档的自选涨跌幅。日线引用应来自 `collect-daily --adjustment forward`。添加 `--membership-revision PORTFOLIO_SHA256` 可要求继续使用上一次响应中的自选版本。输出保留用到的两个实际行情日期。
