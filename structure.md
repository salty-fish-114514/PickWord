# PickWord 项目架构参考

## ⚠ 先读：约束解码 × 模型回合格式（纠错「一律回无」事故记录）

**现象**（2026-10-14，Qwen3.5-9B Q4，纠错首版）：对明显病句一律输出「无」。主进程日志 `[llm] … predicted_n=2 stop=eos`——模型只吐了「无」+ EOS 两个 token，根本没进入"读正文找问题"的状态。

**机制**：不是文法（GBNF）削弱了模型，而是文法与模型的回合格式撞车：

| 环节 | 事实 |
|------|------|
| Qwen3.5 的 chat_template | 小模型默认非思考；`enable_thinking=false` 时模板**在 assistant 回合开头注入空思考块** `<think>\n\n</think>\n\n`，模型就是在这个分布上训练的 |
| 我们的 prompt | 停在 `<\|im_start\|>assistant\n`，没有空思考块 → 模型第一个 token 的自然选择是 `<think>` |
| 文法 `root ::= "无" \| line+` | 把 `<think>` 判为非法，重新归一化后只剩「无 / A / B」；「无」是唯一**一个 token 就能完整合法结束**的输出 |
| 结果 | 判断被迫**提前到第一个 token**，在模型还没"开口"时就坍缩到最省事的合法分支 |

约束解码不会增加能力，只是在合法 token 里重新分配概率；一旦合法集合排除了模型的自然首 token，决定权就落在剩下的"边角料"上。单 token 的逃生口（「无」）与多 token 的实质回答（`A|…`）竞争本就不公平。

**修复**（已生效，验证正常）：`ModelProfile.noThinkPrefix`（`shared/modelProfile.ts`，模板含 `<think>` 或模型名为 Qwen3.5 时 = 空思考块），指令类任务的 prompt 接在 `template.assistantOpen` 之后（`lib/proofread.ts` `buildProofreadPrompt`）；`main/llm.ts` dev 日志打印模型原话前 200 字，方便再次核对。

**对今后微调 / 提示词工作的硬性要求**：
1. 训练样本的回合格式必须与运行时**逐字节一致**（含空思考块、`正文：` 等前导文本、`assistantOpen` 之后的内容），否则首 token 分布偏移，文法会把偏移放大成坍缩。
2. 任何"模型总是回同一个短答案"的问题，先看 `predicted_n` 与原话，再怀疑模型能力。
3. 文法里不要给单 token 逃生口不设代价：要么微调时平衡「无」样本比例，要么让格式先写一行非平凡内容（如「概览：…」）再逐条列出。
4. 候选续写（`promptBuilder.buildPrompt`）是续写式用法，assistant 回合直接接正文，不加空思考块；这是有意的区别，不要"统一"掉。

---

## 项目概览

PickWord 是一个基于 Electron + React + TypeScript 的本地写作助手桌面应用（Windows x64）。核心功能是把正文送给本机 `llama-server`，在光标处给出下一个 token 的候选列表，由作者挑选。

**技术栈**：
- Electron 39 + electron-vite 5 + TypeScript 5.9
- React 19 + Vite 7（renderer）
- 原生 CSS（5 个样式文件，§ 索引导航）
- llama.cpp `llama-server` 作为独立子进程（不打进安装包，首次启动由向导下载或指定）
- 零运行时第三方库（docx 解析、zip 解压、图标全部自实现或调用系统能力）

**代码规模**：~11.9k 行 TS/TSX + ~4k 行 CSS

---

## 目录结构

