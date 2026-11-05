# PickWord 项目结构与维护指南

## ⚠ 提示词与约束解码：修改前必读

### 典型故障：纠错把明显病句判成「无」

纠错首版在 Qwen3.5-9B Q4 上对明显问题只输出「无」。日志显示 `predicted_n=2`、`stop=eos`：模型在开始读正文前就结束了。这不是单纯的模型能力或 GBNF 语法问题，而是 assistant 回合前缀与约束解码不匹配：底模在 `enable_thinking=false` 时会先输出空思考块 `<think>\n\n</think>\n\n`；若提示词停在 `assistantOpen`，而文法只允许「无」或问题行，模型自然想输出的 `<think>` 就被禁止。「无」成为少数可以立即结束的短输出之一。

### 当前不变量

- `shared/modelProfile.ts` 的 `detectNoThinkPrefix()` 为相应模板/模型提供 `NO_THINK_PREFIX`。
- 候选续写、纠错、短句展开三条链路必须保持 assistant 回合前缀一致；短句展开复用续写提示词。
- 训练样本的回合格式需与运行时逐字节一致，包括 `assistantOpen` 后的空思考块、大纲、`正文：\n` 等前导文本及换行。约束解码只会重新分配合法 token 的概率，不能弥补训练与推理格式错位。
- 遇到模型反复输出同一个短答案，先核对 `predicted_n`、模型原话和实际 prompt 的字节级结构，再判断模型能力。
- 设计 GBNF 时，避免让单 token 的「无」成为明显更容易的提前退出分支；需要时平衡样本比例，或让所有合法答案先输出共同的非平凡前缀。

改动提示词/窗口/素材处理后运行 `npm run probe`，人工检查探针打印出的实际字符串；不要只凭 UI 或提示词模板猜测最终发给模型的内容。

---

## 项目概览

PickWord 是 Windows x64 本地写作助手。Electron 主进程启动本机 `llama-server`；React 编辑器把光标前的正文与可选上下文拼成 prompt，显示多个下一个 token 候选供作者选择。另有文库、章节、大纲、角色/设定卡、纠错与短句展开。

- **技术栈：** Electron 39、electron-vite 5、TypeScript 5.9、React 19、Vite 7、原生 CSS。
- **推理后端：** 独立的 llama.cpp `llama-server` 子进程；模型和引擎不随安装包分发。
- **平台：** Windows 10/11 x64。硬件检测、设备枚举和解压依赖 PowerShell/WMI 等 Windows 能力。
- **依赖边界：** Electron Toolkit 是 npm 运行依赖；React/Vite 等参与 renderer 构建；llama-server 与模型是外部本地资源。

## 目录结构

