# PickWord 项目架构参考

## 项目概览

PickWord（子夜写作）是一个基于 Electron + React + TypeScript 的写作助手桌面应用。核心功能是通过本地 LLM（大语言模型）为作者提供智能候选词建议。

**技术栈**：
- Electron 39 + TypeScript 5.9
- React 18 + Vite 7（renderer）
- CSS 全局样式（无框架）
- Tailwind CSS 4（仅 demo/index.html）
- mammoth.js（docx 解析）
- jszip（docx 保存）

**代码规模**：~9879 行（重构后）

---

## 目录结构

```
PickWord/
├── tsconfig.json           # 基础 TS 配置
├── tsconfig.web.json       # renderer 编译
├── tsconfig.node.json      # main 编译
├── package.json
├── vite.config.ts          # renderer 构建
├── electron-builder.yml
├── electron.vite.config.ts
├── demo/index.html         # 浏览器演示（静态 HTML）
│
├── resources/              # 应用图标等静态资源
│
├── src/
│   ├── main/               # Electron 主进程
│   │   ├── index.ts        # IPC handlers（~1060 行）
│   │   ├── deploy.ts       # 模型下载/镜像（299 行）
│   │   ├── library.ts      # 多篇文稿库（497 行）
│   │   ├── documents.ts    # docx 解析（55 行）
│   │   ├── ioUtils.ts      # 共享 I/O 工具（135 行）
│   │   ├── types.ts        # main 端类型（15 行）
│   │   └── preload.ts      # 桥接（112 行）
│   │
│   ├── renderer/           # React 渲染进程
│   │   ├── App.tsx         # 文库入口（293 行）
│   │   ├── WritingEditor.tsx  # 编辑器（1765 行）
│   │   ├── index.css       # 全局样式（3376 行，§ 索引）
│   │   ├── main.tsx        # 入口
│   │   ├── App.css         # 旧样式（未使用）
│   │   │
│   │   ├── components/
│   │   │   ├── Icon.tsx         # SVG 图标
│   │   │   ├── LibraryHome.tsx  # 文库首页（427 行）
│   │   │   ├── SettingsPanel.tsx # 设置面板（238 行）
│   │   │   ├── ContextSidebar.tsx # 章节侧边栏（217 行）
│   │   │   └── Toast.tsx        # 通知
│   │   │
│   │   ├── dialogs/
│   │   │   ├── ImportDialog.tsx
│   │   │   ├── ExportDialog.tsx
│   │   │   └── SettingsDialog.tsx
│   │   │
│   │   ├── hooks/
│   │   │   ├── useAutoResize.ts     # textarea 自适应高度
│   │   │   ├── useDebounce.ts       # 防抖
│   │   │   └── useKeyboard.ts       # 全局快捷键
│   │   │
│   │   └── lib/
│   │       ├── types.ts             # 渲染器端类型 + ContextState（321 行）
│   │       ├── ipc.ts               # IPC 调用封装
│   │       ├── settings.ts          # 设置持久化（71 行）
│   │       ├── library.ts           # 文库排序（67 行）
│   │       ├── openFile.ts          # 文件解析（224 行）
│   │       ├── textStats.ts         # 字数统计（111 行）
│   │       ├── candidateProvider.ts # 候选数据源选择（97 行）
│   │       └── useBackendStatus.ts  # 模型状态管理（281 行）
│   │
│   └── preload/
│       └── index.ts        # preload 构建入口
│
├── scripts/
│   ├── serve-llm.js        # 本地 LLM 服务
│   └── llm/
│       ├── server.js       # 候选 API
│       ├── modelLoader.js  # 模型加载
│       ├── candidates.js   # 候选生成
│       └── inference/      # 推理引擎
│
└── tools/
    ├── build-electron.js   # 构建脚本
    └── ...
```

---

## 核心架构决策

### 1. 双进程分离

**主进程（main/）**：
- 文件 I/O（读写文稿、文库管理）
- 模型下载与部署（deploy.ts）
- IPC handlers（与 renderer 通信）
- 不直接处理候选生成——调用外部 LLM 服务

**渲染进程（renderer/）**：
- UI 渲染
- 编辑状态管理
- 候选请求与显示
- 设置持久化（localStorage）

**桥接（preload.ts）**：
- 暴露 `window.api` 给 renderer
- 类型安全：通过 `ElectronApi` 接口约束

### 2. 文库模式（Library-first）

应用启动后先进入**文库首页**，而非直接打开编辑器。用户选择或创建文稿后才挂载编辑器。

**关键文件**：
- `App.tsx` — 文库入口，管理文稿列表
- `LibraryHome.tsx` — 文库首页 UI
- `library.ts`（main）— 多篇文稿存储（`~/PickWordLibrary/`）