```
PickWord/
├── package.json              # 1.0.2；脚本只保留 Windows 打包（build:win / build:unpack）
├── electron.vite.config.ts   # main / preload / renderer 三段构建，@renderer 别名
├── electron-builder.yml      # NSIS 安装包；排除 resources/backend.json
├── tsconfig.json             # node（main+preload+shared）与 web（renderer+shared+preload/*.d.ts）
├── .gitattributes            # * text=auto eol=lf
├── resources/backend.json    # 仅开发机使用的后端配置（含本机路径，勿提交个人路径）
├── build/                    # 安装包图标
│
└── src/
    ├── shared/               # 两个进程共用：类型 + 纯函数（不碰 electron / DOM）
    │   ├── ipc.ts            # 全部 IPC 载荷 + IpcInvokeMap / IpcSendMap / IpcPushMap 通道清单（308 行）
    │   ├── materials.ts      # 角色卡 / 设定条目类型、parseMaterials / parseChapterOutlines 宽松解析（138 行）
    │   ├── modelProfile.ts   # ModelProfile、PromptTemplate（chatml / gemma / llama3）、EOS / 隐藏标记默认表（101 行）
    │   ├── backendArgs.ts    # llama-server 参数表的读写 / 拆装（-c -t --device 等）、默认端口与上下文（112 行）
    │   └── text.ts           # countChars / makeExcerpt / safeFileName / REBUILD_HINT_CHARS（27 行）
    │
    ├── main/                 # Electron 主进程
    │   ├── index.ts          # 窗口、类型化 handle/on 注册、关窗保护、choosePath 对话框（232 行）
    │   ├── backendConfig.ts  # backend.json 的唯一读写者：路径、宽松解析、校验、原子写、update(fn)（167 行）
    │   ├── setup.ts          # getSetupState()：配置是否可用、是否缺 --device（70 行）
    │   ├── catalog.ts        # 下载清单：llama.cpp tag、镜像列表、引擎资产、MODEL_PRESETS、默认目录（102 行）
    │   ├── backend.ts        # LlamaBackend：拉起 / 停止 / 重启 llama-server，日志隐私，状态广播（262 行）
    │   ├── loadProgress.ts   # LoadProgressTracker：PHASE_MARKERS → fraction，历史耗时平滑 + ETA（120 行）
    │   ├── devices.ts        # llama-server --list-devices 解析（83 行）
    │   ├── candidates.ts     # 转发 /completion（槽 0），按 ModelProfile 标记 isEos、过滤隐藏标记；/props → ModelProfile（含 slots）（335 行）
    │   ├── llm.ts            # 通用一次性补全 llm:complete（槽 1 起，GBNF 文法、取消、槽位数校验）—— 纠错 / 校验共用（127 行）
    │   ├── expand.ts         # 短句展开 expand:start（槽 0、stream: true、chunk 经 expand:chunk 推送、取消）（120 行）
    │   ├── sse.ts            # llama-server SSE 流解析 readSseStream（不依赖 electron，可直接冒烟）
    │   ├── hardware.ts       # CPU / GPU / 显存检测与后端推荐（PowerShell、WMI、nvidia-smi）（611 行）
    │   ├── deploy.ts         # 部署流程：parseDeployConfig、多镜像下载、解压、写 backend.json（260 行）
    │   ├── downloader.ts     # 断点续传下载、PowerShell 解压（参数数组，不拼命令行）、进度广播（345 行）
    │   ├── library.ts        # 文库：短篇 txt + 旁车 v5；长篇 = 子目录 + book.json + 多卷；书级操作；目录迁移
    │   ├── fonts.ts          # 系统字体名清单 fonts:list：GDI+ 字体族名 + 注册表字体表（清洗、去重、进程内缓存、非 Windows 返回空）
    │   ├── documents.ts      # 「导出 TXT 副本」（55 行）
    │   └── ioUtils.ts        # 类型守卫、原子写、串行队列、文稿校验（127 行）
    │
    ├── preload/
    │   ├── index.ts          # 类型化 invoke/send/on 封装 + contextBridge 暴露 api；`WriterApi = typeof api`（129 行）
    │   └── index.d.ts        # 全局 `Window.api?: WriterApi` 声明（renderer 的 tsconfig 包含它）
    │
    └── renderer/
        ├── index.html
        ├── public/brand/pickword-logo.png
        └── src/
            ├── main.tsx            # 入口：渲染 <Bootstrap />
            ├── Bootstrap.tsx       # 启动门控 + 关窗 flush 桥接（99 行）
            ├── App.tsx             # 文库入口，持有设置与文稿列表，书级操作转发 provider，挂「模型与推理」面板（331 行）
            ├── WritingEditor.tsx   # 单卷编辑器（1928 行，A–J 十段）：章节栏 / 工作台 / 右键菜单在此装配
            ├── index.css           # 只负责 @import 五个样式文件
            │
            ├── components/
            │   ├── setup/
            │   │   ├── SetupWizard.tsx     # 向导编排：步骤 / 表单状态 / 调 preload（312 行）
            │   │   ├── steps/              # HardwareStep / EngineModelStep / DeployStep / DeviceStep（纯展示）
            │   │   ├── DevicePicker.tsx    # --list-devices 单选列表（向导与面板共用）
            │   │   ├── setupShared.tsx     # SetupFrame / StatusNote / PathField 小组件
            │   │   ├── setupUtils.ts       # formatBytes / errorText / defaultDeviceId / BACKEND_KIND_LABEL
            │   │   └── engineModelForm.ts  # EngineModelForm 类型 + 校验
            │   ├── BackendSettingsPanel.tsx# 首页「模型与推理」弹窗：编辑 backend.json 结构化字段（226 行）
            │   ├── LibraryHome.tsx     # 文库首页：短篇 / 长篇卡片（groupEntries）、导入、改名、新建长篇、卷菜单、删除（776 行）
            │   ├── SettingsPanel.tsx   # 设置面板：基本页 + 高级页（483 行）
            │   ├── FontPicker.tsx      # 顶栏的两个下拉控件：FontPicker（字体）与 FontSizePicker（字号）
            │   ├── ChapterPanel.tsx    # 左侧目录栏：长篇时卷列表（切换 / 新建，先保存再切）+ 本卷章节（跳转 / 双击或右键改名 / 取消分章 / 插入）
            │   ├── ContextMenu.tsx     # 右键菜单（portal 到 .app-root：侧栏的 transform 会困住 fixed 元素；定位 / Esc / 外点关闭）
            │   ├── ChapterTitleField.tsx # 纸面「本章」标题草稿框：聚焦时 `editableChapterTitle` 补一个空格、只选中「第N章 」之后的部分；失焦 / 回车才回写标记行
            │   ├── workbench/          # 右侧工作台：44px 图标栏 + 380px 单面板
            │   │   ├── tabs.ts         # WorkbenchTab / WORKBENCH_TABS（上下文 / 大纲 / 角色 / 设定 / 纠错）
            │   │   ├── Workbench.tsx   # WorkbenchRail + WorkbenchPanel（按 tab 分发）（162 行）
            │   │   ├── shared.tsx      # Switch / Block / FieldArea / AliasField / ListToolbar / CardShell
            │   │   ├── ContextTab.tsx  # 风格 / 「注入大纲段」总开关、光标所在段摘要、本次注入的卡片清单
            │   │   ├── OutlineTab.tsx  # 总纲（备忘，不送模型）+ 本章大纲段卡片（章首段固定；其余可 移到光标处 / 并入上一段 / 删除；单段注入开关；全部 N 章折叠视图）
            │   │   ├── CharactersTab.tsx # 角色卡：主要 / 次要分组、四固定字段 + 自定义字段、本地提取候选名（192 行）
            │   │   ├── LoreTab.tsx     # 设定：地点 / 组织 / 物品 / 其他（123 行）
            │   │   └── ProofreadTab.tsx # 纠错：检查按钮 / 自动检查 / 本地提示开关、状态行、问题卡片（采纳 / 定位 / 忽略）（165 行）
            │   ├── CandidatePopover.tsx# 候选浮层：自带光标镜像测量与定位（211 行）
            │   ├── SearchPanel.tsx     # 查找替换（127 行）
            │   ├── BackendStatusBar.tsx# 模型状态条（60 行）
            │   ├── GentleToast.tsx     # EOS 弱提醒
            │   ├── BrandLogo.tsx / Icon.tsx
            │
            ├── lib/
            │   ├── platform.ts         # 唯一碰 window.api 的地方：platform.isElectron / platform.api / requireApi()
            │   ├── types.ts            # re-export shared 类型 + renderer 专有 UI 类型；WriterApi 取自 Window["api"]（77 行）
            │   ├── promptBuilder.ts    # 四种模式拼接、「人物与设定」注入、段起点 / 滑窗、硬上限；正文经 stripChapterMarks（标记行整行删除）
            │   ├── outline.ts          # 大纲段：layoutOutline（按章归类、章首段判定、区间）/ segmentAt / segmentInjects / createSegment / mapSegmentsThroughEdit / remapSegments / migrateLegacyOutline
            │   ├── chapters.ts         # 章节标记 `--标题--`：parseChapters / chapterAt / insert / rename / remove / strip（整行删）/ editableChapterTitle；「第N章」自动顺延 renumberChapters；VolumeSummary
            │   ├── materials.ts        # 命中检测 findMaterialHits、注入文本 buildMaterialsText、本地人名提取 extractCandidateNames（243 行）
            │   ├── decorations.ts      # 高亮层装饰：Decoration{anchor|band|wavy, tone, active, label} + splitByDecorations
            │   ├── proofread.ts        # 纠错核心（纯函数）：窗口选择、提示词 + GBNF 文法、行格式解析、QuoteLocator 三级定位、Issue 随 EditSpan 平移、合并（396 行）
            │   ├── monotony.ts         # 本地单调提示：1500 字内重复的 ≥4 字片段（人名 / 停用组合除外）、连续 ≥3 段同样开头、专名写法不一致
            │   ├── completion.ts       # 通用补全数据源（IPC / 演示 mock），纠错等后台任务共用（72 行）
            │   ├── expansion.ts        # 短句展开数据源（IPC 流 / 演示逐字 mock）、停止符 `，。！？；…\n`、采样参数、finalizeExpansion（补回句尾标点）
            │   ├── useExpander.ts      # 展开编排 hook：按候选全局序号存 rows、串行逐行解码、cancel 保留半句 / clear 清空
            │   ├── useProofreader.ts   # 纠错 + 人设校验编排 hook：手动 / 自动触发、每槽串行队列、在飞期间的编辑回放、本地提示防抖、忽略 / 清除
            │   ├── candidateProvider.ts# 数据源切换（IPC / mock）、概率软化、随机取词（319 行）
            │   ├── candidateScheduler.ts# 防抖 + 单飞 + 最新优先的候选请求调度（93 行）
            │   ├── candidatePostprocess.ts# 排序 → 软化 → EOS 判定 → 过滤 → 多样化（纯函数，48 行）
            │   ├── candidateDiversity.ts# 候选多样化重排（369 行）
            │   ├── useVersionedSave.ts # 版本号对比的保存状态机（78 行）
            │   ├── useEditHistory.ts   # 撤销 / 重做：差异帧栈（只存改动区间，850 ms 合并、400 帧上限）（146 行）
            │   ├── flushRegistry.ts    # 关窗落盘单点注册：registerFlusher / installFlushBridge（45 行）
            │   ├── editorText.ts       # 光标像素测量（CaretLayoutCache 复用镜像）、查找、Anchor 跨编辑映射（大纲段起点复用）
            │   ├── library.ts          # LibraryProvider 接口（含 5 个书级操作）、localStorage 演示实现、emptyDocument、排序（485 行）
            │   ├── settings.ts         # SettingsValues、默认值、SETTING_LIMITS（sanitize / 面板滑杆 / 顶栏下拉共用）+ numericOptions
            │   ├── openFile.ts         # txt/md/docx 字节 → 纯文本（UTF-8 / GB18030、自实现 zip）（246 行）
            │   ├── useBackendStatus.ts # 模型状态 / 进度 / ModelProfile 订阅（useSyncExternalStore）（148 行）
            │   ├── fonts.ts            # 本机中文字体探测（canvas 逐像素签名验证 + 三处名字来源）与字体栈拼接；候选名单只是探测输入，列表永远由当前机器量出来
            │   ├── pathPicker.ts       # dialog:choose-path 薄封装 + pathOfDroppedFile（34 行）
            │   └── format.ts           # formatEta
            │
            └── styles/
                ├── base.css      § B1–B7  令牌、重置、共享控件、侧栏框架、品牌、弹窗、动效
                ├── editor.css    § E1–E9  写作页
                ├── library.css   § L1–L7  文库首页
                ├── settings.css  § S1–S5  设置面板
                └── setup.css     § W1–W10 向导 + 「模型与推理」弹窗
```

