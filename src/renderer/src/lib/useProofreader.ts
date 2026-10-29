/**
 * 纠错的编排：窗口 → 请求（槽 1）→ 解析定位 → 合并；本地提示的防抖计算；
 * 两层结果随编辑平移；忽略 / 清除。编辑器只负责把编辑事件喂进来、把结果画出来。
 *
 * 槽位：槽 0 留给候选 + 短句展开，纠错固定用槽 1（槽位不够时直接不可用，面板会说明怎么开）。
 *
 * ★ 人设校验（角色卡 × 正文）已于 2026-10-25 删除：小模型做不稳，误报漏报都高。
 *   人物与设定从此不与模型交互；lib/materials.ts 的正则统计与 lib/monotony.ts 的本地提示照旧。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { chooseCompletionSource } from "./completion";
import { mapOffsetThroughEdit, paragraphStartAt, type EditSpan } from "./editorText";
import { findLocalHints } from "./monotony";
import {
  PROOFREAD_GRAMMAR,
  PROOFREAD_SAMPLING,
  PROOF_IDLE_MS,
  PROOF_MIN_NEW_CHARS,
  PROOF_MIN_WINDOW,
  buildProofreadPrompt,
  findingsToIssues,
  issueAtOffset,
  mapIssuesThroughEdit,
  maskChapterMarks,
  mergeLlmIssues,
  parseFindings,
  resolveProofWindow,
  type Issue,
  type IssueKind,
  type ProofWindow,
} from "./proofread";
import type { PromptTemplate } from "./types";
import type { ProofStatus } from "../components/workbench/ProofreadTab";

const completionSource = chooseCompletionSource();

/** 纠错用的槽位：槽 0 留给候选 + 展开。 */
export const PROOFREAD_SLOT = 1;
/** 纠错窗口覆盖的问题类别（合并时只替换这些）。 */
const PROOFREAD_KINDS: ReadonlySet<IssueKind> = new Set<IssueKind>(["grammar", "monotony"]);
/** 本地提示：光标前后各看多远。 */
const LOCAL_BACK = 15000;
const LOCAL_AHEAD = 3000;
const LOCAL_DEBOUNCE_MS = 600;

export interface ProofreaderArgs {
  content: string;
  caret: number;
  template: PromptTemplate;
  /** 见 ModelProfile.noThinkPrefix。 */
  noThinkPrefix: string;
  /** 模型就绪（演示模式恒为 true）。 */
  backendReady: boolean;
  slots: number;
  auto: boolean;
  local: boolean;
  /** 人名与别名：本地提示不把它们当重复，同时用来查专名写法。 */
  ignoreNames: readonly string[];
}

export interface Proofreader {
  issues: Issue[];
  activeIssue: Issue | null;
  status: ProofStatus;
  available: boolean;
  isDemo: boolean;
  run: (manual: boolean) => void;
  cancel: () => void;
  dismiss: (issue: Issue) => void;
  clearAll: () => void;
  /** 每次文本变化都要调用（setEditorDocument 里），问题随之平移。 */
  onEdit: (span: EditSpan) => void;
}