**数据结构**：
```ts
interface LibraryEntry {
  id: string           // 文件名（不含扩展名）
  title: string        // 显示标题
  mtime: number        // 修改时间戳
  sourceFormat: LibraryFormat  // 'txt' | 'md' | 'docx'
  wordCount: number
}

interface DocumentPayload {
  title: string
  content: string      // 正文（纯文本）
  styleText: string    // 风格文本（用于提示词）
  outlineText: string  // 大纲文本
  styleEnabled: boolean
  outlineEnabled: boolean
  anchor: { chapter: string; scene: string } | null
}
```

**切换文稿**：通过 `key={id}` 强制重新挂载 WritingEditor，隔离撤销栈、候选请求、光标状态。

### 3. WritingEditor 组件

编辑器是应用的核心，1765 行。内部按功能分为 **A–J 十个段落**，用注释标记：

```
A. 提示词构建（promptArgsFor）
B. 滑动窗口（sliding window）
C. 候选流控制（candidate flow）
D. 编辑/撤销（edit/undo）
E. 保存/导出（save/export）
F. IME 处理
G. 键盘导航
H. Effects
I. 搜索/上下文菜单/Toast
J. 派生值/渲染
```

**为什么不拆分为 hooks？**
- 20+ 个 useState、15+ 个 useRef 深度耦合
- 数十个相互依赖的回调
- 强制参数传递会创建笨重的签名
- 段落标记已提供清晰导航

**对外接口**：
```ts
interface WritingEditorProps {
  initial: DocumentPayload
  sourceFormat: LibraryFormat | null
  settings: SettingsValues
  onToggleAutoSave: (enabled: boolean) => void
  onSave: (document: DocumentPayload) => Promise<LibraryEntry>
  onBack: () => void
}
```

### 4. 候选系统（Candidate System）

应用的核心功能是**智能候选词**。流程：

1. 用户输入文本 → 触发 `onInput`
2. 防抖（300ms）→ 调用 `source.query()`
3. 主进程通过 IPC 调用本地 LLM（`scripts/llm/server.js`）
4. LLM 返回候选列表 → renderer 显示在抽屉中
5. 用户用 ↑↓ 选择，Enter 采纳

**数据源选择**（`candidateProvider.ts`）：
- `window.api` 存在 → 真实 IPC（Electron）
- 否则 → 演示 mock（浏览器）

**候选流控制**（WritingEditor Section C）：
- 请求 ID 防竞态
- 防抖 + 取消
- 状态机：idle → requesting → success/error

### 5. 模型部署（deploy.ts）

独立封装模型下载逻辑：

```ts
// deploy.ts 导出
export async function downloadWithMirrors(ctx, urls, dest, onProgress)
export function probeOfficialUrl(backend, baseUrl)
export function setup(ctx, opts)
```

**镜像探测**：
- 官方源失败 → 自动尝试镜像
- 进度回调（`onProgress`）→ 渲染进度条
- 支持取消（`AbortController`）

### 6. CSS 架构（index.css）

3376 行全局样式，使用 **§ 索引** 导航：

```
§1 CSS 变量     §2 全局重置     §3 主容器/根节点
§4 滚动条       §5 应用头       §6 应用主体布局
§7 文库入口     §8 封面网格     §9 空状态
§10 设置面板    §11 编辑器顶栏  §12 编辑区（EditorStage）
§13 候选抽屉    §14 保存状态    §15 通知/Toast
§16 搜索/上下文菜单 §17 对话框   §18 响应式
§19 动画/过渡   §20 工具类
```

**设计原则**：
- 单文件，无 CSS Modules
- 类名语义化（`.editor-stage`, `.candidate-drawer`）
- 响应式：移动端隐藏侧边栏
- 暗色主题：`data-theme="dark"` + CSS 变量

---

## 关键类型定义

### 渲染器端（lib/types.ts）

```ts
// 文稿条目
interface LibraryEntry { id, title, mtime, sourceFormat, wordCount }

// 文稿内容
interface DocumentPayload { title, content, styleText, outlineText, ... }

// 候选项
interface Candidate {
  text: string
  prob?: number
  explanation?: string
}

// 候选响应
interface CandidateResponse {
  candidates: Candidate[]
  context: { prefix: string; suffix: string }
}

// 侧边栏状态（从 ContextSidebar.tsx 迁移）
interface ContextState {
  styleEnabled: boolean
  outlineEnabled: boolean
  // ...
}

// 设置
interface SettingsValues {
  theme: 'light' | 'dark'
  autoSaveEnabled: boolean
  modelContextLen: number
  // ... 20+ 字段
}
```

### 主进程端（main/types.ts）

与 renderer 端基本一致，通过 preload 桥接。

---

## 状态管理

### 文库状态（App.tsx）

```ts
const [entries, setEntries] = useState<LibraryEntry[]>([])
const [directory, setDirectory] = useState<LibraryDirectory>({...})
const [loading, setLoading] = useState(true)
const [error, setError] = useState<string | null>(null)
const [active, setActive] = useState<ActiveManuscript | null>(null)
```