---

## 核心架构决策

### 1. 三段进程 + shared 层

**主进程（main/）**：
- 拉起并看护 `llama-server` 子进程（backend.ts），加载进度单独在 loadProgress.ts
- 候选请求转发（candidates.ts）——不拼 prompt，只转发、整理概率、按 ModelProfile 标 EOS
- 文库文件 I/O、目录迁移、导出（library.ts / documents.ts）
- 首次设置：硬件检测、下载清单、部署、配置读写（hardware.ts / catalog.ts / deploy.ts / backendConfig.ts）
- 系统对话框（`dialog:choose-path`）——renderer 永远拿不到绝对路径，只能由这里给
- 所有 handler 只接受主窗口请求（`isFromMainWindow`），入参按 `unknown` 校验

**渲染进程（renderer/）**：
- 启动门控、文库 UI、编辑器、候选展示
- prompt 拼接、概率软化、候选重排在 renderer 完成；模板 / 上下文长度 / EOS 表来自主进程的 ModelProfile
- 设置持久化（localStorage）

**桥接（preload/）**：
- `invoke / send / on` 三个泛型封装绑定到 `shared/ipc.ts` 的三张通道表，通道名或载荷类型写错即编译失败
- `WriterApi = typeof api`，renderer 通过 `src/preload/index.d.ts` 的全局声明得到同一类型，不再手写镜像接口
- 把主进程 5 态 `BackendState` 折叠为前端 4 态 `UiBackendStatus`（starting → loading）
- `getPathForFile(file)` 包装 `webUtils.getPathForFile`（Electron 32 起 `File.path` 已移除）