```text
PickWord/
├── package.json                 # 版本、脚本及依赖；npm run probe 为提示词探针入口
├── package-lock.json
├── electron.vite.config.ts      # main / preload / renderer 构建配置
├── electron-builder.yml         # Windows x64 NSIS 打包，排除 resources/backend.json
├── tsconfig*.json               # main/node 与 renderer/web 两套 TypeScript 检查
├── .gitignore
├── README.md                    # 用户安装与功能说明
├── structure.md                 # 本文：架构、数据流、文件导航
├── report.md                    # 静态审计发现与后续验证记录
├── resources/
│   ├── backend.json             # 开发用后端配置；不应保存/提交个人机器路径
│   └── icon.png
├── build/                       # 安装包图标和打包资源
├── scripts/
│   ├── prompt-probe/            # 只读提示词/窗口/本地规则探针，不进入安装包
│   └── vite.preview.config.mjs  # 浏览器演示预览，无 Electron
└── src/
    ├── shared/                  # 跨进程类型与纯函数
    │   ├── ipc.ts               # IPC 入参、返回值、推送载荷的通道类型表
    │   ├── modelProfile.ts      # PromptTemplate、模型画像、EOS/隐藏标记、空思考前缀
    │   ├── backendArgs.ts       # llama-server 参数解析、校验、组合与默认值
    │   ├── materials.ts         # 角色/设定及大纲旧格式的宽松解析
    │   ├── text.ts              # 字数、摘要、安全文件名等文本工具
    │   └── types.ts
    ├── main/                    # Electron 主进程：系统 I/O、后端及 IPC 实现
    │   ├── index.ts             # 窗口、安全设置、类型化 IPC 注册、关窗 flush
    │   ├── backendConfig.ts     # backend.json 唯一读写者；解析、校验、原子写
    │   ├── setup.ts             # 首次设置状态与配置有效性
    │   ├── catalog.ts           # llama.cpp 资产、模型预设、镜像、默认目录
    │   ├── hardware.ts          # CPU/GPU/内存检测与运行后端推荐
    │   ├── devices.ts           # llama-server --list-devices 输出解析
    │   ├── deploy.ts            # 部署编排：引擎/模型下载、解压、配置写入
    │   ├── downloader.ts        # 断点续传、重试、进度广播、PowerShell 解压
    │   ├── backend.ts           # llama-server 生命周期、健康检查、日志与状态
    │   ├── loadProgress.ts      # 加载阶段、历史耗时平滑与 ETA
    │   ├── candidates.ts        # 槽 0 候选生成、模型画像与候选过滤
    │   ├── llm.ts               # 一次性 completion（纠错等槽 1 后台任务）
    │   ├── expand.ts            # 槽 0 流式短句展开
    │   ├── sse.ts               # SSE 流解析
    │   ├── library.ts           # 文库/书卷文件读写、迁移与索引
    │   ├── documents.ts         # TXT 副本导出
    │   ├── fonts.ts             # Windows 字体枚举
    │   ├── updater.ts           # Release 检查、受限下载与已验证安装包启动
    │   └── ioUtils.ts           # 原子写、串行队列、输入校验与文件名工具
    ├── preload/
    │   ├── index.ts             # 显式 API；封装 invoke/send/on 后经 contextBridge 暴露
    │   └── index.d.ts           # Window.api 类型声明
    └── renderer/
        ├── index.html
        ├── public/brand/
        └── src/
            ├── main.tsx         # React 入口
            ├── Bootstrap.tsx    # 启动门控、设置向导及关窗保存桥接
            ├── App.tsx          # 文库首页、设置、活动文稿与面板编排
            ├── WritingEditor.tsx # 单卷编辑器；单页/双页、IME、文本更新与交互编排
            ├── workers/
            │   └── search.worker.ts # Web Worker：分块扫描全文查找，结果偏移转移回主线程
            ├── components/
            │   ├── setup/        # 当前设置向导、步骤组件、设备选择与表单
            │   ├── workbench/    # 上下文/大纲/角色/设定/纠错面板
            │   ├── LibraryHome.tsx
            │   ├── BackendSettingsPanel.tsx
            │   ├── SettingsPanel.tsx
            │   ├── CandidatePopover.tsx
            │   ├── ChapterPanel.tsx / ChapterTitleField.tsx
            │   ├── SearchPanel.tsx / ContextMenu.tsx
            │   ├── BackendStatusBar.tsx / UpdateDialog.tsx
            │   └── 其余 UI 组件（字体、图标、onboarding 等）
            ├── lib/              # 纯逻辑、数据源与 React hooks
            │   ├── contentEditable.ts # 双页纯文本编辑 DOM ↔ UTF-16 正文偏移/选区映射
            │   ├── pagination.ts      # 页切片、双页分组与编辑后的脏页增量重排
            │   ├── useSearchWorker.ts # 查找 Worker 生命周期、防抖、请求过期与结果管理
            │   ├── editorText.ts      # 编辑差分、光标/查找偏移与锚点映射
            │   ├── chapters.ts       # 章节索引与正文编辑后的增量更新
            │   └── useEditHistory.ts / useVersionedSave.ts # 差分撤销与版本化保存
            ├── styles/           # base/editor/library/settings/setup 五份 CSS
            └── utils/            # UI 小工具
```