export function useProofreader(args: ProofreaderArgs): Proofreader {
  const { content, caret, template, noThinkPrefix, backendReady, slots, auto, local, ignoreNames } = args;
  const isDemo = completionSource.isDemo;
  const available = backendReady && (isDemo || slots > PROOFREAD_SLOT);

  const [llmIssues, setLlmIssues] = useState<Issue[]>([]);
  const [localIssues, setLocalIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<ProofStatus>({ state: "idle" });

  const contentRef = useRef(content);
  const caretRef = useRef(caret);
  const templateRef = useRef(template);
  const noThinkRef = useRef(noThinkPrefix);
  const slotsRef = useRef(slots);
  useLayoutEffect(() => {
    contentRef.current = content;
    caretRef.current = caret;
    templateRef.current = template;
    noThinkRef.current = noThinkPrefix;
    slotsRef.current = slots;
  });

  const dismissedRef = useRef(new Set<string>());
  const windowStartRef = useRef<number | null>(null);
  /** 自上次检查以来新写的字数（只数插入），光标跳来跳去也不受影响。 */
  const writtenRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  /** 请求在飞期间发生的编辑：结果回来后按顺序把偏移穿过去。 */
  const pendingSpansRef = useRef<EditSpan[]>([]);

  const onEdit = useCallback((span: EditSpan) => {
    if (span.changeStart === span.oldEnd && span.delta === 0) return;
    if (span.delta > 0) writtenRef.current += span.delta;
    if (windowStartRef.current !== null) {
      windowStartRef.current = mapOffsetThroughEdit(windowStartRef.current, span);
    }
    pendingSpansRef.current.push(span);
    setLlmIssues((prev) => (prev.length === 0 ? prev : mapIssuesThroughEdit(prev, span)));
    setLocalIssues((prev) => (prev.length === 0 ? prev : mapIssuesThroughEdit(prev, span)));
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const run = useCallback(
    (manual: boolean, windowOverride?: ProofWindow) => {
      if (!available || controllerRef.current) return;
      const text = contentRef.current;
      const win = windowOverride ?? resolveProofWindow(text, caretRef.current, windowStartRef.current, manual);
      if (win.end - win.start < PROOF_MIN_WINDOW) {
        if (manual) setStatus({ state: "error", message: "光标前面还没有足够的文字可查。" });
        return;
      }
      const windowText = maskChapterMarks(text.slice(win.start, win.end));

      windowStartRef.current = win.start;
      writtenRef.current = 0;
      const prompt = buildProofreadPrompt(templateRef.current, windowText, noThinkRef.current);
      const slot = PROOFREAD_SLOT;
      if (!isDemo && slotsRef.current <= slot) {
        if (manual) setStatus({ state: "error", message: `本地模型只开了 ${slotsRef.current} 个槽位，纠错需要第 ${slot + 1} 个。` });
        return;
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      pendingSpansRef.current = [];
      setStatus({ state: "running", chars: windowText.length });
      const started = performance.now();

      const request = (withGrammar: boolean) =>
        completionSource.provider(
          {
            requestId: crypto.randomUUID(),
            prompt,
            idSlot: slot,
            nPredict: PROOFREAD_SAMPLING.nPredict,
            temperature: PROOFREAD_SAMPLING.temperature,
            topP: PROOFREAD_SAMPLING.topP,
            grammar: withGrammar ? PROOFREAD_GRAMMAR : undefined,
          },
          controller.signal,
        );

      void (async () => {
        try {
          let result;
          try {
            result = await request(true);
          } catch (err) {
            // 旧版 llama-server 可能不认识文法里的重复语法：退回无文法，解析器本身是容错的
            if (controller.signal.aborted || !/grammar/i.test(errorMessage(err))) throw err;
            result = await request(false);
          }
          // 撞到 n_predict 上限时最后一行是残的（改法可能只写了一半），丢掉
          const output = result.stopType === "limit" ? result.text.slice(0, result.text.lastIndexOf("\n") + 1) : result.text;
          let fresh = findingsToIssues(parseFindings(output), windowText, win.start);
          let mapped: ProofWindow = win;
          for (const span of pendingSpansRef.current) {
            fresh = mapIssuesThroughEdit(fresh, span);
            mapped = { start: mapOffsetThroughEdit(mapped.start, span), end: mapOffsetThroughEdit(mapped.end, span) };
          }
          const dismissed = dismissedRef.current;
          setLlmIssues((prev) => mergeLlmIssues(prev, fresh, mapped, dismissed, PROOFREAD_KINDS));
          setStatus({
            state: "done",
            at: Date.now(),
            chars: windowText.length,
            ms: performance.now() - started,
            found: fresh.filter((issue) => !dismissed.has(issue.key)).length,
          });
        } catch (err) {
          if (controller.signal.aborted) setStatus({ state: "idle" });
          else setStatus({ state: "error", message: errorMessage(err) });
        } finally {
          if (controllerRef.current === controller) controllerRef.current = null;
          pendingSpansRef.current = [];
        }
      })();
    },
    [available, isDemo],
  );

  // 卸载时中断在飞请求
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  // 自动检查：停笔 PROOF_IDLE_MS 且新写满 PROOF_MIN_NEW_CHARS
  useEffect(() => {
    if (!auto || !available) return;
    const timer = window.setTimeout(() => {
      if (writtenRef.current >= PROOF_MIN_NEW_CHARS) run(false);
    }, PROOF_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [content, caret, auto, available, run]);

  // 本地提示：防抖后在光标附近重算
  const namesKey = ignoreNames.join("\u0000");
  useEffect(() => {
    if (!local) return;
    const timer = window.setTimeout(() => {
      const text = contentRef.current;
      const at = paragraphStartAt(text, caretRef.current);
      const next = findLocalHints(text, at - LOCAL_BACK, caretRef.current + LOCAL_AHEAD, {
        ignoreNames: namesKey ? namesKey.split("\u0000") : [],
        dismissed: dismissedRef.current,
      });
      setLocalIssues((prev) => (sameIssues(prev, next) ? prev : next));
    }, LOCAL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [content, caret, local, namesKey]);

  const issues = useMemo(() => {
    const merged = local ? [...llmIssues, ...localIssues] : [...llmIssues];
    return merged.sort((a, b) => a.ranges[0].start - b.ranges[0].start);
  }, [llmIssues, localIssues, local]);

  const activeIssue = useMemo(() => issueAtOffset(issues, caret), [issues, caret]);

  const dismiss = useCallback((issue: Issue) => {
    dismissedRef.current.add(issue.key);
    setLlmIssues((prev) => prev.filter((item) => item.id !== issue.id));
    setLocalIssues((prev) => prev.filter((item) => item.id !== issue.id));
  }, []);

  const clearAll = useCallback(() => {
    setLlmIssues([]);
    setLocalIssues((prev) => {
      for (const issue of prev) dismissedRef.current.add(issue.key);
      return [];
    });
  }, []);

  return {
    issues,
    activeIssue,
    status,
    available,
    isDemo,
    run,
    cancel,
    dismiss,
    clearAll,
    onEdit,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 本地提示重算后内容没变就复用旧数组，避免无谓重渲染（id 不同但键与范围都一样）。 */
function sameIssues(a: Issue[], b: Issue[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].key !== b[i].key || a[i].ranges.length !== b[i].ranges.length) return false;
    for (let j = 0; j < a[i].ranges.length; j += 1) {
      if (a[i].ranges[j].start !== b[i].ranges[j].start || a[i].ranges[j].end !== b[i].ranges[j].end) return false;
    }
  }
  return true;
}