### 编辑器状态（WritingEditor.tsx）

```ts
// 核心
const [text, setText] = useState(initial.content)
const [selection, setSelection] = useState({ start, end })
const [candidates, setCandidates] = useState<Candidate[]>([])
const [candidateState, setCandidateState] = useState<'idle' | 'requesting' | ...>('idle')

// UI
const [showSidebar, setShowSidebar] = useState(true)
const [showSettings, setShowSettings] = useState(false)
const [toast, setToast] = useState<Toast | null>(null)

// 撤销栈
const undoStack = useRef<string[]>([])
const redoStack = useRef<string[]>([])

// IME
const composingRef = useRef(false)
const imeCompositionTextRef = useRef('')
```

### 设置持久化

- **renderer**：`localStorage`（`zixia-writing-settings-v3`）
- **main**：无（renderer 负责）

---

## IPC 通信

### 主要通道

| 通道 | 方向 | 用途 |
|------|------|------|
| `library:list` | renderer → main | 获取文稿列表 |
| `library:read` | renderer → main | 读取文稿内容 |
| `library:save` | renderer → main | 保存文稿 |
| `library:create` | renderer → main | 创建新文稿 |
| `library:delete` | renderer → main | 删除文稿 |
| `library:chooseDirectory` | renderer → main | 选择文库目录 |
| `backend:status` | renderer → main | 查询模型状态 |
| `backend:download` | renderer → main | 下载模型 |
| `backend:probe` | renderer → main | 探测官方源 |
| `candidates:query` | renderer → main | 请求候选 |

### preload 桥接

```ts
// preload.ts
contextBridge.exposeInMainWorld('api', {
  isDemo: false,
  listLibrary: () => ipcRenderer.invoke('library:list'),
  readLibrary: (id) => ipcRenderer.invoke('library:read', id),
  saveLibrary: (id, doc) => ipcRenderer.invoke('library:save', id, doc),
  // ...
})
```

---

## 构建与开发

### 开发模式

```bash
npm run dev          # 启动 Electron 开发服务器
npm run dev:web      # 仅 renderer（浏览器）
npm run dev:llm      # 本地 LLM 服务
```

### 构建

```bash
npm run build        # 构建 Electron 应用
npm run build:web    # 仅构建 renderer
```

### TypeScript 编译

```bash
npx tsc --project tsconfig.web.json --noEmit   # renderer
npx tsc --project tsconfig.node.json --noEmit  # main
```

---

## 文件选择指南

**未来 AI agent 应根据任务选择性读取以下文件**：

| 任务 | 需要读取的文件 |
|------|----------------|
| 修改文库逻辑 | `App.tsx`, `LibraryHome.tsx`, `main/library.ts` |
| 修改编辑器 | `WritingEditor.tsx`（完整） |
| 修改样式 | `index.css`（查看 § 索引后跳转到对应段落） |
| 修改候选系统 | `WritingEditor.tsx` Section C, `lib/candidateProvider.ts`, `scripts/llm/server.js` |
| 修改模型下载 | `main/deploy.ts` |
| 修改 IPC | `main/index.ts`, `preload.ts`, `lib/ipc.ts` |
| 修改类型 | `lib/types.ts`, `main/types.ts` |
| 修改设置 | `lib/settings.ts`, `SettingsPanel.tsx`, `SettingsDialog.tsx` |
| 修改侧边栏 | `components/ContextSidebar.tsx` |
| 修改文件解析 | `lib/openFile.ts`, `main/documents.ts`, `main/ioUtils.ts` |

---

## 已知问题与限制

1. **类型重复**：main/renderer 各自定义 `DocumentPayload` 等类型。当前通过手动同步维护。未来应创建 `shared/core-types.ts`。

2. **WritingEditor 过大**：1765 行，内部段落化（A–J）提供导航。不再拆分为 hooks（状态依赖太深）。

3. **无单元测试**：关键模块（ioUtils, deploy, candidateProvider）缺少测试覆盖。

4. **CSS 无作用域**：全局样式，类名冲突风险。当前通过命名约定（语义化）缓解。

5. **演示模式限制**：浏览器演示（`demo/index.html`）使用 mock 数据，部分功能（文件保存、模型下载）不可用。

---

## 维护清单

- [ ] 为 `ioUtils.ts` 添加单元测试
- [ ] 为 `deploy.ts` 添加单元测试
- [ ] 创建 `shared/core-types.ts` 统一类型
- [ ] 补充 E2E 测试（Playwright）
- [ ] 文档化 `scripts/llm/` 的推理引擎
- [ ] 优化移动端体验（当前响应式仅基础支持）

---

*本文档由架构解耦工作生成，基于 commit 后的代码状态。最后更新：2026-10-09*