当前只保留一个设置向导实现：`components/setup/SetupWizard.tsx`。根目录旧版 `components/SetupWizard.tsx` 与旧侧栏 `ContextSidebar.tsx` 已确认无引用，属于被模块化工作台/向导替代的重构残留，已移除。当前功能分别由 `components/setup/*`、`components/workbench/*` 和 `WritingEditor.tsx` 承担。

## 进程边界与数据流

### Main / preload / renderer

- **Main：** 操作文件系统、系统对话框、子进程、下载与 Windows 硬件接口；本地模型 HTTP 请求由主进程转发。
- **Preload：** 只暴露 `src/preload/index.ts` 中列出的窄接口；不暴露完整 `ipcRenderer`。`WriterApi` 从 preload API 对象推导。
- **Renderer：** 编辑器 UI、prompt 拼接、候选重排/显示、设置与文库界面。
- **Shared：** 两端共用的数据结构和纯函数；不依赖 Electron 或 DOM。
- `shared/ipc.ts` 是 IPC 类型的清单，但 TypeScript 类型不会验证运行时数据。主进程处理不可信载荷时仍需运行时校验。
- BrowserWindow 使用 `contextIsolation: true`、`nodeIntegration: false`；生产环境阻止页面导航；IPC handler 限定主窗口 webContents。

### 启动门控

`main.tsx → Bootstrap → getSetupState()`：

1. 浏览器演示环境无 preload，进入 `App` 的 mock/localStorage 数据源。
2. 未配置、配置损坏或模型/引擎丢失时，显示 `components/setup/SetupWizard.tsx`。
3. 配置有效但缺设备选择时，向导从设备步骤开始。
4. 配置可用时进入 `App`；主进程仅在 backend 配置有效时启动 llama-server。

`Bootstrap` 安装一次 `installFlushBridge()`。编辑器通过 `flushRegistry` 注册保存函数；关窗时主进程请求 flush，等待前端确认并等待 I/O 队列空闲后再关闭。

### 候选、纠错与展开

- **候选：** `WritingEditor → promptBuilder → candidateScheduler/provider → IPC candidates:get → main/candidates → 本机 /completion`。固定使用槽 0；renderer 做竞态检查、EOS 处理、概率软化和多样化，再交给 `CandidatePopover`。`main/candidates.ts` 候选请求设置 `n_probs`，并显式关闭 `speculative.type`：llama.cpp b8868 的 speculative 解码分支尚未填充 token 概率，故无法构造 `completion_probabilities`。无输出 / EOS 且无概率字段时仍有限重试一次；最终错误携带请求与响应概率参数及停止元数据。
- **纠错：** `useProofreader → proofread.ts` 选择窗口并构造提示词/GBNF → `llm:complete → main/llm.ts`，使用槽 1。结果通过引用定位到正文区间；本地单调/专名提示在 `monotony.ts` 运行，不依赖模型。
- **短句展开：** `useExpander → expansion.ts → expand:start → main/expand.ts`，复用候选提示词并使用槽 0 流式逐条展开。
- 人物与设定卡仅用于本地窗口命中、提及计数及面板展示；不注入模型提示词。
- `ModelProfile` 从 llama-server `/props` 获取模板、上下文长度、槽位和 EOS 信息；模板/模型家族识别是启发式，增加家族时改 `shared/modelProfile.ts` 与 `main/candidates.ts`。

## 文稿与文库

主进程 `main/library.ts` 是 Electron 文库的文件 I/O 唯一归属；renderer `lib/library.ts` 提供 provider 接口和浏览器演示存储。

```text
<文库>/
├── <短篇标题>.txt
├── <短篇标题>.writer.json
└── <书名>/
    ├── book.json
    ├── <书名>_0卷.txt
    └── <书名>_0卷.writer.json
```