**shared/**：类型 + 纯函数，两个 tsconfig 都包含；`backendArgs.ts` 是 llama-server 参数表的唯一拆装口（主进程写文件、面板展示都用它）。

### 2. 启动门控（Bootstrap）

`main.tsx` 只渲染 `<Bootstrap />`，由它调用 `getSetupState()` 决定进入哪一页：

```
无 preload ───► app（浏览器演示）
checking ──► setup        （未配置 / 配置损坏 / 文件丢失 → 完整向导，用 existingConfig 预填）
         ├─► deviceSetup  （配置有效但 args 缺 --device → 向导的设备选择整页）
         └─► app          （配置完整 → lazy import App）
```

- `App` 用 `lazy()` 动态加载：未配置时不执行 App 的模块级初始化
- 向导可「跳过」直接进 App；App 内「模型与推理 → 重新运行安装向导」回到 setup 阶段
- `installFlushBridge()` 在 Bootstrap 挂载一次：订阅 `app:flush` + `beforeunload`，调用 `flushRegistry` 当前登记的落盘函数（首页无人登记 → 立即放行）
- 主进程侧：`getSetupState().configured` 为真才 `backend.start()`

### 3. 文库模式（Library-first）

应用先进入**文库首页**，选中文稿后才挂载 `WritingEditor`（`key={id}` 强制重挂载，隔离撤销栈、候选请求、IME 状态）。

**存储布局**（main/library.ts）：
```
<文库目录>/
├── <标题>.txt            # 短篇正文，LF 换行
├── <标题>.writer.json    # 旁车 v5：v3 字段 + outlineSegments[{id,anchor{offset,fingerprint},text,inject}] + materials；anchor / chapterOutlines 只读旧档（renderer 迁移后写回 null / {}）
└── <书名>/               # 长篇 = 一本一个子目录
    ├── book.json         # {version,id,title,styleText,styleEnabled,materials,createdAt,updatedAt}：风格与角色 / 设定全书共用
    ├── <书名>_0卷.txt     # 卷按 `_N卷` 编号（0 起），卷标题存旁车 title
    └── <书名>_0卷.writer.json
```
- **ID = 旁车里的 UUID**，永不变化；物理文件名跟随标题（改名时成对 rename，重名追加 ` (2)`）
- 长篇的 `LibraryEntry.book = {id,title,volume}`；读卷时 styleText / materials 取自 book.json，存卷时写回 book.json（旁车里留空）
- 书级操作：`createBook / createVolume / renameBook（目录 + 各卷文件一起改）/ convertToBook（短篇成第 0 卷）/ convertToStandalone（仅单卷）`；删掉最后一卷时目录随之移除
- 章节不在存储层：正文里的 `--第N章 标题--` 整行即章节标记（lib/chapters.ts 解析，送模型前去掉 `--`）
- 无旁车的孤立 `.txt` 在扫描时自动补旁车；列表读取只读旁车，正文字数 / 摘要来自缓存（旧旁车首次扫描补算）
- 目录配置存 `userData/library-config.json`；默认目录：打包后 **`文档/PickWord/manuscripts`**，开发时项目根 `manuscripts/`。首启若 exe 同级旧 `manuscripts/` 有文稿且尚无配置，自动搬到新默认目录
- 全部写入经 `createSerializedQueue()` 串行 + `writeFileAtomic()` 落盘；删除走回收站
- 换目录 = 复制全部文稿 → 成功才切配置 → 清理源目录，失败回滚

**renderer 侧**：`lib/library.ts` 定义 `LibraryProvider` 接口；`platform.isElectron` 时用 IPC 实现，否则 localStorage 演示库。

### 4. WritingEditor 组件

编辑器仍是最大的组件（1928 行），按 **A–J 十段**用注释分隔，但以下关注点已抽成独立模块：

| 关注点 | 模块 | 编辑器里剩下什么 |
|------|------|------|
| 候选请求调度 | `lib/candidateScheduler.ts`（`schedule(job, delay)` / `cancel()` / `isCurrent(controller)`） | `runJob`：拼 prompt → provider → 竞态校验 → 更新 state |
| 候选后处理 | `lib/candidatePostprocess.ts` | 传入 settings 阈值，接收 `{candidates, eosHit}` |
| 保存状态机 | `lib/useVersionedSave.ts`（`markDirty / save / saveRef / saveStatus`） | `persist` 回调里调 `onSave(buildPayload())` |
| 撤销 / 重做 | `lib/useEditHistory.ts`（`record / breakGroup / undo / redo / canUndo / canRedo`） | 恢复快照时写回 textarea |
| 关窗落盘 | `lib/flushRegistry.ts`（`registerFlusher(() => saveRef.current())`） | 一个 effect |
| 浮层定位 | `CandidatePopover` 自带镜像 div；`popoverRef.current?.relayout()` 在滚动时调用 | — |
| 章节 | `lib/chapters.ts`（`parseChapters` 纯函数，useMemo 于 content） | 当前章 = `chapterAt(index, caret)`；分章 / 重编号 / 改名 / 取消分章都把精确偏移映射传给 `setEditorDocument(…, mapOffset)`，大纲段起点随之平移 |
| 大纲段 | `lib/outline.ts` | `outlineLayout = layoutOutline(content, chapterIndex, context.outlineSegments)`（单槽缓存，段数组必须不可变替换）；`currentSegment = segmentAt(…, caret)`；`segmentInjecting = segmentInjects(current, caret, outlineEnabled)`；操作：`addSegmentAtCaret`（右键 / 面板）/ `setSegmentText`（空章首卡写字才建段）/ `setSegmentInject` / `moveSegmentToCaret` / `removeSegment(merge)` / `locateSegment`；`outlineFocusKey` 让面板聚焦并闪一下某张卡 |
| 人物 / 设定注入 | `lib/materials.ts` | `hits = findMaterialHits(materials, content, bodyStart, caret)` → `buildMaterialsText` 进 `promptArgsFor` |
| 高亮层 | `lib/decorations.ts` | `decorations` useMemo（每个大纲段起点一条横线 + 「大纲 i/n」标签，tone manual = 当前且注入中 / chapter = 当前未注入 / idle；纠错的 wavy / band，光标所在处 `data-active`）→ `splitByDecorations` 渲染到 textarea 下方的镜像层 |
| 纠错 / 人设校验 | `lib/useProofreader.ts` | `proofreader = useProofreader({content, caret, template, noThinkPrefix, backendReady, slots, auto, local, consistencyAuto, materials, ignoreNames})`；`setEditorDocument` 每次改动调 `proofreader.onEdit(span)`；采纳 = `applyProgrammaticEdit`（被改到的问题自动消失） |
| 短句展开 | `lib/useExpander.ts` | `expander = useExpander()`；`startExpansion(currentPageItems())` 用 `candidatePromptRef`（当前候选对应的提示词）+ 候选词逐行解码；`scheduleCandidates` / `cancelCandidateWork` 都 `expander.clear()`；`pickCandidate` 插入 词 + rows[i].text |

```
A. 提示词（promptArgsFor 注入 profile.template / effectiveContextLen）
B. 滑动窗口（syncWindow；段起点生效时不推进）
C. 候选请求（runJob；调度策略见 candidateScheduler）
D. 文本写入、大纲段起点同步、撤销重做
E. 按文稿 ID 保存 / 导出 TXT（platform.api.saveDocumentAs）/ 返回首页
F. 输入法（IME）兼容
G. 编辑器事件与键盘（分页、穿透键、随机取词、插入候选）
H. 副作用：快捷键、自动保存、关窗落盘
I. 查找替换 / 上下文 / 大纲段 / 章节 / Toast / 日志
J. 渲染用的派生值
```

状态镜像约定不变：每次渲染把 `content / title / context / settings / backendStatus / profile` 同步进同名 ref，异步回调一律读 ref。

**布局**：`.topbar`（左：返回 / 目录开关 / 品牌 / 模型状态；右：工具列，末两位是「字体」与「字号」两个下拉，见 `components/FontPicker.tsx`）→ `main.workspace` [ChapterPanel?][SearchPanel?] `section.editor-stage`（眉题 + 可编辑章节标题 + 高亮层 + textarea）→ `WorkbenchPanel`（380px，单面板）→ `WorkbenchRail`（44px 图标栏）→ `footer.statusbar`。右键菜单项在 `openContextMenu` 时按当前选区计算（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 / 查找 / 立即取候选 / 把候选展开为短句 / 在此处分章 / 从这里新起大纲段 / 检查光标前的文字 / 校验这段的人设 / 建角色卡）。底栏显示「大纲段 i/n」与「… · 从段起点」。

**对外接口**：
```ts
interface WritingEditorProps {
  initial: DocumentPayload
  sourceFormat: LibraryFormat
  book?: BookRef                 // 长篇的卷：眉题「书名 · 第N卷」，统计显示全卷
  volumes?: VolumeSummary[]      // 目录面板里的卷列表（App 从 entries 过滤）
  onSwitchVolume?: (id) => Promise<void>   // 编辑器先 performSave 成功再调用（leaveAfterSave）
  onCreateVolume?: () => Promise<void>
  settings: SettingsValues
  onToggleAutoSave: (enabled: boolean) => void
  onSave: (document: DocumentPayload) => Promise<LibraryEntry>
  onBack: () => void
}
```

### 5. 候选系统（Candidate System）

```
textarea 输入
 → scheduler.schedule(job, delay)（普通模式等 triggerDelay；快速模式 0ms、浮层常驻）
     任何时刻最多 1 个在飞 + 1 个排队，新任务覆盖旧排队；cancel 时顺手 abort 在飞
 → runJob：buildPrompt(template 来自 ModelProfile) → provider(request, signal)
     ├ realCandidateProvider：platform.api.getCandidates；abort 翻译成 cancelCandidates(requestId)
     └ mockCandidateProvider：词库 + 伪 logit（浏览器演示）
 → 主进程 candidates.ts：POST /completion { n_predict: 1, n_probs: topK+16, cache_prompt, id_slot: 0 }
     解码 bytes（严格 UTF-8，丢弃半字节碎片）、按 token id / profile.eosTexts 标记 isEos、过滤隐藏标记
 → renderer 竞态校验（controller 仍在飞、未组字、正文与光标未变）
 → postprocessCandidates：软化 → EOS 弱提醒计数（仅大纲模式）→ 去掉 EOS 再软化 → diversifyCandidates
 → CandidatePopover（分页、↑↓/Enter、随机取词键、穿透键淡化）
```

- `BACKEND_TOP_K = 100` 固定，前端分页；主进程上限 `MAX_TOP_K = 200`
- 请求超时 180 s（纯 CPU 全量 prefill 可能很慢）
- `commonPrefixLength(lastPrompt, prompt)` 估算 KV cache 失配量，超 `REBUILD_HINT_CHARS` 提示「上下文重算」

### 5b. 纠错（Proofreading）

```
触发：面板「检查当前窗口」/ 右键「检查光标前的文字」（手动，含光标段）
      或 停笔 3 s 且新写 ≥ 600 字（自动开关，不含光标段）
 → resolveProofWindow：起点固定（前缀缓存命中）、终点 = 光标段；窗口 > 6000 字时起点跳到 end-4000 的段首
 → maskChapterMarks（标记行换等长空格）→ buildProofreadPrompt(template, 窗口) + PROOFREAD_GRAMMAR
 → completion provider → 主进程 llm.ts：POST /completion { id_slot: 1, grammar, temperature 0.2, n_predict 400 }
     槽位不足（profile.slots ≤ 1）直接报错；文法不被旧版识别时 renderer 退回无文法重试
 → parseFindings：A|引用|问题|改法（语病）/ B|引用1‖引用2|重复了什么|（单调）/ 无
 → findingsToIssues：QuoteLocator 精确 → 去标点规范化 → ≥8 字最长公共子串 → 丢弃
 → 请求在飞期间的 EditSpan 依次回放 → mergeLlmIssues（窗口内旧问题替换、忽略过的不再出现）
本地层：findLocalHints 在光标前 15k / 后 3k 范围内防抖重算（600 ms），kind = "local"
渲染：grammar / consistency → deco-wavy；monotony / local → deco-band（tone 区分深浅）；光标落在问题上 → 底栏说明 + 面板卡片高亮
```

- 问题只在内存里，不落盘；`Issue.key`（类型 + 规范化引用）用于「忽略」去重
- 槽位：候选固定槽 0，纠错槽 1（`PROOFREAD_SLOT`）；`-c` 为总上下文，`/props.n_ctx` 已是单槽值
- 本地层还查**专名写法**（`findNameVariants`）：与 ≥ 3 字的角色名 / 别名同长、恰差一字、且出现次数 ≤ 正名 1/3 且 ≤ 5 的写法（莱奥拉 / 莱奥菈）

**人设校验**（同一管线，`useProofreader.runTask("consistency")`）：

```
触发：面板「校验当前窗口」/ 右键「校验这段的人设」（手动）或 consistencyAuto（纠错跑完后对同一窗口自动跑一次）
 → 同一 ProofWindow → findMaterialHits 只取 kind=character 的命中 → buildMaterialsText 拼设定卡（无命中：手动时报错、自动时跳过）
 → buildConsistencyPrompt(template, 设定卡, 窗口, noThinkPrefix) + CONSISTENCY_GRAMMAR（temperature 0.2, n_predict 320）
 → 槽 2（profile.slots ≥ 3，与纠错并行）否则槽 1（slotChainRef 每槽一条 Promise 队列，先来后到）
 → parseConsistencyFindings：角色名|引用|冲突项 / 无 → Issue{kind: consistency, message: "角色名：冲突项"}
 → mergeLlmIssues(…, kinds) 只替换窗口内同类问题：纠错结果与人设结果互不覆盖
```

### 5c. 短句展开（Expansion）

```
触发：长按取样键（settings.expandEnabled，短按仍是随机取词、改在 keyup 执行）
      或 停笔自动（settings.expandAuto：候选就绪且距最近一次操作 ≥ expandIdleMs；浮窗内 ↑↓ / 翻页也算操作、重新计时；翻到仍有未展开行的页会重新武装，已展开的页保留）
      或 右键「把候选展开为短句」
 → expander.start(候选提示词, 当前页候选[{index 全局序号, text}])
 → 逐行串行：POST /completion { prompt: 提示词 + 候选词, id_slot: 0, cache_prompt, stream: true,
      n_predict 24, temperature 0.6, top_p 0.9, repeat_penalty 1.1, stop: ，。！？；…\n }
      前缀全部命中槽 0 缓存 → 只解码；chunk 经 expand:chunk 推回，rows[index].text 原地增长
 → 行内显示 词 + 续写 + 闪烁光标；数字键 / Enter / 点击 = 插入 词 + 已流出的部分（流式中也可）
 → 任何文本 / 光标 / 候选变化 → clear()（abort → expand:cancel）；Esc 关浮窗同样清空
```

### 6. 提示词构建（promptBuilder.ts）与 ModelProfile

纯函数模块，不碰 React / DOM。

- 四种模式：`plain / outline / style / full`，对话模板来自 `PromptTemplate`（默认 ChatML；主进程按 `/props` 的 `chat_template` 与模型名识别 gemma / llama3）
- 大纲只来自**光标所在的大纲段**（`promptArgsFor`：`segmentAt` → `segmentInjects` = 有文字 ∧ 单段开 ∧ 总开关开 ∧ 光标 ≥ 段起点）；总纲 `outlineText` 只是作者备忘，永不注入
- 正文来源二选一：
  - **段起点模式**（该段正在注入）：`[段起点, cursor)` 一刀切不截断（旧锚点语义）；超 `anchorWarnLen` 提醒；超硬上限时 `anchorOffset = null` 退回滑窗、大纲照常注入（提示「新起一段大纲」），没有任何自动关开关的动作
  - **滑动窗口**：`[windowStart, cursor)`，上限 `maxBodyLen`，左边界懒推进（写够 `windowAdvanceMinChars` 且在换行后）以保护 KV cache
- 硬上限 = `contextLen − 256 − 模板/风格/大纲字数`；`contextLen = profile.contextLength ?? settings.modelContextLen`（后端就绪后以实际 `n_ctx` 为准，设置里的滑杆只作兜底）
- 段起点稳定性：`mapSegmentsThroughEdit`（偏移 0 钉死；锚在标记行上的章首段只按偏移平移、不做指纹搜索；其余走 `mapAnchorThroughEdit` 48 字指纹校验 / 全文重找）；程序化章节操作用 `remapSegments(精确映射)`
- 标记行永不送模型：候选 / 展开经 `stripChapterMarks` 整行删除；纠错窗口 `resolveProofWindow` 跳过起始标记行、窗口内标记行保持等长掩码

`ModelProfile { modelName, contextLength(每槽), slots, template, noThinkPrefix, eosTexts }` 由 `model:profile` 给出（`/props` 的 `n_ctx` + `total_slots` + `chat_template`，读不到时用 `-c ÷ --parallel`），`useBackendStatus` 在后端就绪后拉取一次并随状态缓存。`noThinkPrefix`（模板含 `<think>` 或 Qwen3.5 → `<think>\n\n</think>\n\n`）只用于指令类任务（纠错 / 校验）的 assistant 回合开头：否则有文法约束时模型会在第一个 token 坍缩成「无」。

### 7. 模型后端生命周期（main/backend.ts）

`LlamaBackend` 单例：

```
start() → readBackendConfig() 失败则 stopped
        → 杀残留进程(pid 文件) → 端口探测
        → spawn llama-server -m <model> --host 127.0.0.1 --port <port> …args
        → LoadProgressTracker.feedLine(stdout/stderr)：PHASE_MARKERS 推进 fraction；历史耗时(load-stats.json)平滑 + ETA
        → 轮询 /health 直到 200 → ready
restart() = stop() + start()；由 setup:update-device / setup:apply-config / backend:restart 显式触发
```

- `generation` 计数器：每次启动 +1，candidates.ts 据此失效 `/props` + `/tokenize` 元数据缓存
- 日志隐私：含 `slot|prompt|token` 的行不落盘；就绪 60 s 后停止磁盘日志
- 状态与进度通过 `backend:status` / `backend:progress` 广播到所有窗口
- 不再 `fs.watch` backend.json：谁改配置谁负责调 `backend.restart()`；部署期间 `backend.stop(true)` 让出显存

**backend.json 位置**：打包后 `userData/backend/backend.json`；开发时 `resources/backend.json`。`backendConfig.ts` 是唯一读写者（`readBackendConfig / writeBackendConfig / updateBackendConfig(fn)`），宽松解析（末尾逗号修复、正则抢救）也只在这里。
**数据目录** `userData/backend/`：`llama-server.log(.prev)`、`llama-server.pid`、`load-stats.json`。

### 8. 首次设置、部署与「模型与推理」面板

| 模块 | 职责 |
|------|------|
| `main/setup.ts` | `getSetupState()`：调用 `readBackendConfig`，补上 exe / model 存在性与 `needsDeviceSelection` |
| `main/catalog.ts` | 唯一的下载清单：`LLAMA_TAG`、镜像、`engineAssetsFor(kind, cuda)`、`MODEL_PRESETS`、`defaultTargetDir()`；`setup:get-catalog` 交给向导 |
| `main/hardware.ts` | CPU 拓扑、GPU / 显存、推荐 cuda/rocm/vulkan/cpu 与线程数 |
| `main/deploy.ts` | `parseDeployConfig` 校验入参；下载引擎 zip（CUDA 另加 cudart）与模型；`buildDefaultArgs(threads, contextLength)` 写 backend.json |
| `main/downloader.ts` | `downloadFile`：Range 续传、停滞超时、指数退避、跨源保留临时文件；`extractZip`：PowerShell `Expand-Archive`（参数数组传路径） |
| `components/setup/SetupWizard.tsx` | 编排 4 步：硬件 → 引擎与模型（表单 `EngineModelForm`）→ 部署进度 → 设备；`startAt="device"` 时只渲染设备整页 |
| `components/BackendSettingsPanel.tsx` | 首页弹窗：`getSetupState().existingConfig` → `splitStructuredArgs` 填表 → 编辑 exe / model / 端口 / -t / -c / --parallel / --device / 其它参数 → `composeArgs` → `setup:apply-config`；底部可「重新运行安装向导」。每槽上下文 < 4096 时拒绝保存 |

设备选择单独一步：llama.cpp 的设备名（`ROCm0 / CUDA0 / Vulkan0`）取决于编译后端，无法从操作系统推断，因此部署后运行 `llama-server --list-devices` 让用户选，`setup:update-device(id | null)` 写回（null = 移除 `--device`）并重启后端。

### 9. 设置（lib/settings.ts）

- 单对象 `SettingsValues`，分「基本」「高级」两层，UI 用两页区分
- 持久化：`localStorage['zixia-writing-settings-v3']`，读取时经 `sanitizeSettings` 收敛到合法范围
- 数值范围只写一处 `SETTING_LIMITS`，`sanitize` 与 `SettingsPanel` 的滑杆共用
- 主进程无设置；`modelContextLen` 只是后端读不到 `n_ctx` 时的兜底（面板会显示实际值）
- 纠错开关 `proofreadAuto`（默认开）/ `proofreadLocal`（默认开）/ `consistencyAuto`（随纠错校验人设，默认关）放在纠错面板里，经 `onSettingChange` 回 App 持久化
- **算力档位**（设置「基本」页顶部，`TierSetting`）：不单独存储，`detectTier()` 由 expandAuto / proofreadAuto / consistencyAuto 三项反推（都对不上 = 自定义）；点档位 = 批量写 `TIER_PRESETS[tier]`（含 expandIdleMs：高档 250 ms）。低 / 中 / 高 = 槽位 2 / 2 / 3（`TIER_SLOTS`）；高档且 `profile.slots < 3` 时提示去「模型与推理」加槽位（不自动改后端）
- 短句展开开关 `expandEnabled`（默认开，长按取样键触发）/ `expandAuto`（停笔后自动展开，默认关）+ `expandIdleMs`（停笔多久，250 ms–10 s，默认 2 s；最小档 ≈ 候选一出就展开）在设置面板「基本」页
- 字体下拉由 `listLocalCjkFonts(force?)` 现测（`FontPicker` 底部的「检测到 N 款中文字体 + 重新检测」就是它的结果；装了新字体点一下即可，不必重启）
- 名字来源三处：`CANDIDATES`（约 70 个常见中文名）、主进程 `fonts:list`（GDI+ 族名 + 注册表字体表，见 `src/main/fonts.ts`）、网页演示的 `navigator.queryLocalFonts()`；三者都只提供**候选名字**，装没装由逐像素签名判定（混排样本判存在、纯汉字样本判中文字形，与兜底像素相同的再按名字特征兜一次），指纹相同则视为同一款字体去重
- 正文观感两项：`fontSize`（16–22 px，默认 18）与 `fontFamily`（本机字体族名，默认空 = 衬线栈）。顶栏两个下拉与设置面板「基本」页改的是同一份值；字体只写进 `--editor-font-family`，不进文稿、不进提示词，界面其它文字的字体写死（见 lib/fonts.ts / components/FontPicker.tsx）
- 数值设置的可选值统一由 `numericOptions(key, current?)`（lib/settings.ts）按 `SETTING_LIMITS` 现算（min → max 按 step），顶栏字号下拉用它，改范围只动 SETTING_LIMITS 一处

### 10. CSS 架构

`index.css` 只做 `@import`，顺序即层叠顺序：`base → editor → library → settings → setup`。

- 每个文件开头有 § 目录；一个组件的规则只写在一个文件里，深色与响应式写在组件旁边
- 字号统一 `calc(Npx * var(--ui-scale))`；向导不在 `.app-root` 内，用固定像素
- 主题：`data-theme="dark"` + CSS 变量；`setup-*` 类是全局的，「模型与推理」弹窗（§ W10）复用它们
- 高亮层装饰只用三类：`.deco-anchor`（大纲段起点横线 + `data-label` 小标签，标签压在横线之上并有**不透明**底色（非当前段只把描边与字色用 `color-mix` 与纸色混淡，不能改 opacity，否则底色透出横线、横线会穿过字），`data-tone` manual / chapter / idle；横线画在段首行框顶，即上一行与本行之间的行距里，靠高亮层的 `overflow: hidden` 裁掉溢出）、`.deco-band`（单调 → 加深底色）、`.deco-wavy`（语病 → 波浪线）；上下文范围不再着色
- 右侧工作台类名：`.workbench-rail / .rail-button / .rail-badge`、面板复用 `.side-panel` + `.workbench-panel`；左栏 `.chapter-list / .chapter-item`；右键菜单 `.context-menu*`

### 11. 演示模式

`lib/platform.ts` 启动时探测一次 `window.api`：没有即 `platform.isElectron === false`，候选走 mock 词库、文库走 localStorage、模型进度走 `simulateBackendProgress`，「模型与推理」入口和原生对话框不可用（路径框仍可手填）。其它模块不再各自写 `window.api?.x`。

---

## 关键类型定义

### 共享（shared/ipc.ts，renderer 经 lib/types.ts re-export）

```ts
type PromptMode = 'plain' | 'outline' | 'style' | 'full'

interface CandidateRequest { requestId; prompt; bodyPrefix; topK; mode }
interface Candidate { text; prob; logit?; tokenId?; isEos? }

interface Anchor { offset: number; fingerprint: string }
interface OutlineSegment { id; anchor: Anchor; text; inject }
interface DocumentPayload { title; content; styleText; outlineText(总纲备忘); styleEnabled; outlineEnabled(注入大纲段总开关); outlineSegments?: OutlineSegment[]; anchor: Anchor | null(旧); chapterOutlines?(旧); materials?: Materials }
// outlineSegments 缺席（≤ v4 旁车）→ renderer `migrateLegacyOutline`：chapterOutlines[标题] → 章首段；无章节文稿的总纲 → 第一段（起点 = 旧锚点段落或 0）；孤儿分章大纲并入总纲备忘

type LibraryFormat = 'txt' | 'md' | 'docx'
interface BookRef { id; title; volume }                       // volume 从 0 起
interface LibraryEntry { id; title; excerpt; sourceFormat; characterCount; updatedAt; interactedAt; book?: BookRef }

// shared/materials.ts
interface CharacterCard { id; name; aliases; group: 'main'|'minor'; background; personality; appearance; extra: {label,text}[]; inject }
interface LoreEntry { id; name; aliases; category: 'place'|'org'|'item'|'other'; text; inject }
interface Materials { characters: CharacterCard[]; lore: LoreEntry[] }
interface LibraryDirectory { path; isDefault }

interface BackendConfig { exe; model; port; args: string[]; startupTimeoutSec }
interface SetupState { configured; configPath; problem?; message; existingConfig?; needsDeviceSelection? }
interface SetupCatalog { engineTag; models: ModelPreset[]; defaultTargetDir; defaultContextLength }
interface DeployConfig { targetDir; backendKind; cudaVersion?; modelUrl; localModelPath?; localExePath?; threads; contextLength? }
interface ChoosePathOptions { type: 'file' | 'directory'; title?; defaultPath?; extensions?; extensionsLabel? }
interface HardwareReport { cpu; ramBytes; gpus; nvidiaDriverVersion; recommendation; warnings }
interface BackendDeviceInfo { id; name; vramBytes; freeVramBytes }
interface DownloadProgress { filename; receivedBytes; totalBytes; overallFraction? }

type BackendState = 'stopped' | 'starting' | 'loading' | 'ready' | 'error'   // 主进程
type UiBackendStatus = 'stopped' | 'loading' | 'ready' | 'error'             // 前端（preload 折叠）
interface BackendProgress { fraction; summary; etaSeconds?; prefillTokensPerSecond? }
```

### 模型画像（shared/modelProfile.ts）

```ts
interface PromptTemplate { id: 'chatml' | 'gemma' | 'llama3'; systemOpen; systemClose; userOpen; userClose; assistantOpen }
interface ModelProfile { modelName; contextLength: number | null /* 每槽 */; slots: number; template: PromptTemplate; noThinkPrefix: string; eosTexts: string[] }
// 通用补全（shared/ipc.ts）
interface CompletionRequest { requestId; prompt; idSlot; nPredict; temperature?; topP?; stop?; grammar? }
interface CompletionResult { text; stopType: 'eos' | 'limit' | 'word' | 'cancelled'; stopWord?; timings? }
// 纠错（lib/proofread.ts）
interface Issue { id; kind: 'grammar' | 'monotony' | 'consistency' | 'local'; source: 'llm' | 'local'; ranges: {start,end}[]; quote; message; suggestion?; key }
```

### renderer 专有（lib/types.ts）

`SelectionRange`、`EditorSnapshot`、`ContextState`、`SaveStatus`、`Theme`、`CandidateProvider`、`WriterApi = NonNullable<Window["api"]>`。

---

## 状态管理

### 启动阶段（Bootstrap.tsx）

```ts
type BootPhase =
  | { kind: 'checking' }
  | { kind: 'setup'; state: SetupState | null; error?: string }
  | { kind: 'deviceSetup'; state: SetupState }
  | { kind: 'app' }
