/**
 * App.tsx - 文库入口与单篇编辑器
 *
 * App 先显示文库；WritingEditor 只负责当前文章，切换文章时重新挂载。
 * 阅读顺序建议：常量 → 编辑器 state/ref → A~J 各节 → 底部 App 文库入口。
 *
 * 对 C / Python 背景的你：
 *   - useState：声明一个「改了就会重绘画面」的变量；
 *   - useRef：声明一个「改了不重绘、但在任何回调里都能读到最新值」的可变盒子（.current）；
 *   - useEffect：在「画面绘制完之后」执行副作用（订阅事件、定时器），返回的函数是清理函数；
 *   - 闭包陷阱：事件处理函数捕获的是「定义它那一次渲染」的变量值，所以异步回调里要读 ref 不读 state。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { BackendStatusBar, formatEta } from "./components/BackendStatusBar";
import { BrandLogo } from "./components/BrandLogo";
import { CandidatePopover } from "./components/CandidatePopover";
import { ContextSidebar, type ContextState } from "./components/ContextSidebar";
import { GentleToast } from "./components/GentleToast";
import { Icon } from "./components/Icon";
import { LibraryHome, type ImportReport } from "./components/LibraryHome";
import { SearchPanel } from "./components/SearchPanel";
import {
  applySoftening,
  BACKEND_TOP_K,
  chooseCandidateSource,
  createRequestId,
  estimatePrefillSeconds,
  sampleByProbability,
} from "./lib/candidateProvider";
import { useBackendStatus } from "./lib/useBackendStatus";
import {
  commonPrefixLength,
  diffEditSpan,
  findMatches,
  makeFingerprint,
  mapAnchorThroughEdit,
  mapOffsetThroughEdit,
  measureCaretPoint,
  paragraphStartAt,
  snapAnchorOffset,
} from "./lib/editorText";
import { chooseLibraryProvider, sortLibrary } from "./lib/library";
import { MAX_FILE_BYTES, parseOpenedFile } from "./lib/openFile";
import {
  advanceSlidingWindow,
  ANCHOR_BEFORE_CURSOR_NOTICE,
  bodyHardLimit,
  buildPrompt,
  isAnchorOverflow,
  PROMPT_MODE_LABEL,
  slidingWindowMaxBodyLen,
  type BuildPromptArgs,
} from "./lib/promptBuilder";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  matchesSampleKey,
  PEEK_KEY_SHORT,
  SAMPLE_KEY_SHORT,
  type SettingsValues,
} from "./lib/settings";
import type {
  Candidate,
  DocumentPayload,
  EditorSnapshot,
  LibraryDirectory,
  LibraryEntry,
  LibraryFormat,
  SaveStatus,
  SelectionRange,
} from "./lib/types";

/* ════════════════════════════════════════════════════════════════
   常量与初始数据
   ════════════════════════════════════════════════════════════════ */

const SETTINGS_KEY = "zixia-writing-settings-v3";

/** 预计需要重新 prefill 的字符数超过它，状态栏给一句「上下文重算」提示。 */
const REBUILD_HINT_CHARS = 400;
/** 一般短暂提示的停留时长。 */
const NOTICE_MS = 8000;
/** 「自动退出锚点模式」这种重要提示停留更久。 */
const IMPORTANT_NOTICE_MS = 20000;

/** 启动时决定数据源：有 window.api 走真实 IPC，否则走演示 mock。 */
const candidateSource = chooseCandidateSource();
/** 多篇文稿有单独的按 ID 数据源；不能用旧版全局 currentPath 保存新文库。 */
const libraryProvider = chooseLibraryProvider();

/** 一次候选请求的「任务描述」：正文快照 + 光标 + 当时是不是快速模式。 */
interface CandidateJob {
  text: string;
  range: SelectionRange;
  quick: boolean;
}

/** 编辑区上方的文件提示条（打开 Word / 非 UTF-8 文本 / 打开失败）。 */
interface FileBanner {
  kind: "info" | "error";
  text: string;
}

/** 把 UI 状态翻译成 PromptBuilder 的入参（一个纯函数，多处共用）。 */
function promptArgsFor(
  text: string,
  caret: number,
  ctx: ContextState,
  settings: SettingsValues,
  windowStart: number,
): BuildPromptArgs {
  const outlineText = ctx.outlineEnabled ? ctx.outlineText : undefined;
  const outlineActive = Boolean(outlineText?.trim());
  return {
    styleText: ctx.styleEnabled ? ctx.styleText : undefined,
    outlineText,
    docText: text,
    cursorOffset: caret,
    anchorOffset: outlineActive ? ctx.anchor?.offset ?? null : null,
    windowStart,
    maxBodyLen: settings.maxBodyLen,
    anchorWarnLen: settings.anchorWarnLen,
    modelContextLen: settings.modelContextLen,
  };
}

/** 文件名里不能出现的字符替换成下划线。 */
function safeFileName(title: string): string {
  const trimmed = title.trim() || "未命名";
  return trimmed.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80);
}

/* ════════════════════════════════════════════════════════════════
   主组件
   ════════════════════════════════════════════════════════════════ */

interface WritingEditorProps {
  initial: DocumentPayload;
  sourceFormat: LibraryFormat;
  settings: SettingsValues;
  /** 顶栏「自动保存」开关直接写进设置（持久化），所以由 App 提供修改入口。 */
  onToggleAutoSave: (enabled: boolean) => void;
  onSave: (document: DocumentPayload) => Promise<LibraryEntry>;
  onBack: () => void;
}