- 短篇正文与 `.writer.json` 旁车配对；旁车保存 UUID、标题、风格、大纲段、素材及列表摘要缓存。
- 长篇以子目录为单位；`book.json` 保存全书共用风格与角色/设定，卷旁车保存卷级内容。卷文件编号从 0 开始。
- 物理文件名可以随标题重命名，文稿 ID 保持不变；文库写入走串行队列与原子写，删除走系统回收站。
- 章节标记为正文中的 `--标题--` 行；提示词构建阶段会剔除，纠错阶段会屏蔽。
- 打包后文库默认在“文档/PickWord/manuscripts”；配置在 `userData/library-config.json`。backend 配置和日志位于 `userData/backend/`。

## 提示词构建与模型画像

`lib/promptBuilder.ts` 是纯函数模块，按 `plain / outline / style / full` 模式组合模板和正文：

- assistant 回合由 `PromptTemplate.assistantOpen + noThinkPrefix + …` 开始；三条模型链路必须遵守文首的不变量。
- 大纲只注入光标所在、启用的 `OutlineSegment`；总纲是作者备忘，不注入。
- 正文按大纲段锚点或滑动窗口截取；上下文长度以模型实际每槽 `n_ctx` 为准，扣除模板及指令开销。
- 章节标记行不发送给模型；`BuiltPrompt.bodyChars` 是剔除标记行后的实际正文长度。
- 人物/设定素材不属于 prompt 参数。
- `outline.ts` 维护段布局、锚点映射、编辑后的段起点迁移及旧旁车格式迁移；章节索引/重编号在 `chapters.ts`。

## 下载、配置与更新

- `catalog.ts` 集中维护 llama.cpp tag、预设资产、镜像和默认目录。
- `deploy.ts` 校验部署参数，协调引擎/模型下载、解压和 `backend.json` 写入；`downloader.ts` 提供取消、续传、重试和进度。
- `backendArgs.ts` 是参数表结构化读写的共用逻辑；`backendConfig.ts` 是配置文件唯一读写者。配置变更后由调用入口显式重启后端。
- `updater.ts` 从固定 GitHub 仓库读取 release，使用原镜像优先顺序下载。renderer 不提供下载 URL、版本号或可执行文件路径；主进程只安装其检查并下载的更新包，限制更新目录，并检查资产大小及 API 提供时的 SHA-256。NSIS 静默安装与应用内进度/提示流程由此模块和 `UpdateDialog`/`useUpdater` 配合。
- 当 Release API 不提供 digest 时，没有独立代码签名校验；正式发布应考虑签名/强制 checksum。
- **部署输入仍需安全校验：** 模型 URL 的文件名必须经安全化并验证目标目录边界；不要将 URL 解码后的名称直接用于路径拼接。

## 工作台与编辑器模块

