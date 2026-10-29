# 提示词探针

四组只读探针，直接调渲染层的纯函数（不需要 Electron、React 或本地后端），
把「真正发给模型的字符串」打印出来肉眼对照。改提示词 / 素材 / 纠错窗口后跑一遍，
比在界面上猜快得多。

```bash
npm run probe
```

等价的手工命令（`esbuild` 已经是 devDependency 带的）：

```bash
npx esbuild scripts/prompt-probe/index.ts --bundle --platform=node --format=cjs \
  --outfile=node_modules/.cache/prompt-probe.cjs --log-level=warning
node node_modules/.cache/prompt-probe.cjs
```

产物写进 `node_modules/.cache/`，不进仓库、不进安装包。

## 四组分别验证什么

| 文件 | 验证内容 |
| --- | --- |
| `probe-prompt.ts` | 续写两种模式 + 纠错的完整 prompt；空思考块位置；章节标题不进提示词；素材不再注入；`bodyChars` 与原始偏移差的差异 |
| `probe-window.ts` | 纠错窗口 vs 面板命中范围的口径差异；章节标记行等长掩码 |
| `probe-materials.ts` | 建卡候选提取的门槛、提及计数（别名合并）、别名解析、卡片结构（已无 `inject`） |
| `probe-local.ts` | 纠错本地层：重复片段、段落开头单调、专名写法不一致（含三组「预期不报」的边界） |

## 注意

- 这些文件**不在** `tsconfig.*.json` 的 `include` 里（只收 `src/**`），所以不参与 `npm run typecheck`；
  改完 `src/` 的导出签名后要跑一次 `npm run probe` 才会发现探针自己坏了。
- `electron.vite.config.ts` 只打包 `src/main`、`src/preload`、`src/renderer`，
  `electron-builder.yml` 另外排除了 `scripts/*`，所以发布包里不会有它们。
- ES `import` 会提升：`index.ts` 里四组的执行顺序就是书写顺序，分隔标题由各探针自己打印。