/** 编辑器仍保留原有的输入法、候选、查找与大纲逻辑；文稿读写由文库按 id 提供。 */
function WritingEditor({ initial, sourceFormat, settings, onToggleAutoSave, onSave, onBack }: WritingEditorProps) {
  const initialCaret = initial.content.length;
  const autoSaveEnabled = settings.autoSaveEnabled;

  // 本地模型状态、加载进度与 prefill 速度；首页与编辑器共用同一个订阅缓存。
  const backend = useBackendStatus(candidateSource.isDemo);
  const backendStatus = backend.status;

  /* ── 文稿与光标 ───────────────────────────────── */
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [selection, setSelection] = useState<SelectionRange>({ start: initialCaret, end: initialCaret });

  /* ── 写作上下文（侧边栏三件套） ─────────────────── */
  const [context, setContext] = useState<ContextState>({
    styleEnabled: initial.styleEnabled,
    styleText: initial.styleText,
    outlineEnabled: initial.outlineEnabled,
    outlineText: initial.outlineText,
    anchor: initial.anchor,
  });
  const [anchorNotice, setAnchorNotice] = useState<string | null>(null);

  /* ── 面板开合。侧边栏默认折叠：第一次打开软件只看到干净的编辑区。 ── */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  /* ── 查找替换 ─────────────────────────────────── */
  const [searchQuery, setSearchQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);

  /* ── 候选浮层 ─────────────────────────────────── */
  const [candidateList, setCandidateList] = useState<Candidate[]>([]);
  const [globalIndex, setGlobalIndex] = useState(0); // 在全部候选里的绝对序号
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  /** 空候选提示：模型这次没给出可插入的词，不是故障。 */
  const [candidateNotice, setCandidateNotice] = useState<string | null>(null);
  const [candidatePosition, setCandidatePosition] = useState<{ left: number; top: number } | null>(null);
  const [peekActive, setPeekActive] = useState(false);
  const [prefillChars, setPrefillChars] = useState(0);

  /* ── 保存 ─────────────────────────────────────── */
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [returning, setReturning] = useState(false);

  /* ── 其它 ─────────────────────────────────────── */
  const [isComposing, setIsComposing] = useState(false);
  const [logText, setLogText] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [windowNotice, setWindowNotice] = useState<string | null>(null);
  /** 重算上下文的提示文案（含预计耗时）；null = 不提示。 */
  const [rebuildHint, setRebuildHint] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [outlineHighlighted, setOutlineHighlighted] = useState(false);
  const [fileBanner, setFileBanner] = useState<FileBanner | null>(sourceFormat === "docx"
    ? { kind: "info", text: "这篇文稿由 Word 导入，只保留纯文本。原 Word 文件不会被修改；文库以 TXT 保存正文。" }
    : null);

  /* ── refs：跨事件、跨异步回调保存最新值 ────────────── */
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const outlineInputRef = useRef<HTMLTextAreaElement>(null);

  const contentRef = useRef(content);
  const titleRef = useRef(title);
  const selectionRef = useRef<SelectionRange>({ start: initialCaret, end: initialCaret });
  const contextRef = useRef(context);
  const settingsRef = useRef(settings);
  const backendStatusRef = useRef(backendStatus);
  const compositionRef = useRef(false);
  const editorFocusedRef = useRef(false);

  // 候选请求的调度状态：防抖计时器 / 在飞请求 / 排队中的最新任务
  const candidateTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const pendingJobRef = useRef<CandidateJob | null>(null);
  const runJobRef = useRef<(job: CandidateJob) => void>(() => undefined);
  const lastPromptRef = useRef("");

  // 穿透键
  const peekTimerRef = useRef<number | null>(null);
  const peekActiveRef = useRef(false);

  // 滑动窗口
  const windowStartRef = useRef(0);
  const writtenSinceUpdateRef = useRef(0);

  // 撤销 / 重做
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const lastEditGroupRef = useRef<{ kind: string; time: number } | null>(null);

  // 保存版本号：每次改动 +1；保存成功时记下版本，二者相等 = 已落盘
  const saveVersionRef = useRef(0);
  const savedVersionRef = useRef(0);
  const performSaveRef = useRef<() => Promise<boolean>>(async () => true);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);

  // EOS 弱提醒
  const eosCounterRef = useRef(0);
  const eosDismissedRef = useRef(false);

  // 短暂提示的计时器（按名字区分）
  const flashTimersRef = useRef(new Map<string, number>());

  // 供「只注册一次」的全局监听器调用最新版本的函数（避免闭包过期）
  const openSearchRef = useRef<() => void>(() => undefined);

  // 每次渲染都把最新值同步进 ref（这是 React 里安全的「镜像」写法）。
  contentRef.current = content;
  titleRef.current = title;
  contextRef.current = context;
  settingsRef.current = settings;
  backendStatusRef.current = backendStatus;

  // 打开一篇文稿意味着继续写作：把光标放在正文末尾，再让 textarea 获得焦点。
  // onFocus 会用这个真实选区请求候选，不会拿默认的 0 偏移误判“光标在锚点之前”。
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setSelectionRange(initialCaret, initialCaret);
    editor.scrollTop = editor.scrollHeight;
    editor.focus();
  }, [initialCaret]);

  /** 显示一条会自动消失的提示：apply 立即执行，ms 后执行 clear；同名提示会重置计时。 */
  function flash(key: string, apply: () => void, clear: () => void, ms = NOTICE_MS) {
    const timers = flashTimersRef.current;
    const existing = timers.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    apply();
    timers.set(
      key,
      window.setTimeout(() => {
        timers.delete(key);
        clear();
      }, ms),
    );
  }

  /* ════════════════════════════════════════════════
     A. 提示词
     ════════════════════════════════════════════════ */

  /** 用 ref 里的最新状态拼 prompt，可以安全地在异步回调里调用。 */
  function buildCurrentPrompt(text: string, caret: number) {
    return buildPrompt(promptArgsFor(text, caret, contextRef.current, settingsRef.current, windowStartRef.current));
  }

  /**
   * 渲染用的 prompt 预览（纯函数推导，不发请求）。
   * 用途：① 侧边栏显示当前模式与正文长度；② 编辑区给「送入模型的正文」加浅背景。
   */
  const promptPreview = useMemo(
    () => buildPrompt(promptArgsFor(content, selection.start, context, settings, windowStart)),
    [content, selection.start, context, settings, windowStart],
  );

  /* ════════════════════════════════════════════════
     B. 滑动窗口 + 锚点硬上限
     ════════════════════════════════════════════════ */

  /**
   * 锚点正文超过硬上限：清除锚点、关闭大纲，回退到滑动窗口。
   *
   * 注意「大纲」只是被关闭，文字仍保留在侧边栏（和「关闭开关只变灰、内容保留」的原则一致），
   * 作者可以随时重新开启并重设锚点；如果你希望连文字一起清空，把下面的 outlineText 改成 "" 即可。
   */
  function dropAnchorMode(length: number, limit: number) {
    const next: ContextState = { ...contextRef.current, anchor: null, outlineEnabled: false };
    contextRef.current = next;
    setContext(next);
    eosCounterRef.current = 0;
    eosDismissedRef.current = false;
    markDirty();

    const message =
      `锚点到光标已有 ${length} 字，超过上下文硬上限（约 ${limit} 字，按 1 字 = 1 token 估算），` +
      "已自动退出锚点模式：锚点已清除、大纲已关闭（大纲文字仍保留在侧边栏，可重新开启并重设锚点），改用滑动窗口。";
    flash("anchor", () => setAnchorNotice(message), () => setAnchorNotice(null), IMPORTANT_NOTICE_MS);
  }

  /**
   * 每次文本 / 光标 / 设置变化后调用：
   *   ① 锚点模式下检查硬上限，超限就退出锚点模式；
   *   ② 锚点模式生效时绝不启动滑窗；
   *   ③ 其余情况按规则推进滑动窗口左边界。
   */
  function syncWindow(text: string, caret: number) {
    const s = settingsRef.current;
    let args = promptArgsFor(text, caret, contextRef.current, s, windowStartRef.current);

    if (isAnchorOverflow(args)) {
      const limit = bodyHardLimit(s.modelContextLen, args.styleText, args.outlineText);
      dropAnchorMode(caret - (args.anchorOffset ?? 0), limit);
      args = promptArgsFor(text, caret, contextRef.current, s, windowStartRef.current);
    }

    const ctx = contextRef.current;
    const outlineUsable = ctx.outlineEnabled && ctx.outlineText.trim().length > 0;
    const anchorActive = outlineUsable && ctx.anchor !== null && ctx.anchor.offset <= caret;
    // 只有光标位于锚点之后时才冻结滑窗，严格使用「锚点 → 光标」范围。
    // 光标回到锚点之前时改用滑窗，并由 PromptBuilder 返回明确提示。
    if (anchorActive) return;

    const result = advanceSlidingWindow(
      text,
      caret,
      { start: windowStartRef.current, writtenSinceUpdate: writtenSinceUpdateRef.current },
      // 滑窗有自己的 maxBodyLen；锚点正文的硬上限只用于锚点模式，不与滑窗混用。
      slidingWindowMaxBodyLen(args),
      s.windowAdvanceMinChars,
    );
    if (result.state.start !== windowStartRef.current) {
      windowStartRef.current = result.state.start;
      setWindowStart(result.state.start);
    }
    writtenSinceUpdateRef.current = result.state.writtenSinceUpdate;

    const notice = result.notice;
    if (notice) flash("window", () => setWindowNotice(notice), () => setWindowNotice(null));
  }

  /* ════════════════════════════════════════════════
     C. 候选请求：防抖 + 单飞 + 最新优先
     ════════════════════════════════════════════════

     为什么要「单飞」：AbortSignal 过不了 IPC，renderer 侧 abort 只是「不再等结果」，
     主进程和 llama-server 并不知道，请求会在后端排队堆积。
     所以这里保证：任何时刻最多 1 个请求在飞 + 最多 1 个任务排队（永远只保留最新的）。
     后端若支持 cancelCandidates，则在新任务到来时顺手 abort 在飞请求，让后端尽早停下。 */

  function cancelCandidateWork() {
    if (candidateTimerRef.current !== null) {
      window.clearTimeout(candidateTimerRef.current);
      candidateTimerRef.current = null;
    }
    pendingJobRef.current = null;
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
  }

  /** 关闭浮层（Esc / 失焦 / 开始组字 / 插入完成）。 */
  function closeCandidates() {
    cancelCandidateWork();
    setCandidateOpen(false);
    setCandidateLoading(false);
    setCandidateError(null);
    setCandidateNotice(null);
    setCandidateList([]);
    setGlobalIndex(0);
  }

  /** 真正发出一次请求。 */
  function runJob(job: CandidateJob) {
    // 后端没就绪时不发请求，避免快速模式下每个按键都撞一次错误。
    if (!candidateSource.isDemo && backendStatusRef.current !== "ready") {
      setCandidateLoading(false);
      setCandidateList([]);
      setCandidateError("本地模型尚未就绪，候选暂停。");
      setCandidateOpen(true);
      return;
    }

    const controller = new AbortController();
    inFlightRef.current = controller;
    setCandidateLoading(true);
    setCandidateOpen(true);
    setCandidateError(null);

    const built = buildCurrentPrompt(job.text, job.range.start);

    // 估算这次有多少 prompt 前缀能命中 KV cache（字符级近似，真实是 token 级）。
    // 大幅移动光标、切换风格 / 大纲、打开新文稿都会让前缀失配 → 模型要重新读入这一段。
    const shared = commonPrefixLength(lastPromptRef.current, built.prompt);
    const prefill = built.prompt.length - shared;
    setPrefillChars(prefill);
    if (lastPromptRef.current.length > 0 && prefill > REBUILD_HINT_CHARS) {
      const seconds = estimatePrefillSeconds(prefill, backend.prefillTokensPerSecond);
      // 只有预计耗时超过设置里的阈值才打扰作者；几百毫秒的重算对体验无感。
      if (seconds >= settingsRef.current.prefillHintSeconds) {
        const message = `上下文变化较大，模型正在重新读入约 ${prefill} 字，预计${formatEta(seconds)}`;
        flash("rebuild", () => setRebuildHint(message), () => setRebuildHint(null), Math.max(2600, seconds * 1000));
      }
    }
    lastPromptRef.current = built.prompt;

    candidateSource
      .provider(
        {
          requestId: createRequestId(),
          prompt: built.prompt,
          bodyPrefix: job.text.slice(built.bodyStart, built.bodyEnd),
          topK: BACKEND_TOP_K,
          mode: built.mode,
        },
        controller.signal,
      )
      .then((result) => {
        // ── 竞态校验：任一不满足即视为过期，直接丢弃 ──
        if (controller.signal.aborted || inFlightRef.current !== controller) return;
        if (compositionRef.current) return;
        if (contentRef.current !== job.text || selectionRef.current.start !== job.range.start) return;

        const sorted = [...result].sort(
          (left, right) => (right.logit ?? Math.log(right.prob || 1e-9)) - (left.logit ?? Math.log(left.prob || 1e-9)),
        );

        const s = settingsRef.current;

        // 先对**全部**候选（含终止符）软化一次：终止符的概率要和其它词放在同一把尺子上比，
        // 才能用「≥ 10%」这样的阈值；单独拿它的原始 softmax 值没有意义。
        const softenedAll = applySoftening(sorted, s.softenTemperature);

        // ── EOS 弱提醒 ──
        // 三道门：① 只在大纲模式（built.mode 含大纲）才计数——纯续写 / 仅风格没有「本章该收尾」的概念；
        //         ② 终止符要排进前 eosScanTopN；③ 软化后概率 ≥ eosMinProb。
        const outlineMode = built.mode === "outline" || built.mode === "full";
        if (outlineMode) {
          const hitEos = softenedAll
            .slice(0, s.eosScanTopN)
            .some((item) => item.isEos && item.prob >= s.eosMinProb);
          if (hitEos) {
            eosCounterRef.current += 1;
            if (eosCounterRef.current >= s.eosThreshold && !eosDismissedRef.current) setToastVisible(true);
          } else {
            eosCounterRef.current = 0;
          }
        } else {
          eosCounterRef.current = 0;
        }

        // 终止符不展示给作者；去掉它之后再软化一次，让展示的百分比加起来是 100%。
        const usable = applySoftening(
          sorted.filter((item) => !item.isEos && item.text.length > 0),
          s.softenTemperature,
        );
        setCandidateList(usable);
        setGlobalIndex(0);
        setCandidateLoading(false);

        if (usable.length === 0) {
          // 模型把结束符排在了第一位（常见于刚推进滑窗、或一句话刚好写完）。
          // 这不是故障：继续写、甚至改一个字，下次请求通常就正常了。
          setCandidateNotice("模型暂时没有推荐候选，继续写就好。");
          setCandidateOpen(true);
          // 普通模式下浮层不常驻：显示三秒后自动收起（4000）
          if (!job.quick) {
            flash(
              "empty-notice",
              () => {},
              () => { setCandidateOpen(false); setCandidateNotice(null); },
              3000,
            );
          }
        } else {
          setCandidateNotice(null);
          setCandidateOpen(true);
        }

      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || inFlightRef.current !== controller) return;
        setCandidateLoading(false);
        setCandidateList([]);
        setCandidateError(error instanceof Error ? error.message : "候选请求失败，请稍后再试。");
        setCandidateOpen(true);
      })
      .finally(() => {
        if (inFlightRef.current === controller) inFlightRef.current = null;
        // 只有在「现在没有别的请求在飞」时才启动排队任务，保证单飞。
        if (inFlightRef.current === null) {
          const next = pendingJobRef.current;
          if (next) {
            pendingJobRef.current = null;
            runJobRef.current(next);
          }
        }
      });
  }
  runJobRef.current = runJob;

  /** 入队：在飞则排队（覆盖旧排队任务），否则立刻发。 */
  function enqueueJob(job: CandidateJob) {
    if (inFlightRef.current) {
      pendingJobRef.current = job;
      // 后端支持取消时顺手停掉在飞请求；finally 会接着跑排队任务。
      if (candidateSource.supportsCancel) inFlightRef.current.abort();
      return;
    }
    runJob(job);
  }

  /**
   * 排程一次候选查询。
   *   普通模式：清空并隐藏浮层 → 等待 triggerDelay → 入队。作者继续打字会重新计时。
   *   快速模式：浮层常驻、零延迟；旧候选保留并半透明，直到新结果替换它，避免闪烁。
   */
  function scheduleCandidates(text: string, range: SelectionRange, quickOverride?: boolean) {
    if (candidateTimerRef.current !== null) {
      window.clearTimeout(candidateTimerRef.current);
      candidateTimerRef.current = null;
    }
    pendingJobRef.current = null;
    setCandidateError(null);

    // 输入法组字期间绝不请求（见 F 节）。
    // 开启「浮窗常驻」时浮窗保持原样（会被淡化），否则收起。
    if (compositionRef.current) {
      if (settingsRef.current.keepPopover) setCandidateLoading(false);
      else setCandidateOpen(false);
      return;
    }

    const quick = quickOverride ?? settingsRef.current.quickMode;
    if (quick) {
      setCandidateOpen(true);
      setCandidateLoading(true);
    } else {
      setCandidateOpen(false);
      setCandidateList([]);
      setGlobalIndex(0);
      setCandidateLoading(false);
    }

    const job: CandidateJob = { text, range, quick };
    const wait = quick ? 0 : settingsRef.current.triggerDelay;
    candidateTimerRef.current = window.setTimeout(() => {
      candidateTimerRef.current = null;
      enqueueJob(job);
    }, wait);
  }

  /* ════════════════════════════════════════════════
     D. 文本写入、锚点同步、撤销重做
     ════════════════════════════════════════════════ */

  function markDirty() {
    saveVersionRef.current += 1;
    // 上次保存失败也照样置为 dirty：下一次自动保存会重试，失败会再次显示「保存失败」。
    setSaveStatus("dirty");
  }

  /** 记录一帧撤销快照。连续同类编辑（打字/删除）在 850ms 内会合并成一步。 */
  function recordHistory(kind: string, groupable = false) {
    const now = Date.now();
    const last = lastEditGroupRef.current;
    const startNewGroup = !groupable || !last || last.kind !== kind || now - last.time > 850;

    if (startNewGroup) {
      undoStackRef.current.push({
        text: contentRef.current,
        start: selectionRef.current.start,
        end: selectionRef.current.end,
      });
      if (undoStackRef.current.length > 400) undoStackRef.current.shift();
    }
    lastEditGroupRef.current = groupable ? { kind, time: now } : null;
    redoStackRef.current = [];
    setHistoryRevision((n) => n + 1);
  }

  /**
   * 统一的「写入正文」入口。
   * 除了更新 state/ref，还负责：锚点穿过这次编辑、滑动窗口左边界平移与推进、硬上限检查。
   */
  function setEditorDocument(nextText: string, nextSelection: SelectionRange) {
    const previousText = contentRef.current;

    if (previousText !== nextText) {
      const span = diffEditSpan(previousText, nextText);

      // ① 锚点：先按偏移平移，再用指纹校验 / 重找
      const currentAnchor = contextRef.current.anchor;
      if (currentAnchor) {
        const result = mapAnchorThroughEdit(currentAnchor, nextText, span);
        if (
          result.anchor.offset !== currentAnchor.offset ||
          result.anchor.fingerprint !== currentAnchor.fingerprint
        ) {
          const nextAnchor = result.anchor;
          contextRef.current = { ...contextRef.current, anchor: nextAnchor }; // 立即同步，供本次后续逻辑使用
          setContext((prev) => ({ ...prev, anchor: nextAnchor }));
        }
        const notice = result.notice;
        if (notice) flash("anchor", () => setAnchorNotice(notice), () => setAnchorNotice(null));
      }

      // ② 滑动窗口左边界跟着平移（并保持段落对齐）
      const mappedWindow = paragraphStartAt(nextText, mapOffsetThroughEdit(windowStartRef.current, span));
      if (mappedWindow !== windowStartRef.current) {
        windowStartRef.current = mappedWindow;
        setWindowStart(mappedWindow);
      }
      if (span.delta > 0) writtenSinceUpdateRef.current += span.delta;
    }

    contentRef.current = nextText;
    selectionRef.current = nextSelection;
    setContent(nextText);
    setSelection(nextSelection);
    markDirty();

    // ③ 滑动窗口推进判定 + 锚点硬上限检查
    syncWindow(nextText, nextSelection.start);
  }

  /**
   * 程序化编辑（插入候选、替换、制表符都走它）：写入 → 暂时关闭浮层 → 回写光标并重新排程候选。
   * 普通模式会等触发延迟后重新弹出，快速模式则零延迟更新；不要求作者再挪一次光标。
   */
  function applyProgrammaticEdit(
    nextText: string,
    nextSelection: SelectionRange,
    kind: string,
  ) {
    recordHistory(kind);
    setEditorDocument(nextText, nextSelection);
    cancelCandidateWork();

    // requestAnimationFrame：等 React 把新值刷进 DOM 之后再设置光标，否则会被覆盖。
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(nextSelection.start, nextSelection.end);

      scheduleCandidates(nextText, nextSelection);
    });
  }

  function restoreSnapshot(snapshot: EditorSnapshot) {
    setEditorDocument(snapshot.text, { start: snapshot.start, end: snapshot.end });
    cancelCandidateWork();
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(snapshot.start, snapshot.end);
      scheduleCandidates(snapshot.text, { start: snapshot.start, end: snapshot.end });
    });
  }

  function undo() {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push({
      text: contentRef.current,
      start: selectionRef.current.start,
      end: selectionRef.current.end,
    });
    lastEditGroupRef.current = null;
    setHistoryRevision((n) => n + 1);
    restoreSnapshot(previous);
  }

  function redo() {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push({
      text: contentRef.current,
      start: selectionRef.current.start,
      end: selectionRef.current.end,
    });
    lastEditGroupRef.current = null;
    setHistoryRevision((n) => n + 1);
    restoreSnapshot(next);
  }

  /**
   * 在光标处插入一个制表符（普通文本编辑器里 Tab 键的标准行为）。
   *
   * 优先用 document.execCommand("insertText")：它走浏览器「原生输入」路径，
   * 会触发 input 事件 → 我们的 onChange，光标位置由浏览器负责，
   * 并且和紧接着的下一个按键严格按顺序生效（见 handleEditorKeyDown 里的「手速快」处理）。
   * 这个 API 虽然被标记为过时，但 Chromium / Electron 仍然完整支持；万一返回 false 再退回手动写入。
   */
  function insertTabCharacter() {
    const editor = editorRef.current;
    if (!editor) return;
    if (document.activeElement !== editor) editor.focus();
    if (document.execCommand("insertText", false, "\t")) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = contentRef.current;
    const nextText = text.slice(0, start) + "\t" + text.slice(end);
    applyProgrammaticEdit(nextText, { start: start + 1, end: start + 1 }, "tab");
  }

  /* ════════════════════════════════════════════════
     E. 按文稿 ID 保存 / 导出 TXT 副本 / 返回首页
     ════════════════════════════════════════════════ */

  function buildPayload(): DocumentPayload {
    const ctx = contextRef.current;
    return {
      title: titleRef.current,
      content: contentRef.current,
      styleText: ctx.styleText,
      outlineText: ctx.outlineText,
      styleEnabled: ctx.styleEnabled,
      outlineEnabled: ctx.outlineEnabled,
      anchor: ctx.anchor,
    };
  }

  /**
   * 保存始终以文稿 id 为目标，不再调用旧的全局 currentPath 接口。
   * 同时来的自动保存、手动保存与返回首页会共享一个在飞 Promise；期间又改了正文，
   * 则等它结束后继续保存最新版本，直到落盘版本与编辑器版本一致。
   */
  async function performSave(): Promise<boolean> {
    if (saveInFlightRef.current) {
      const previousSucceeded = await saveInFlightRef.current;
      if (!previousSucceeded) return false;
      if (savedVersionRef.current === saveVersionRef.current) return true;
    }
    const version = saveVersionRef.current;
    if (version === savedVersionRef.current) return true;

    const payload = buildPayload();
    setSaveStatus("saving");
    const operation = (async () => {
      try {
        const entry = await onSave(payload);
        savedVersionRef.current = version;
        // 主进程如因重名调整了标题，让编辑器显示实际保存的名字。
        if (version === saveVersionRef.current && entry.title !== titleRef.current) {
          titleRef.current = entry.title;
          setTitle(entry.title);
        }
        setSaveStatus(version === saveVersionRef.current ? "saved" : "dirty");
        return true;
      } catch {
        setSaveStatus("error");
        return false;
      }
    })();
    saveInFlightRef.current = operation;
    const succeeded = await operation;
    if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
    if (!succeeded) return false;
    return savedVersionRef.current === saveVersionRef.current ? true : performSave();
  }
  performSaveRef.current = performSave;

  /**
   * 导出 / 另存为 .txt。
   * Electron 下走主进程的 saveDocumentAs（系统对话框）；浏览器演示用 Blob 下载。
   */
  function exportTxt() {
    const payload = buildPayload();
    const saveAs = window.api?.saveDocumentAs;
    if (saveAs) {
      void saveAs(payload)
        .then((result) => {
          if (result) setFileBanner({ kind: "info", text: "已导出一份 TXT 副本；文库中当前文稿的保存位置不变。" });
        })
        .catch(() => setFileBanner({ kind: "error", text: "导出失败，请重试。文库中的原稿未被改动。" }));
      return;
    }

    const blob = new Blob([payload.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(payload.title)}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFileBanner({ kind: "info", text: "已下载 TXT 副本；文库中的原稿仍在浏览器本地。" });
  }

  /** 返回首页前确保最新正文与 .writer.json 都保存成功，失败则留在编辑器。 */
  async function handleReturnHome() {
    if (returning) return;
    setReturning(true);
    closeCandidates();
    const succeeded = await performSave();
    if (!succeeded) {
      setFileBanner({ kind: "error", text: "保存失败，已留在编辑器。请先保存或导出 TXT 副本再重试。" });
      setReturning(false);
      return;
    }
    onBack();
  }

  /* ════════════════════════════════════════════════
     F. 输入法（IME）兼容 —— 本项目最容易踩坑的地方
     ════════════════════════════════════════════════

     中文输入法在「拼音还没上屏」时，浏览器会发出 composition 系列事件，
     并且此时 textarea.value 里是**临时的拼音串**。
     三条铁律：
       1. compositionstart → 取消请求（默认同时关闭浮层；开启「浮窗常驻」时浮层保留并淡化）；
       2. compositionupdate → 什么都不做（不请求、不弹层）；
       3. 组字期间 keydown 一律不拦截（方向键/数字键/回车/Tab 都归系统输入法）。
     Chromium 在组字时还会发 keyCode === 229 的「伪按键」，一并放行。

     「浮窗常驻」只改变浮层的显示方式（淡化 + pointer-events: none），不改变上面任何一条按键规则：
     组字期间浮层既不请求、也不拦截按键、也不响应鼠标，所以不可能和输入法抢东西。 */

  function handleCompositionStart() {
    compositionRef.current = true;
    setIsComposing(true);
    if (settingsRef.current.keepPopover) {
      // 只停掉计时器和在飞请求；保留已有候选，由浮层自己淡化。
      cancelCandidateWork();
      setCandidateLoading(false);
      setCandidateError(null);
    } else {
      closeCandidates();
    }
  }

  function handleCompositionUpdate() {
    // 故意留空：拼音预编辑阶段不做任何事情，避免和系统输入法打架。
  }

  function handleCompositionEnd() {
    compositionRef.current = false;
    setIsComposing(false);

    // setTimeout(0)：等浏览器把最终汉字提交进 value 之后再读取。
    window.setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const finalText = editor.value;
      const finalSelection = { start: editor.selectionStart, end: editor.selectionEnd };
      if (finalText !== contentRef.current) {
        recordHistory("typing", true);
        setEditorDocument(finalText, finalSelection);
      } else {
        selectionRef.current = finalSelection;
        setSelection(finalSelection);
      }
      scheduleCandidates(finalText, finalSelection);
    }, 0);
  }

  /* ════════════════════════════════════════════════
     G. 编辑器事件与键盘
     ════════════════════════════════════════════════ */

  /* ── 候选分页计算（只存一个全局序号，页码由它推导） ── */
  const pageSize = settings.candidateCount;
  const pageCount = Math.max(1, Math.ceil(candidateList.length / pageSize));
  const page = Math.min(Math.floor(globalIndex / pageSize), pageCount - 1);
  const visibleCandidates = candidateList.slice(page * pageSize, page * pageSize + pageSize);
  const localIndex = globalIndex - page * pageSize;

  /** 在当前光标处插入一个候选词（整体作为一次可撤销操作）。 */
  function insertCandidateText(text: string) {
    const range = selectionRef.current;
    const current = contentRef.current;
    const nextText = current.slice(0, range.start) + text + current.slice(range.end);
    const caret = range.start + text.length;
    // 插入后立即收起；程序化编辑在光标落位后重新排程，普通模式等待延迟，快速模式零延迟。
    applyProgrammaticEdit(nextText, { start: caret, end: caret }, "candidate");
  }

  function pickCandidate(indexInPage: number) {
    const candidate = visibleCandidates[indexInPage];
    if (!candidate) return;
    insertCandidateText(candidate.text);
  }

  /** 随机取词：按软化概率从全部候选里采样一个（轻量「自回归」体验）。 */
  function sampleCandidate() {
    const picked = sampleByProbability(candidateList);
    if (!picked) return;
    insertCandidateText(picked.text);
  }

  /** 松开穿透键 / 窗口失焦：清掉长按计时器并恢复浮层。只碰 ref 和 setter，所以可以 useCallback([])。 */
  const releasePeek = useCallback(() => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
    if (peekActiveRef.current) {
      peekActiveRef.current = false;
      setPeekActive(false);
    }
  }, []);

  /** 启动穿透键的长按计时（只启动一次，按键自动重复时不重复启动）。 */
  function startPeekTimer(repeat: boolean) {
    if (repeat || peekTimerRef.current !== null || peekActiveRef.current) return;
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null;
      peekActiveRef.current = true;
      setPeekActive(true);
    }, settingsRef.current.peekHoldMs);
  }

  /**
   * 编辑器键盘总处理。顺序很重要：
   *   IME 守卫 → 穿透键 / Tab → 撤销重做 → （浮层打开时）穿透判断 → 浮层快捷键。
   * Ctrl+S / F / H 在 H 节的 window 监听里处理；Ctrl+O 只在首页导入文件。
   */
  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const native = event.nativeEvent;

    // ① IME 守卫：组字期间一律不拦截。
    if (compositionRef.current || native.isComposing || native.keyCode === 229) return;

    const s = settingsRef.current;
    const noModifier = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

    // 「手速快」处理：浮层打开时，短按 Tab 的制表符要等 keyup 才补插入（为了和长按区分）。
    // 如果作者在 Tab 还没松开时就敲了下一个键，先把制表符补上、取消长按计时，再让这个键按顺序输入，
    // 否则两个字符的顺序会颠倒。
    if (
      s.peekKey === "Tab" &&
      peekTimerRef.current !== null &&
      !["Tab", "Shift", "Control", "Alt", "Meta"].includes(event.key)
    ) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
      insertTabCharacter();
    }

    // ② 穿透键
    if (event.key === s.peekKey) {
      if (s.peekKey === "Tab") {
        // Shift+Tab 等组合保持浏览器默认行为（把焦点移走）。
        if (!noModifier) return;
        // 无论如何不让焦点跑出编辑器：Tab 在写作软件里就是「输入一个制表符」。
        event.preventDefault();
        if (!candidateOpen) {
          // 没有浮层：就是普通文本编辑器的 Tab，立刻插入制表符。
          insertTabCharacter();
          return;
        }
        // 有浮层：长按 = 穿透；短按 = 普通的 Tab，在 keyup 里补插入制表符。
        startPeekTimer(event.repeat);
        return;
      }
      // 修饰键作穿透键：Alt 在 Windows 上会激活菜单栏，必须拦掉默认行为。
      if (s.peekKey === "Alt") event.preventDefault();
      startPeekTimer(event.repeat);
    }

    const commandKey = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (commandKey && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (commandKey && key === "y") {
      event.preventDefault();
      redo();
      return;
    }

    if (!candidateOpen) return;

    // ③ 穿透中：浮层完全不吃按键，数字、回车、空格、符号原样进入正文。
    if (peekActiveRef.current) return;
    // 穿透键是修饰键时，按住它的组合键（如 Shift+1 打「！」）也放行。
    const modifierHeld =
      (s.peekKey === "Shift" && event.shiftKey) ||
      (s.peekKey === "Alt" && event.altKey) ||
      (s.peekKey === "Control" && event.ctrlKey);
    if (modifierHeld) return;

    // ④ 浮层快捷键
    if (event.key === "Escape") {
      event.preventDefault();
      closeCandidates();
      return;
    }
    if (event.key === "PageDown") {
      event.preventDefault();
      setGlobalIndex(Math.min(page + 1, pageCount - 1) * pageSize);
      return;
    }
    if (event.key === "PageUp") {
      event.preventDefault();
      setGlobalIndex(Math.max(page - 1, 0) * pageSize);
      return;
    }
    if (candidateList.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setGlobalIndex((current) => {
        const next = current + direction;
        if (next < 0) return candidateList.length - 1;
        if (next >= candidateList.length) return 0;
        return next;
      });
      return;
    }
    const ready = candidateList.length > 0 && !candidateLoading;
    if (ready && event.key === "Enter") {
      event.preventDefault();
      pickCandidate(localIndex);
      return;
    }
    if (ready && matchesSampleKey(event.key, s.sampleKey)) {
      event.preventDefault();
      sampleCandidate();
      return;
    }
    if (ready && !event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
      const indexInPage = Number(event.key) - 1;
      if (visibleCandidates[indexInPage]) {
        event.preventDefault();
        pickCandidate(indexInPage);
      }
    }
  }

  /** keyup：穿透键松开。Tab 短按（长按计时器还没到）= 补插入一个制表符。 */
  function handleEditorKeyUp(event: KeyboardEvent<HTMLTextAreaElement>) {
    const s = settingsRef.current;
    if (event.key !== s.peekKey) return;
    const shortPress = peekTimerRef.current !== null;
    releasePeek();
    if (shortPress && s.peekKey === "Tab" && !compositionRef.current) {
      event.preventDefault();
      insertTabCharacter();
    }
  }

  function handleEditorChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const editor = event.currentTarget;
    const nextText = editor.value;
    const nextSelection = { start: editor.selectionStart, end: editor.selectionEnd };
    const inputType = (event.nativeEvent as InputEvent).inputType ?? "";

    recordHistory(inputType.startsWith("delete") ? "delete" : "typing", true);
    setEditorDocument(nextText, nextSelection);

    if (!compositionRef.current) scheduleCandidates(nextText, nextSelection);
  }

  function handleSelectionChange(next: SelectionRange) {
    const previous = selectionRef.current;
    if (previous.start === next.start && previous.end === next.end) return;

    selectionRef.current = next;
    setSelection(next);
    lastEditGroupRef.current = null;
    syncWindow(contentRef.current, next.start);
    if (!compositionRef.current) scheduleCandidates(contentRef.current, next);
  }

  /* ════════════════════════════════════════════════
     H. 副作用：查找/保存快捷键、穿透键复位、浮层定位、自动保存、后端、关窗落盘
     ════════════════════════════════════════════════ */

  /**
   * 打开查找面板。
   * 如果编辑器里正选中着文字，就把它（多行选区取第一行，最多 100 字）带进查找框，
   * 并把「当前匹配」定位到选区所在的那一处，这样「替换当前」作用的就是作者选中的那一处。
   */
  function openSearchPanel() {
    const editor = editorRef.current;
    if (editor && document.activeElement === editor && editor.selectionEnd > editor.selectionStart) {
      const start = editor.selectionStart;
      const firstLine = contentRef.current
        .slice(start, editor.selectionEnd)
        .split("\n")
        .find((line) => line.trim().length > 0);
      if (firstLine) {
        const picked = firstLine.slice(0, 100);
        setSearchQuery(picked);
        const matches = findMatches(contentRef.current, picked);
        const index = matches.findIndex((match) => match.start >= start);
        setActiveMatchIndex(index === -1 ? 0 : index);
      }
    }
    setSearchOpen(true);
    setSearchFocusSignal((n) => n + 1); // 通知 SearchPanel 重新聚焦并全选
  }
  openSearchRef.current = openSearchPanel;

  // 编辑器只处理查找与保存；Ctrl+O 仅在首页导入，避免编辑中切换文稿。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (compositionRef.current || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (key === "f" || key === "h") {
        event.preventDefault();
        openSearchRef.current();
      } else if (key === "s") {
        event.preventDefault();
        void performSaveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 穿透键松开 / 窗口失焦都要复位，否则浮层会一直淡化（监听挂在 window 上，覆盖焦点丢失的情况）。
  useEffect(() => {
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === settingsRef.current.peekKey) releasePeek();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releasePeek);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releasePeek);
    };
  }, [releasePeek]);

  /* ── 浮层定位（镜像 div 测量光标像素坐标） ── */
  const updatePositionRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (!candidateOpen) return;

    const updatePosition = () => {
      const editor = editorRef.current;
      const mirror = mirrorRef.current;
      const panel = panelRef.current;
      if (!editor || !mirror || !panel) return;

      const point = measureCaretPoint(editor, mirror, contentRef.current, selectionRef.current.start);
      if (!point) return;

      const bounds = panel.getBoundingClientRect();
      const edge = 14;
      const footerRoom = 62;
      let left = point.left;
      let top = point.bottom + 8;

      // 右边放不下就翻到左侧
      if (left + bounds.width > window.innerWidth - edge) left = point.left - bounds.width;
      left = Math.max(edge, Math.min(left, window.innerWidth - bounds.width - edge));

      // 下边放不下就翻到光标上方
      if (top + bounds.height > window.innerHeight - footerRoom) top = point.top - bounds.height - 8;
      top = Math.max(edge, Math.min(top, window.innerHeight - bounds.height - edge));

      setCandidatePosition((prev) =>
        prev && Math.abs(prev.left - left) < 1 && Math.abs(prev.top - top) < 1 ? prev : { left, top },
      );
    };

    updatePosition();
    updatePositionRef.current = updatePosition;
    window.addEventListener("resize", updatePosition);
    return () => {
      updatePositionRef.current = null;
      window.removeEventListener("resize", updatePosition);
    };
  }, [candidateOpen, candidateList, candidateLoading, candidateError, content, selection, settings.fontSize, page]);

  // 自动保存：开关 + 周期都可配。关掉开关后只能手动保存（顶部按钮或 Ctrl+S）。
  useEffect(() => {
    if (!autoSaveEnabled || saveStatus !== "dirty" || isComposing) return;
    const timer = window.setTimeout(() => {
      void performSaveRef.current();
    }, settings.autoSaveInterval);
    return () => window.clearTimeout(timer);
  }, [autoSaveEnabled, saveStatus, isComposing, settings.autoSaveInterval]);

  // 关窗前落盘：浏览器用 beforeunload（localStorage 是同步的，来得及）；
  // Electron 由主进程发 flush 请求，renderer 保存完回 confirmClose。
  useEffect(() => {
    const onBeforeUnload = () => {
      if (saveVersionRef.current !== savedVersionRef.current) void performSaveRef.current();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    const unsubscribe = window.api?.onFlushRequest?.(() => {
      void performSaveRef.current().then((saved) => {
        if (saved) window.api?.confirmClose?.();
      });
    });
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  // 在首页卸载编辑器时取消候选计时与请求，旧候选不能回写到另一篇文稿。
  useEffect(() => () => {
    if (candidateTimerRef.current !== null) window.clearTimeout(candidateTimerRef.current);
    inFlightRef.current?.abort();
    pendingJobRef.current = null;
    flashTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    flashTimersRef.current.clear();
  }, []);

  // 高亮层要跟着 textarea 一起滚动，否则背景会和文字错位。
  function syncHighlightScroll() {
    const editor = editorRef.current;
    const layer = highlightRef.current;
    if (!editor || !layer) return;
    layer.scrollTop = editor.scrollTop;
    layer.scrollLeft = editor.scrollLeft;
  }

  /* ════════════════════════════════════════════════
     I. 查找替换 / 上下文 / 锚点 / Toast / 后端
     ════════════════════════════════════════════════ */

  const searchMatches = useMemo(() => findMatches(content, searchQuery), [content, searchQuery]);
  const safeMatchIndex = searchMatches.length === 0 ? -1 : Math.min(activeMatchIndex, searchMatches.length - 1);
  const characterCount = useMemo(() => Array.from(content.replace(/\s/g, "")).length, [content]);
  const canUndo = useMemo(() => undoStackRef.current.length > 0, [historyRevision]);
  const canRedo = useMemo(() => redoStackRef.current.length > 0, [historyRevision]);

  function replaceCurrentMatch() {
    const match = searchMatches[safeMatchIndex];
    if (!match) return;
    const nextText = contentRef.current.slice(0, match.start) + replacement + contentRef.current.slice(match.end);
    const caret = match.start + replacement.length;
    applyProgrammaticEdit(nextText, { start: caret, end: caret }, "replace");
  }

  function replaceAllMatches() {
    if (!searchQuery || searchMatches.length === 0) return;
    const first = searchMatches[0];
    const nextText = contentRef.current.split(searchQuery).join(replacement);
    const caret = first.start + replacement.length;
    applyProgrammaticEdit(nextText, { start: caret, end: caret }, "replace");
    setActiveMatchIndex(0);
  }

  function updateContext<K extends keyof ContextState>(key: K, value: ContextState[K]) {
    contextRef.current = { ...contextRef.current, [key]: value };
    setContext((prev) => ({ ...prev, [key]: value }));
    markDirty();
    // 大纲内容或锚点变了 = 进入新一段语境，EOS 提醒重新计数。
    if (key === "outlineText" || key === "anchor") {
      eosCounterRef.current = 0;
      eosDismissedRef.current = false;
    }
    // 上下文变化会改变 prompt：有焦点时立即重新预测（同时重新检查锚点硬上限）
    if (editorFocusedRef.current && !compositionRef.current) {
      syncWindow(contentRef.current, selectionRef.current.start);
      scheduleCandidates(contentRef.current, selectionRef.current);
    } else {
      syncWindow(contentRef.current, selectionRef.current.start);
    }
  }

  /** 「锚定本章起点」：对齐到光标所在段落的段首，并记录指纹。 */
  function anchorHere() {
    const text = contentRef.current;
    const caret = selectionRef.current.start;
    const offset = snapAnchorOffset(text, caret);
    updateContext("anchor", { offset, fingerprint: makeFingerprint(text, offset) });
    if (offset !== caret) {
      flash("anchor", () => setAnchorNotice("锚点已自动对齐到本段段首。"), () => setAnchorNotice(null), 4000);
    }
  }

  /** 把光标移到锚点，方便作者确认锚点位置。 */
  function locateAnchor() {
    const anchor = contextRef.current.anchor;
    const editor = editorRef.current;
    if (!anchor || !editor) return;
    editor.focus();
    editor.setSelectionRange(anchor.offset, anchor.offset);
    handleSelectionChange({ start: anchor.offset, end: anchor.offset });
  }

  function clearAnchor() {
    updateContext("anchor", null);
    setAnchorNotice(null);
  }

  /** 「查看日志」：主进程若能用系统方式打开就不弹窗，否则把文本显示在弹窗里。 */
  async function openBackendLog() {
    const text = await backend.openLog();
    if (text !== null) setLogText(text);
  }

  /* ════════════════════════════════════════════════
     J. 渲染用的派生值
     ════════════════════════════════════════════════ */

  const saveLabel: Record<SaveStatus, string> = {
    saved: "已保存",
    saving: "正在保存…",
    dirty: autoSaveEnabled ? "待自动保存" : "未保存",
    error: "保存失败",
  };

  // 只有真正有大纲文字时才算启用大纲；空大纲与关闭大纲等价，不展示锚点或范围高亮。
  const outlineActive = context.outlineEnabled && context.outlineText.trim().length > 0;
  const anchorFallbackActive =
    outlineActive && context.anchor !== null && selection.start < context.anchor.offset;

  // 大纲实际参与 prompt 时，给「本次真正送入模型的正文范围」加背景。
  // 锚点之后高亮锚点段落至光标；光标在锚点前时高亮回退滑窗，不会标错锚点范围。
  const highlightRange = outlineActive
    ? { start: promptPreview.bodyStart, end: promptPreview.bodyEnd }
    : null;

  // 锚点前回退提示会放在主编辑区，不在侧栏重复显示。
  const allNotices = [
    ...promptPreview.notices.filter((notice) => notice !== ANCHOR_BEFORE_CURSOR_NOTICE),
    ...(windowNotice ? [windowNotice] : []),
  ];

  const peekKeyLabel = PEEK_KEY_SHORT[settings.peekKey];
  const sampleKeyLabel = SAMPLE_KEY_SHORT[settings.sampleKey];

  /** 浮层淡化：长按穿透键，或（开启「浮窗常驻」时）输入法正在组字。 */
  const popoverFaded = peekActive || (isComposing && settings.keepPopover);

  const statusHint = isComposing
    ? settings.keepPopover
      ? "输入法组字中，浮窗已淡化，上屏后自动刷新"
      : "输入法组字中，候选暂停"
    : anchorNotice
      ? anchorNotice
      : windowNotice
        ? windowNotice
        : rebuildHint
          ? rebuildHint
          : settings.quickMode
            ? `快速模式常驻 · 长按 ${peekKeyLabel} 暂时穿透浮层`
            : `停顿后出现候选 · ↑↓ 选择 · Enter 插入${sampleKeyLabel ? ` · ${sampleKeyLabel}随机` : ""}`;

  return (
    <div
      className="app-root"
      data-theme={settings.theme}
      style={
        {
          "--editor-font-size": `${settings.fontSize}px`,
          "--popover-fade-opacity": settings.fadeOpacity,
        } as CSSProperties
      }
    >
      {/* ══ 顶部状态条 ══ */}
      <header className="topbar">
        <div className="brand-area">
          <button
            className="editor-back-button"
            type="button"
            disabled={returning}
            title="保存并返回文库"
            onClick={() => void handleReturnHome()}
          >
            <Icon name="arrow-left" size={17} />
            <span>{returning ? "正在保存" : "文库"}</span>
          </button>
          <span className="topbar-divider" aria-hidden="true" />
          <div className="brand-mark" aria-hidden="true">
            <BrandLogo size={32} />
          </div>
          <div className="brand-copy">
            <span className="brand-name">PickWord</span>
            <span className="brand-caption">本地写作</span>
          </div>
          <span className="topbar-divider" aria-hidden="true" />
          <BackendStatusBar
            status={backendStatus}
            progress={backend.progress}
            isDemo={candidateSource.isDemo}
            compact
            onRetry={backend.retry}
            onOpenLog={() => void openBackendLog()}
          />
        </div>

        <div className="toolbar" aria-label="文稿工具列">
          <button
            className="icon-button history-button"
            type="button"
            title="撤销 Ctrl+Z"
            aria-label="撤销"
            disabled={!canUndo}
            onClick={undo}
          >
            <Icon name="undo" />
          </button>
          <button
            className="icon-button history-button"
            type="button"
            title="重做 Ctrl+Y"
            aria-label="重做"
            disabled={!canRedo}
            onClick={redo}
          >
            <Icon name="redo" />
          </button>

          <span className="toolbar-divider" aria-hidden="true" />

          <button
            className="icon-button tool-button"
            type="button"
            title="保存 Ctrl+S"
            aria-label="保存"
            onClick={() => void performSave()}
          >
            <Icon name="save" />
            <span>保存</span>
          </button>
          <button
            className="icon-button history-button"
            type="button"
            title="导出 / 另存为 .txt"
            aria-label="导出为 txt"
            onClick={exportTxt}
          >
            <Icon name="export" />
          </button>
          <label className="autosave-toggle" title="自动保存周期可在设置中调整">
            <button
              className={`switch switch-small ${autoSaveEnabled ? "is-on" : ""}`}
              type="button"
              role="switch"
              aria-checked={autoSaveEnabled}
              aria-label="自动保存"
              onClick={() => onToggleAutoSave(!autoSaveEnabled)}
            >
              <span />
            </button>
            <span>自动保存</span>
          </label>

          <span className="toolbar-divider" aria-hidden="true" />

          <button
            className={`icon-button tool-button ${searchOpen ? "is-active" : ""}`}
            type="button"
            title="查找与替换 Ctrl+F"
            aria-label="查找与替换"
            aria-pressed={searchOpen}
            onClick={() => {
              if (searchOpen) setSearchOpen(false);
              else openSearchPanel();
            }}
          >
            <Icon name="search" />
            <span>查找</span>
          </button>
          <button
            className={`icon-button tool-button ${sidebarOpen ? "is-active" : ""}`}
            type="button"
            title="写作上下文（风格 / 大纲）"
            aria-label="写作上下文"
            aria-pressed={sidebarOpen}
            onClick={() => {
              const next = !sidebarOpen;
              setSidebarOpen(next);
            }}
          >
            <Icon name="sidebar" />
            <span>上下文</span>
          </button>
        </div>
      </header>

      {/* ══ 工作区 ══ */}
      <main className="workspace">
        {searchOpen && (
          <SearchPanel
            focusSignal={searchFocusSignal}
            query={searchQuery}
            replacement={replacement}
            matches={searchMatches}
            activeIndex={safeMatchIndex}
            onQueryChange={(value) => {
              setSearchQuery(value);
              setActiveMatchIndex(0);
            }}
            onReplacementChange={setReplacement}
            onSelectMatch={(match, index) => {
              const editor = editorRef.current;
              if (!editor) return;
              setActiveMatchIndex(index);
              editor.focus();
              editor.setSelectionRange(match.start, match.end);
              handleSelectionChange({ start: match.start, end: match.end });
            }}
            onReplaceCurrent={replaceCurrentMatch}
            onReplaceAll={replaceAllMatches}
            onClose={() => setSearchOpen(false)}
          />
        )}

        <section className="editor-stage" aria-label="写作区" onScroll={() => updatePositionRef.current?.()}>
          <div className="document-sheet">
            <div className="writing-column">
              {fileBanner && (
                <div className={`file-banner is-${fileBanner.kind}`} role="status">
                  <span>{fileBanner.text}</span>
                  <button className="link-button" type="button" onClick={() => setFileBanner(null)}>
                    知道了
                  </button>
                </div>
              )}

              {anchorFallbackActive && (
                <div className="file-banner is-info context-fallback-banner" role="status">
                  <span>{ANCHOR_BEFORE_CURSOR_NOTICE}</span>
                </div>
              )}

              <div className="document-heading">
                <input
                  className="document-title"
                  type="text"
                  aria-label="文稿标题"
                  value={title}
                  onChange={(event) => {
                    titleRef.current = event.target.value;
                    setTitle(event.target.value);
                    markDirty();
                  }}
                  placeholder="无题"
                />
                <span className="title-rule" aria-hidden="true" />
              </div>

              {/* 编辑器外壳：高亮层在下，透明 textarea 在上，两层字体必须完全一致 */}
              <div className="editor-shell">
                <div className="highlight-layer" ref={highlightRef} aria-hidden="true">
                  {highlightRange ? (
                    <>
                      <span>{content.slice(0, highlightRange.start)}</span>
                      <span className={`context-span ${promptPreview.anchored ? "is-anchored" : ""}`}>
                        {content.slice(highlightRange.start, highlightRange.end)}
                      </span>
                      <span>{content.slice(highlightRange.end)}</span>
                    </>
                  ) : null}
                  {"\n"}
                </div>

                <textarea
                  ref={editorRef}
                  className="writing-area"
                  value={content}
                  aria-label="纯文本正文"
                  placeholder="在这里开始写作。停顿片刻后，下一个词会出现在光标下方。"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={handleEditorChange}
                  onSelect={(event) => {
                    const editor = event.currentTarget;
                    handleSelectionChange({ start: editor.selectionStart, end: editor.selectionEnd });
                  }}
                  onFocus={() => {
                    editorFocusedRef.current = true;
                    const editor = editorRef.current;
                    if (!editor || compositionRef.current) return;
                    const range = { start: editor.selectionStart, end: editor.selectionEnd };
                    selectionRef.current = range;
                    setSelection(range);
                    syncWindow(contentRef.current, range.start);
                    scheduleCandidates(contentRef.current, range);
                  }}
                  onBlur={() => {
                    editorFocusedRef.current = false;
                    releasePeek();
                    closeCandidates();
                  }}
                  onKeyDown={handleEditorKeyDown}
                  onKeyUp={handleEditorKeyUp}
                  onCompositionStart={handleCompositionStart}
                  onCompositionUpdate={handleCompositionUpdate}
                  onCompositionEnd={handleCompositionEnd}
                  onScroll={() => {
                    syncHighlightScroll();
                    updatePositionRef.current?.();
                  }}
                />
              </div>
            </div>
          </div>
        </section>

        {sidebarOpen && (
          <ContextSidebar
            {...context}
            mode={promptPreview.mode}
            anchored={promptPreview.anchored}
            anchorHardLimit={promptPreview.hardLimit}
            notices={allNotices}
            anchorNotice={anchorNotice}
            bodyLength={promptPreview.bodyEnd - promptPreview.bodyStart}
            outlineRef={outlineInputRef}
            outlineHighlighted={outlineHighlighted}
            onChange={updateContext}
            onAnchorHere={anchorHere}
            onLocateAnchor={locateAnchor}
            onClearAnchor={clearAnchor}
            onClose={() => setSidebarOpen(false)}
          />
        )}
      </main>

      {/* ══ 底部状态条 ══ */}
      <footer className="statusbar">
        <div className="statusbar-left">
          <span className="character-count">{characterCount}</span>
          <span>字</span>
          <span className="statusbar-mode">
            {PROMPT_MODE_LABEL[promptPreview.mode]}
            {promptPreview.anchored ? " · 锚点" : ""}
          </span>
        </div>
        <div
          className={`statusbar-hint ${anchorNotice || windowNotice || rebuildHint ? "is-notice" : ""}`}
          title={statusHint}
        >
          {statusHint}
        </div>
        <div className="statusbar-right">
          <span className={`save-indicator ${saveStatus === "error" ? "has-error" : ""}`} aria-live="polite">
            <span className="save-dot" />
            {saveLabel[saveStatus]}
          </span>
          {(candidateSource.isDemo || libraryProvider.isDemo) && (
            <span className="demo-label">{libraryProvider.isDemo ? "文库演示" : "候选演示"}</span>
          )}
        </div>
      </footer>

      {/* ══ 候选浮层 ══ */}
      {candidateOpen && (
        <CandidatePopover
          panelRef={panelRef}
          position={candidatePosition}
          visible={visibleCandidates}
          selectedIndex={localIndex}
          loading={candidateLoading}
          error={candidateError}
          notice={candidateNotice}
          page={page}
          pageCount={pageCount}
          totalCount={candidateList.length}
          faded={popoverFaded}
          prefillChars={prefillChars}
          peekKeyLabel={peekKeyLabel}
          sampleKeyLabel={sampleKeyLabel}
          onHover={(index) => setGlobalIndex(page * pageSize + index)}
          onPick={pickCandidate}
          onRetry={() => scheduleCandidates(contentRef.current, selectionRef.current, true)}
        />
      )}

      {/* 测量光标用的隐藏镜像层 */}
      <div ref={mirrorRef} className="caret-mirror" aria-hidden="true" />

      {/* ══ EOS 弱提醒 Toast（绝不阻塞打字） ══ */}
      {toastVisible && (
        <GentleToast
          message="模型认为本段剧情可能已收束。需要更新本章大纲吗？"
          onPrimary={() => {
            setToastVisible(false);
            setSidebarOpen(true);
            if (!contextRef.current.outlineEnabled) updateContext("outlineEnabled", true);
            setOutlineHighlighted(true);
            // 等侧边栏渲染出来后再聚焦大纲框
            window.setTimeout(() => {
              outlineInputRef.current?.focus();
              window.setTimeout(() => setOutlineHighlighted(false), 1600);
            }, 60);
          }}
          onDismiss={() => {
            setToastVisible(false);
            eosDismissedRef.current = true; // 本片段内不再提示
            eosCounterRef.current = 0;
          }}
        />
      )}

      {/* ══ 日志弹窗 ══ */}
      {logText !== null && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLogText(null);
          }}
        >
          <section className="log-dialog" role="dialog" aria-modal="true" aria-labelledby="log-title">
            <div className="panel-heading">
              <div>
                <span className="panel-eyebrow">本地服务</span>
                <h2 id="log-title">模型日志</h2>
              </div>
              <button
                className="icon-button panel-close"
                type="button"
                onClick={() => setLogText(null)}
                aria-label="关闭日志"
              >
                <Icon name="close" />
              </button>
            </div>
            <pre>{logText}</pre>
          </section>
        </div>
      )}
    </div>
  );
}