- `WritingEditor.tsx` 仍是较大的单体组件（本轮审阅时约 **2.75k 行**）：负责编辑器组装、IME/键盘、文本变更、双页 DOM 协调和多项面板交互；不要把它描述成已完成拆分。
- **正文与保存的唯一事实来源是纯文本**：单页使用 `textarea`，双页使用 `contentEditable="plaintext-only"`；页切片 / spread 仅是呈现层，分页边界不会写入文稿。`contentEditable.ts` 负责正文 DOM 提取及全局 UTF-16 选区偏移映射，保存仍从完整正文 state/ref 读入。
- **双页排版路径：** `pagination.ts` 按页面指标分页；每个 spread 含两张左右并排纸页，spread 组按纵向顺序排列。正文编辑时从脏页所在段落开始增量重排，前方未变页切片复用；`WritingEditor` 在 `useLayoutEffect` 中直接逐页协调编辑 DOM（不要同时给 `pagedEditorRef` 容器添加 React 子节点），并按页缓存装饰分段。超长单段落采用小块测量与码点遍历，但重分页仍在 renderer 主线程同步执行。
- 当前双页使用 CSS `content-visibility: auto`，**尚未做视口 DOM 虚拟化**：所有正文页仍挂载，不能把屏外绘制优化等同于减少 DOM 节点。窗口尺寸变化采用 120 ms trailing debounce；字体/版式指标变化仍会触发重分页。
- **查找路径：** `useSearchWorker.ts` 在查找面板开启时通过 Vite 打包的 `workers/search.worker.ts` 扫描全文；查询防抖、分块让出并取消过期请求，偏移用 `Uint32Array` 传回。正文仅在变化时发送；结果无上限，`SearchPanel.tsx` 每次只渲染 75 条。
- 普通文本编辑会增量更新字数与章节索引（`shared/text.ts`、`chapters.ts`）；撤销/重做由 `useEditHistory.ts` 保存差分帧，`useVersionedSave.ts` 用版本号协调自动 / 手动保存，`flushRegistry.ts` 管理关窗落盘。
- `editorText.ts` 提供编辑差分、光标 / 查找偏移与锚点映射；`decorations.ts` 把大纲锚点、纠错和本地提示转换为文本装饰。
- `components/workbench/Workbench.tsx` 分发右侧工作台 tab：`ContextTab`、`OutlineTab`、`CharactersTab`、`LoreTab`、`ProofreadTab`。
- CSS 入口 `src/renderer/src/index.css` 只按 `base → editor → library → settings → setup` 顺序导入五份样式。

### 本轮简要架构审计

1. **边界较清晰：** Electron I/O 仍位于 main，preload 暴露窄 API；分页、编辑偏移及搜索逻辑各有独立模块，renderer 没有因此直接接触 Node 文件系统。
2. **正文一致性约束：** 双页编辑偏移和分页区间使用 UTF-16；DOM 提取必须忽略 spread/page 包装节点和空白页。改动 `contentEditable.ts`、页同步逻辑或搜索偏移时，应验证 emoji/代理对、跨页选择、撤销和保存纯文本一致。
3. **主线程剩余热点：** 长文双页每次输入仍需同步更新 React 状态及脏页之后的分页 / 页高亮；超长单段落可能重排很大范围。搜索已转 Worker，但全量结果数组和渲染器接收 / 展示仍占内存与主线程时间。
4. **明确的未实现项：** 页面虚拟化尚未实现；没有自动化 DOM/Electron 回归测试或真实输入延迟 / 帧率数据。纯函数基准只能用于对比算法，不作 UI 流畅度保证。
5. **可维护性：** `WritingEditor.tsx` 仍承载较多编排责任；后续若拆分，先抽取状态转换 / hooks 与页同步控制器，保持 `content` 为唯一保存文本，避免把分页 DOM 当作持久化格式。
- CSS 入口 `src/renderer/src/index.css` 只按 `base → editor → library → settings → setup` 顺序导入五份样式。

## 提示词探针

`npm run probe` 打包并执行 `scripts/prompt-probe/index.ts`。四组探针覆盖：

| 文件 | 检查内容 |
|---|---|
| `probe-prompt.ts` | 续写/纠错 prompt 字面量、空思考块、章节标记与素材边界、bodyChars |
| `probe-window.ts` | 纠错窗口、面板命中范围和章节标记掩码 |
| `probe-materials.ts` | 角色/设定候选提取、别名、提及计数和卡片结构 |
| `probe-local.ts` | 本地重复、段落开头单调和专名变体规则 |

探针是**供人工审阅提示词和纯逻辑的只读开发工具**，不是应用运行测试，也不进入安装包。它们不属于 `tsconfig` 的 `src/**` 检查范围；改完提示词相关代码后应运行 `npm run probe` 并逐项核对。

## 构建、开发与预览

```bash
npm ci
npm run dev                # Electron 桌面开发模式
npm run probe              # 提示词/纯逻辑探针
npm run typecheck          # main/preload/shared + renderer/shared
npm run lint               # ESLint；探针脚本也在 lint 范围内
npm run build              # typecheck + electron-vite build
npm run build:win          # Windows x64 NSIS 安装包
npm run build:unpack       # 解包目录，不创建安装器
npm run start              # electron-vite 预览构建结果
```

