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

Host 的认证采集任务支持 `{ dataset: "daily-trading-limits", symbol, startDate, endDate }`，凭证来自已保存的选定来源。非空收据包含带种类的归档引用。可选认证 RPC `readObservationExchangeIndicators` 以 `{ archiveRef, tradingLimitArchiveRef, rawArchiveRef? }` 回放，两种归档缺失或损坏均返回固定的不可用诊断。原有 `readObservationIndicators` 继续接收单份日线归档引用。旧 Host 对可选新方法返回 `METHOD_NOT_FOUND`。

Runtime 的 `collectMarketCrossSection` 通过配置的数据源采集指定交易日的股票池、日线和每日交易统计。当前接口使用 Tushare 的三个独立响应。股票池为空时返回空结果，缺失的行情行保留为缺失，已经捕获的原始行和供应商单位由 Storage 按摘要保存。

`collectRiskWarningObservations` 通过配置的 Tushare 查询指定交易日的 `stock_st`，返回来源、交易日、采集时刻、行数和精确归档引用。成功返回空名单时，回执仍包含可离线读取的引用。观察覆盖保持未知，交易日名单由历史股票池回放按需使用。

`collectBenchmarkIndexObservations` 通过配置的 Tushare 采集一个沪深基准指数在指定日期范围内的 `index_daily` 数据。回执包含指数代码、请求范围、采集时刻、单位、行数和精确归档引用。供应商成功返回空列表时保留可离线读取的引用，状态为 `empty`。采集只保存供应商点位和涨跌幅，市场环境指标在回放时计算。

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

个股涨跌幅用目标日与紧邻前一交易日的前复权收盘计算。五日量比只用目标日之前紧邻的五个交易日市场截面。四只核心指数分别用目标日归档的收盘和昨收点位计算百分点。缺失的归档、个股前收或板块覆盖保留在回执中。目标日市场缺失，或启用了 ST 筛选但没有目标日快照时，回执保留目标日期和缺失原因。`dashboard` 记录 WhyJ 的公式版本、输入值、结果与覆盖范围，五档盘口修正标为不可用。

CLI 可用当前已保存的数据源凭证采集和回放同一份归档。配置来源后，用 `whyj --json doctor --phase data` 检查凭证是否可用，再运行以下命令。用第一条返回的 `data.ref.revision` 替换第二条的 `SHA256`。

```powershell
whyj --json observation collect-daily --symbol 600000.SH --start 2026-01-05 --end 2026-04-30
whyj --json observation replay-daily --revision SHA256
```

采集默认请求未复权日线。`--adjustment forward` 适用于支持该口径的选定来源。空采集返回 `status: "empty"` 和空引用。回放可离线进行，返回 37 个日线字段、日线信号和对应公式版本，保留输入的供应商、复权口径和归档引用。

历史分时通过配置的 Tushare `stk_mins` 采集。一次请求一个 A 股标的，日期窗口至多 31 天并且早于上海当天。采集完成后，用第一条返回的 `data.ref.revision` 离线回放。

```powershell
whyj --json observation collect-minutes --symbol 600000.SH --start 2026-01-05 --end 2026-01-09
whyj --json observation replay-intraday --revision SHA256
```

回放含 11 项指标、4 项穿越信号、原始时间标签和单列开盘边界。已有同一标的的涨跌停价归档时，可同时传入 `--previous-close-revision SHA256 --price-basis caller-confirmed-same-basis`，使用其中同日的昨收证据。只有确认两份归档价格口径相容时才声明该选项。

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