```

### 文库阶段（App.tsx）

```ts
const [settings, setSettings] = useState<SettingsValues>(() => loadSettings(SETTINGS_KEY))
const [entries, setEntries] = useState<LibraryEntry[]>([])
const [directory, setDirectory] = useState<LibraryDirectory>(…)
const [active, setActive] = useState<ActiveManuscript | null>(null)   // 非空即挂载编辑器
const [backendSettingsOpen, setBackendSettingsOpen] = useState(false) // 「模型与推理」弹窗
```

`candidateSource` 与 `libraryProvider` 在模块顶层各选一次。

### 编辑器阶段（WritingEditor.tsx）

```ts
// 文稿
const [title]; const [content]; const [selection]; const [context] = useState<ContextState>(…)
// 候选
const [candidateList]; const [globalIndex]; const [candidateOpen]; const [candidateLoading]
const [candidateError]; const [candidateNotice]; const [peekActive]
// 抽出去的
const scheduler = useState(() => new CandidateScheduler(supportsCancel))   // C 段
const { saveStatus, markDirty, save, saveRef } = useVersionedSave(persist) // E 段
const history = useEditHistory(() => snapshot)                            // D 段
// 滑窗
const windowStartRef / writtenSinceUpdateRef
// 纠错 + 人设校验（lib/useProofreader.ts 内部）：llmIssues / localIssues / status / consistencyStatus + windowStartRef / writtenRef / dismissedRef / pendingSpansRef(按任务) / slotChainRef(按槽位)
const proofreader = useProofreader(…)
```

### 模型状态（lib/useBackendStatus.ts）

模块级 store（`cached` + `listeners`，组件用 `useSyncExternalStore` 订阅）：首页与编辑器共用一份 `{status, progress, profile}`，切页不丢「已就绪」、演示进度不重播；首个订阅者启动 preload 订阅，最后一个离开时退订。

---

## IPC 通信

三张表都在 `shared/ipc.ts`；主进程 `handle()` / preload `invoke()` 都按表取类型。

### invoke / handle（IpcInvokeMap）

| 通道 | 用途 | 实现 |
|------|------|------|
| `setup:get-state` | 读取配置状态 | setup.ts |
| `setup:get-catalog` | 下载清单 / 默认目录 / 默认上下文 | catalog.ts |
| `setup:detect-hardware` | 硬件检测 | hardware.ts |
| `setup:list-devices` | 运行 `--list-devices` | devices.ts |
| `setup:update-device` | 写 / 移除 `--device` 并重启后端 | index.ts → backendConfig.ts |
| `setup:apply-config` | 整体替换 backend.json 并重启后端 | index.ts → backendConfig.ts |
| `setup:deploy` | 下载 / 解压 / 写配置（可取消） | deploy.ts |
| `dialog:choose-path` | 系统文件 / 目录选择对话框 | index.ts |
| `backend:get-status` / `backend:get-progress` | 查询状态 / 进度 | backend.ts |
| `backend:restart` | stop + start | backend.ts |
| `backend:open-log` | 在资源管理器定位日志 | backend.ts |
| `model:profile` | ModelProfile（上下文长度 / 模板 / EOS 表） | candidates.ts |
| `candidates:get` | 请求候选 | candidates.ts |
| `llm:complete` | 通用一次性补全（纠错等后台任务，槽 1） | llm.ts |
| `expand:start` | 流式短句展开（槽 0），结束时 resolve 完整结果 | expand.ts |
| `doc:save-as` | 导出 TXT 副本 | documents.ts |
| `library:list / read / create / save / rename / delete / touch` | 文库 CRUD | library.ts |
| `library:create-book / create-volume / rename-book / convert-to-book / convert-to-standalone` | 长篇与卷 | library.ts |
| `library:directory / choose-directory / reset-directory` | 文库目录 | library.ts |

### send（IpcSendMap，renderer → main）

`candidates:cancel(requestId)`、`llm:cancel(requestId)`、`expand:cancel(requestId)`、`setup:cancel-deploy`、`app:flush-done`

### 推送（IpcPushMap，main → renderer）

`expand:chunk`、`backend:status`、`backend:progress`、`setup:progress`、`app:flush`

### 关窗保护

`win.on('close')` → 发 `app:flush` → 等 `app:flush-done`（最多 5 s）→ 等两条写入队列空闲（最多 3 s）→ 真正关窗。
应答方只有一个：Bootstrap 的 `installFlushBridge()`；编辑器把保存函数 `registerFlusher()` 进去，首页 / 向导阶段没有登记者则立即应答。

---

## 构建与开发

```bash
npm run dev            # electron-vite dev（读取 resources/backend.json）
npm run typecheck      # tsc：node（main/preload/shared）+ web（renderer/shared）
npm run lint           # eslint（renderer 关闭 explicit-function-return-type）
npm run build          # typecheck + electron-vite build → out/
npm run build:win      # build + electron-builder --win（NSIS，x64）
npm run build:unpack   # 仅解包目录，不打安装包
npm run start          # electron-vite preview
```

- 只支持 Windows：硬件检测、设备枚举、解压全部依赖 PowerShell / WMI；`build:mac` / `build:linux` 已删除
- 安装包不含 llama-server 与模型；`resources/backend.json` 被 electron-builder 排除
- 打包后用户数据：`%APPDATA%/pickword/`（backend.json、日志、library-config.json）；文稿默认在 `文档/PickWord/manuscripts`

---

## 文件选择指南

**未来 AI agent 应根据任务选择性读取以下文件**：

| 任务 | 需要读取的文件 |
|------|----------------|
| 修改启动流程 / 向导门控 | `Bootstrap.tsx`, `main/setup.ts`, `shared/ipc.ts`（SetupState） |
| 修改向导 UI | `components/setup/SetupWizard.tsx` + 对应 `steps/*`, `styles/setup.css` |
| 换 llama.cpp 版本 / 加模型 / 改镜像 | `main/catalog.ts`（只此一处） |
| 修改「模型与推理」面板 | `components/BackendSettingsPanel.tsx`, `shared/backendArgs.ts` |
| 修改 backend.json 格式 / 校验 | `main/backendConfig.ts`, `shared/ipc.ts`（BackendConfig）, `shared/backendArgs.ts` |
| 修改硬件检测 / 推荐 | `main/hardware.ts` |
| 修改下载 / 部署 | `main/deploy.ts`, `main/downloader.ts` |
| 修改模型启动 / 进度估算 | `main/backend.ts`, `main/loadProgress.ts` |
| 新增模型家族（模板 / EOS） | `shared/modelProfile.ts`, `main/candidates.ts`（detect） |
| 修改候选生成（后端侧） | `main/candidates.ts` |
| 修改纠错（提示词 / 文法 / 定位 / 本地规则） | `lib/proofread.ts`, `lib/monotony.ts`, `lib/useProofreader.ts`, `components/workbench/ProofreadTab.tsx`, `main/llm.ts` |
| 修改短句展开（采样 / 停止符 / 触发 / 行内渲染） | `lib/expansion.ts`, `lib/useExpander.ts`, `WritingEditor.tsx` C、G 段, `components/CandidatePopover.tsx`, `main/expand.ts` |
| 修改并行槽位 / 上下文分配 | `shared/backendArgs.ts`（DEFAULT_SLOTS）, `main/candidates.ts`（discoverMeta）, `BackendSettingsPanel.tsx` |
| 修改候选流控 / 后处理 | `lib/candidateScheduler.ts`, `lib/candidatePostprocess.ts`, `lib/candidateDiversity.ts`, `WritingEditor.tsx` C 段 |
| 修改候选浮层 / 定位 | `components/CandidatePopover.tsx`, `lib/editorText.ts`（measureCaretPoint） |
| 修改提示词 / 上下文策略 | `lib/promptBuilder.ts`, `WritingEditor.tsx` A、B 段 |
| 修改大纲段（布局 / 注入规则 / 迁移 / 面板） | `lib/outline.ts`, `WritingEditor.tsx` A、I 段, `components/workbench/OutlineTab.tsx`, `ContextTab.tsx`, `main/library.ts`（旁车 v5） |
| 修改段起点映射 / 撤销 / 文本写入 | `lib/editorText.ts`, `lib/outline.ts`, `lib/useEditHistory.ts`, `WritingEditor.tsx` D 段 |
| 修改保存 / 导出 / 关窗落盘 | `lib/useVersionedSave.ts`, `lib/flushRegistry.ts`, `WritingEditor.tsx` E 段, `main/library.ts`, `main/documents.ts` |
| 修改输入法 / 键盘 | `WritingEditor.tsx` F、G 段 |
| 修改文库逻辑 | `App.tsx`, `components/LibraryHome.tsx`, `lib/library.ts`, `main/library.ts` |
| 修改文件导入 / 路径选择 | `lib/openFile.ts`, `lib/pathPicker.ts`, `App.tsx` importManuscripts |
| 修改设置 | `lib/settings.ts`（SETTING_LIMITS）, `components/SettingsPanel.tsx`, `App.tsx` resetAdvanced |
| 修改正文字体 / 字号 | `lib/fonts.ts`（探测与字体栈）, `components/FontPicker.tsx`（顶栏控件）, `styles/editor.css` §E1/E2（`--editor-font-family` 与工具栏浮层） |
| 新增 IPC 通道 | `shared/ipc.ts`（三张表）→ `main/index.ts` handle → `preload/index.ts` api → 调用处 |
| 修改样式 | 对应 `styles/*.css`（先看文件头 § 目录） |

---

## 已知问题与限制

审计记录与处理结果见 `report.md`。

1. **无测试**：`promptBuilder`、`editorText`、`candidateDiversity`、`candidatePostprocess`、`backendArgs`、`downloader` 均为纯逻辑但无单测。
2. **WritingEditor 仍有约 2100 行**：IME、键盘、文本写入三段仍交织在组件内（纠错逻辑已抽到 `useProofreader`）。
6. **纠错依赖 ≥ 2 个槽位**：旧配置（`--parallel 1`）下面板提示去「模型与推理」改；`-c` 为总上下文，开 2 槽位要相应翻倍。
3. **只支持 Windows**：主进程多处 PowerShell / WMI / `tasklist`，不是平台抽象的问题而是产品定位。
4. **ModelProfile 的模板识别是启发式**：靠 `chat_template` 关键字与模型名，新模型家族需要在 `shared/modelProfile.ts` 加分支。
5. **演示模式无法选路径**：浏览器拿不到绝对路径，向导 / 面板的「浏览」按钮在纯浏览器下无效，需要手填。

---

## 维护清单

- [ ] 为 `promptBuilder.ts`、`editorText.ts`、`candidateDiversity.ts`、`candidatePostprocess.ts`、`backendArgs.ts` 添加单元测试
- [ ] 继续拆 WritingEditor：IME + 键盘处理（F、G 段）可抽成 `useEditorKeyboard`
- [ ] ModelProfile 增加对更多模板（Mistral / DeepSeek）的识别
- [ ] 右键菜单「立即取候选」（plan.md §2.6 里剩下的一项）
- [ ] 人设校验在真机上的行格式 / 误报率调校（与纠错同样的「一律回无」检查步骤见文首）
- [ ] 可选：长按数字键只展开那一行（一次解码）

---

*本文档基于 commit 7689b52 之后的重构代码状态生成。最后更新：2026-10-14*