沙盒浏览器演示可单独运行 `npx vite --config scripts/vite.preview.config.mjs`；它不等同于 Electron 桌面运行。安装包不含 llama-server、模型权重和开发机 `resources/backend.json`。

## 文件导航

| 工作 | 主要文件 |
|---|---|
| 启动门控/设置向导 | `Bootstrap.tsx`、`main/setup.ts`、`components/setup/SetupWizard.tsx`、`shared/ipc.ts` |
| 模型与推理设置 | `BackendSettingsPanel.tsx`、`shared/backendArgs.ts`、`main/backendConfig.ts` |
| 硬件推荐/部署/下载 | `main/hardware.ts`、`main/catalog.ts`、`main/deploy.ts`、`main/downloader.ts` |
| 后端启动/进度/设备 | `main/backend.ts`、`main/loadProgress.ts`、`main/devices.ts` |
| 更新 | `main/updater.ts`、`lib/useUpdater.ts`、`components/UpdateDialog.tsx`、IPC 表与 preload |
| 提示词/模型模板 | `lib/promptBuilder.ts`、`shared/modelProfile.ts`、`scripts/prompt-probe/` |
| 候选生成与重排 | `main/candidates.ts`、`lib/candidateProvider.ts`、`lib/candidateScheduler.ts`、`lib/candidatePostprocess.ts`、`lib/candidateDiversity.ts` |
| 纠错/本地提示 | `lib/proofread.ts`、`lib/monotony.ts`、`lib/useProofreader.ts`、`main/llm.ts`、`ProofreadTab.tsx` |
| 短句展开 | `lib/expansion.ts`、`lib/useExpander.ts`、`main/expand.ts`、候选浮层 |
| 大纲/章节/锚点 | `lib/outline.ts`、`lib/chapters.ts`、`lib/editorText.ts`、`OutlineTab.tsx`、`ChapterPanel.tsx` |
| 单页/双页正文映射与分页 | `WritingEditor.tsx`、`lib/contentEditable.ts`、`lib/pagination.ts`、`lib/decorations.ts`、`styles/editor.css` |
| 全文查找与结果分页 | `lib/useSearchWorker.ts`、`workers/search.worker.ts`、`components/SearchPanel.tsx` |
| 文库/文件导入/导出 | `main/library.ts`、`lib/library.ts`、`lib/openFile.ts`、`main/documents.ts` |
| 保存/撤销/关窗 | `lib/useVersionedSave.ts`、`lib/useEditHistory.ts`、`lib/flushRegistry.ts`、`Bootstrap.tsx` |
| 设置/字体/样式 | `lib/settings.ts`、`components/SettingsPanel.tsx`、`lib/fonts.ts`、`components/FontPicker.tsx`、`styles/*.css` |
| 新增 IPC | `shared/ipc.ts` → `main/index.ts` handler → `preload/index.ts` API → renderer 调用处 |

## 已知边界

- 仅支持 Windows；硬件推荐是启发式，不是 GPU/模型兼容保证。
- `ModelProfile` 模板家族识别基于 `/props` 字段和模型名关键词；新家族需用探针和实机模型验证。
- 没有自动化单元测试套件。探针用于审阅纯函数输出，不覆盖 IPC、文件系统、安装器或 Windows 设备集成。
- `WritingEditor.tsx` 仍集中较多 IME、键盘和文本写入逻辑，后续可继续拆分，但需维持编辑偏移、大纲锚点、撤销栈和保存状态的一致性。
- 更新包如果没有可用的 GitHub SHA-256 digest，仍缺独立签名验证。

---

*本文只描述当前目录、职责和稳定的维护约束；功能变更历史请看 README/release notes，审计问题与处理情况请看 `report.md`。*