interface ActiveManuscript {
  entry: LibraryEntry;
  document: DocumentPayload;
}

/**
 * 应用入口：启动先进入文库，只有选择了某篇文稿才挂载编辑器。
 * 每篇文稿独立按 id 读取/保存；editor 的 key 也使用 id，切换时自动隔离撤销栈、
 * 候选请求、光标和输入法状态，避免另一篇文稿继承旧编辑器的临时状态。
 */
export default function App() {
  const [settings, setSettings] = useState<SettingsValues>(() => loadSettings(SETTINGS_KEY));
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [directory, setDirectory] = useState<LibraryDirectory>({
    path: libraryProvider.isDemo ? "项目目录 / manuscripts（浏览器演示）" : "正在读取保存位置…",
    isDefault: true,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveManuscript | null>(null);
  const [homeLogText, setHomeLogText] = useState<string | null>(null);

  // 首页也要显示模型加载进度；与编辑器共用同一份缓存，切页不会重新从 0% 开始。
  const backend = useBackendStatus(candidateSource.isDemo);

  // StrictMode 在开发环境会模拟一次挂载/卸载；active 防止第一次异步读取覆盖第二次结果。
  useEffect(() => {
    let alive = true;
    void Promise.all([libraryProvider.list(), libraryProvider.getDirectory()])
      .then(([items, location]) => {
        if (!alive) return;
        setEntries(sortLibrary(items));
        setDirectory(location);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : "文库读取失败。 ");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // 首选项存储失败不影响正文；真实文稿保存仍由 LibraryProvider 校验。
    }
  }, [settings]);

  /** 返回首页或更换目录后重新扫描文库，不保留旧排序缓存。 */
  async function refresh() {
    setLoading(true);
    try {
      const [items, location] = await Promise.all([libraryProvider.list(), libraryProvider.getDirectory()]);
      setEntries(sortLibrary(items));
      setDirectory(location);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文库读取失败。 ");
      throw caught;
    } finally {
      setLoading(false);
    }
  }

  async function openManuscript(id: string) {
    const document = await libraryProvider.read(id);
    const entry = await libraryProvider.touch(id);
    setEntries((current) => sortLibrary(current.map((item) => item.id === id ? entry : item)));
    setActive({ entry, document });
  }

  async function createManuscript() {
    const document: DocumentPayload = {
      title: "未命名文稿",
      content: "",
      styleText: "",
      outlineText: "",
      styleEnabled: false,
      outlineEnabled: false,
      anchor: null,
    };
    const entry = await libraryProvider.create(document, "txt");
    setEntries((current) => sortLibrary([entry, ...current]));
    setActive({ entry, document: { ...document, title: entry.title } });
  }

  async function renameManuscript(id: string, title: string) {
    const updated = await libraryProvider.rename(id, title);
    setEntries((current) => sortLibrary(current.map((item) => item.id === id ? updated : item)));
  }

  async function deleteManuscripts(ids: string[]) {
    await libraryProvider.remove(ids);
    const deleting = new Set(ids);
    setEntries((current) => current.filter((item) => !deleting.has(item.id)));
  }

  /** 选择器与系统拖拽共用此解析路径；失败文件不阻止成功的文件入库。 */
  async function importManuscripts(files: File[]): Promise<ImportReport> {
    const errors: string[] = [];
    let imported = 0;
    for (const file of files.slice(0, 20)) {
      try {
        // 先检查 File.size，避免把数 GB 的拖入文件整体读进 renderer 内存。
        if (file.size > MAX_FILE_BYTES) throw new Error("文件超过 30 MB，无法导入。");
        const parsed = await parseOpenedFile(file.name, new Uint8Array(await file.arrayBuffer()));
        const format: LibraryFormat = parsed.format === "docx"
          ? "docx"
          : /\.(md|markdown)$/i.test(file.name) ? "md" : "txt";
        const document: DocumentPayload = {
          title: parsed.title,
          content: parsed.text,
          styleText: "",
          outlineText: "",
          styleEnabled: false,
          outlineEnabled: false,
          anchor: null,
        };
        const entry = await libraryProvider.create(document, format);
        setEntries((current) => sortLibrary([entry, ...current]));
        imported += 1;
      } catch (caught) {
        errors.push(`${file.name}：${caught instanceof Error ? caught.message : "读取失败"}`);
      }
    }
    if (files.length > 20) errors.push("一次最多导入 20 篇，请分批操作");
    return { imported, errors };
  }

  async function chooseDirectory(): Promise<boolean> {
    const location = await libraryProvider.chooseDirectory();
    if (!location) return false;
    // 主进程必须迁移成功后才返回新目录；刷新确保封面来自迁移后的列表。
    await refresh();
    return true;
  }

  async function resetDirectory() {
    await libraryProvider.resetDirectory();
    await refresh();
  }

  function changeSetting<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function resetAdvanced() {
    const defaults = DEFAULT_SETTINGS;
    setSettings((current) => ({
      ...current,
      modelContextLen: defaults.modelContextLen,
      maxBodyLen: defaults.maxBodyLen,
      windowAdvanceMinChars: defaults.windowAdvanceMinChars,
      anchorWarnLen: defaults.anchorWarnLen,
      softenTemperature: defaults.softenTemperature,
      eosScanTopN: defaults.eosScanTopN,
      eosMinProb: defaults.eosMinProb,
      eosThreshold: defaults.eosThreshold,
      prefillHintSeconds: defaults.prefillHintSeconds,
      fadeOpacity: defaults.fadeOpacity,
      peekKey: defaults.peekKey,
      peekHoldMs: defaults.peekHoldMs,
      sampleKey: defaults.sampleKey,
    }));
  }

  if (active) {
    const id = active.entry.id;
    return (
      <WritingEditor
        key={id}
        initial={active.document}
        sourceFormat={active.entry.sourceFormat}
        settings={settings}
        onToggleAutoSave={(enabled) => changeSetting("autoSaveEnabled", enabled)}
        onSave={async (document) => {
          const updated = await libraryProvider.save(id, document);
          setEntries((current) => sortLibrary(current.map((item) => item.id === id ? updated : item)));
          setActive((current) => current?.entry.id === id ? { ...current, entry: updated } : current);
          return updated;
        }}
        onBack={() => {
          setActive(null);
          void refresh().catch(() => undefined);
        }}
      />
    );
  }

  return (
    <div className="app-root" data-theme={settings.theme}>
      <LibraryHome
        entries={entries}
        directory={directory}
        settings={settings}
        loading={loading}
        error={error}
        isDemo={libraryProvider.isDemo}
        hasLegacyApi={Boolean(window.api?.saveDocument)}
        backendStatus={backend.status}
        backendProgress={backend.progress}
        backendIsDemo={candidateSource.isDemo}
        onBackendRetry={backend.retry}
        onBackendLog={() => {
          void backend.openLog().then((text) => {
            if (text !== null) setHomeLogText(text);
          });
        }}
        onRefresh={refresh}
        onOpen={openManuscript}
        onCreate={createManuscript}
        onRename={renameManuscript}
        onDelete={deleteManuscripts}
        onImport={importManuscripts}
        onChooseDirectory={chooseDirectory}
        onResetDirectory={resetDirectory}
        onSettingsChange={changeSetting}
        onResetAdvanced={resetAdvanced}
      />

      {homeLogText !== null && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setHomeLogText(null);
          }}
        >
          <section className="log-dialog" role="dialog" aria-modal="true" aria-labelledby="home-log-title">
            <div className="panel-heading">
              <div>
                <span className="panel-eyebrow">本地服务</span>
                <h2 id="home-log-title">模型日志</h2>
              </div>
              <button className="icon-button panel-close" type="button" onClick={() => setHomeLogText(null)} aria-label="关闭日志">
                <Icon name="close" />
              </button>
            </div>
            <pre>{homeLogText}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
