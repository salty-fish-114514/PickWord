/**
 * 纠错 / 人设校验的编排：窗口 → 请求（槽 1 / 槽 2）→ 解析定位 → 合并；本地提示的防抖计算；
 * 两层结果随编辑平移；忽略 / 清除。编辑器只负责把编辑事件喂进来、把结果画出来。
 *
 * 两个模型任务共用一条管线（proofread.ts），只差提示词 / 文法 / 解析器：
 *   proofread    槽 1，语病 + 单调；手动或停笔自动
 *   consistency  槽 2（≥ 3 槽位）否则排在槽 1 的队列里；手动，或随纠错一起（consistencyAuto）
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { chooseCompletionSource } from "./completion";
import { mapOffsetThroughEdit, paragraphStartAt, type EditSpan } from "./editorText";
import { buildMaterialsText, findMaterialHits } from "./materials";
import { findLocalHints } from "./monotony";
import {
  CONSISTENCY_GRAMMAR,
  CONSISTENCY_SAMPLING,
  PROOFREAD_GRAMMAR,
  PROOFREAD_SAMPLING,
  PROOF_IDLE_MS,
  PROOF_MIN_NEW_CHARS,
  PROOF_MIN_WINDOW,
  buildConsistencyPrompt,
  buildProofreadPrompt,
  findingsToIssues,
  issueAtOffset,
  mapIssuesThroughEdit,
  maskChapterMarks,
  mergeLlmIssues,
  parseConsistencyFindings,
  parseFindings,
  resolveProofWindow,
  type Issue,
  type IssueKind,
  type ProofWindow,
} from "./proofread";
import type { Materials, PromptTemplate } from "./types";
import type { ProofStatus } from "../components/workbench/ProofreadTab";

const completionSource = chooseCompletionSource();

export type ProofTask = "proofread" | "consistency";

/** 纠错用的槽位：槽 0 留给候选 + 展开。 */
export const PROOFREAD_SLOT = 1;
/** 人设校验：有第 3 个槽位就并行，否则排在纠错后面共用槽 1。 */
export const CONSISTENCY_SLOT = 2;
/** 本地提示：光标前后各看多远。 */
const LOCAL_BACK = 15000;
const LOCAL_AHEAD = 3000;
const LOCAL_DEBOUNCE_MS = 600;

const TASK_KINDS: Record<ProofTask, ReadonlySet<IssueKind>> = {
  proofread: new Set<IssueKind>(["grammar", "monotony"]),
  consistency: new Set<IssueKind>(["consistency"]),
};

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
  /** 纠错跑完后顺带校验同一窗口的人设。 */
  consistencyAuto: boolean;
  materials: Materials;
  /** 人名与别名：本地提示不把它们当重复，同时用来查专名写法。 */
  ignoreNames: readonly string[];
}

export interface Proofreader {
  issues: Issue[];
  activeIssue: Issue | null;
  status: ProofStatus;
  consistencyStatus: ProofStatus;
  available: boolean;
  isDemo: boolean;
  /** 有没有建过角色卡（没有就不必显示校验按钮的可用态）。 */
  hasCharacters: boolean;
  run: (manual: boolean) => void;
  runConsistency: (manual: boolean) => void;
  cancel: () => void;
  dismiss: (issue: Issue) => void;
  clearAll: () => void;
  /** 每次文本变化都要调用（setEditorDocument 里），问题随之平移。 */
  onEdit: (span: EditSpan) => void;
}

export function useProofreader(args: ProofreaderArgs): Proofreader {
  const { content, caret, template, noThinkPrefix, backendReady, slots, auto, local, consistencyAuto, materials, ignoreNames } = args;
  const isDemo = completionSource.isDemo;
  const available = backendReady && (isDemo || slots > PROOFREAD_SLOT);

  const [llmIssues, setLlmIssues] = useState<Issue[]>([]);
  const [localIssues, setLocalIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<ProofStatus>({ state: "idle" });
  const [consistencyStatus, setConsistencyStatus] = useState<ProofStatus>({ state: "idle" });

  const contentRef = useRef(content);
  const caretRef = useRef(caret);
  const templateRef = useRef(template);
  const noThinkRef = useRef(noThinkPrefix);
  const materialsRef = useRef(materials);
  const consistencyAutoRef = useRef(consistencyAuto);
  const slotsRef = useRef(slots);
  useLayoutEffect(() => {
    contentRef.current = content;
    caretRef.current = caret;
    templateRef.current = template;
    noThinkRef.current = noThinkPrefix;
    materialsRef.current = materials;
    consistencyAutoRef.current = consistencyAuto;
    slotsRef.current = slots;
  });

  const dismissedRef = useRef(new Set<string>());
  const windowStartRef = useRef<number | null>(null);
  /** 自上次检查以来新写的字数（只数插入），光标跳来跳去也不受影响。 */
  const writtenRef = useRef(0);
  const controllersRef = useRef(new Map<ProofTask, AbortController>());
  /** 各任务在飞期间发生的编辑：结果回来后按顺序把偏移穿过去。 */
  const pendingSpansRef = useRef(new Map<ProofTask, EditSpan[]>());
  /** 每个槽位一条串行队列：两个任务挤在槽 1 时先来后到。 */
  const slotChainRef = useRef(new Map<number, Promise<void>>());
  /** 纠错完成后链式触发人设校验用（回调里不能直接引用自己）。 */
  const runTaskRef = useRef<(task: ProofTask, manual: boolean, windowOverride?: ProofWindow) => void>(() => undefined);

  const onEdit = useCallback((span: EditSpan) => {
    if (span.changeStart === span.oldEnd && span.delta === 0) return;
    if (span.delta > 0) writtenRef.current += span.delta;
    if (windowStartRef.current !== null) {
      windowStartRef.current = mapOffsetThroughEdit(windowStartRef.current, span);
    }
    for (const spans of pendingSpansRef.current.values()) spans.push(span);
    setLlmIssues((prev) => (prev.length === 0 ? prev : mapIssuesThroughEdit(prev, span)));
    setLocalIssues((prev) => (prev.length === 0 ? prev : mapIssuesThroughEdit(prev, span)));
  }, []);

  const cancel = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
  }, []);

  const runTask = useCallback(
    (task: ProofTask, manual: boolean, windowOverride?: ProofWindow) => {
      if (!available || controllersRef.current.has(task)) return;
      const setTaskStatus = task === "proofread" ? setStatus : setConsistencyStatus;
      const text = contentRef.current;
      const win = windowOverride ?? resolveProofWindow(text, caretRef.current, windowStartRef.current, manual);
      if (win.end - win.start < PROOF_MIN_WINDOW) {
        if (manual) setTaskStatus({ state: "error", message: "光标前面还没有足够的文字可查。" });
        return;
      }
      const windowText = maskChapterMarks(text.slice(win.start, win.end));

      let prompt: string;
      let grammar: string;
      let sampling: { temperature: number; topP: number; nPredict: number };
      let slot: number;
      if (task === "proofread") {
        windowStartRef.current = win.start;
        writtenRef.current = 0;
        prompt = buildProofreadPrompt(templateRef.current, windowText, noThinkRef.current);
        grammar = PROOFREAD_GRAMMAR;
        sampling = PROOFREAD_SAMPLING;
        slot = PROOFREAD_SLOT;
      } else {
        const hits = findMaterialHits(materialsRef.current, text, win.start, win.end).filter((hit) => hit.kind === "character");
        const cardsText = buildMaterialsText({ ...materialsRef.current, lore: [] }, hits);
        if (!cardsText) {
          if (manual) setTaskStatus({ state: "error", message: "这段正文里没有出现任何已建卡的角色。" });
          return;
        }
        prompt = buildConsistencyPrompt(templateRef.current, cardsText, windowText, noThinkRef.current);
        grammar = CONSISTENCY_GRAMMAR;
        sampling = CONSISTENCY_SAMPLING;
        slot = isDemo || slotsRef.current > CONSISTENCY_SLOT ? CONSISTENCY_SLOT : PROOFREAD_SLOT;
      }

      const controller = new AbortController();
      controllersRef.current.set(task, controller);
      pendingSpansRef.current.set(task, []);
      setTaskStatus({ state: "running", chars: windowText.length });
      const started = performance.now();

      const request = (withGrammar: boolean) =>
        completionSource.provider(
          {
            requestId: crypto.randomUUID(),
            prompt,
            idSlot: slot,
            nPredict: sampling.nPredict,
            temperature: sampling.temperature,
            topP: sampling.topP,
            grammar: withGrammar ? grammar : undefined,
          },
          controller.signal,
        );

      const job = async () => {
        if (controller.signal.aborted) return;
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
          const findings = task === "proofread" ? parseFindings(output) : parseConsistencyFindings(output);
          let fresh = findingsToIssues(findings, windowText, win.start);
          let mapped: ProofWindow = win;
          for (const span of pendingSpansRef.current.get(task) ?? []) {
            fresh = mapIssuesThroughEdit(fresh, span);
            mapped = { start: mapOffsetThroughEdit(mapped.start, span), end: mapOffsetThroughEdit(mapped.end, span) };
          }
          const dismissed = dismissedRef.current;
          setLlmIssues((prev) => mergeLlmIssues(prev, fresh, mapped, dismissed, TASK_KINDS[task]));
          setTaskStatus({
            state: "done",
            at: Date.now(),
            chars: windowText.length,
            ms: performance.now() - started,
            found: fresh.filter((issue) => !dismissed.has(issue.key)).length,
          });
          // 随纠错一起校验人设：同一窗口（已穿过在飞期间的编辑）
          if (task === "proofread" && consistencyAutoRef.current) {
            controllersRef.current.delete(task);
            pendingSpansRef.current.delete(task);
            runTaskRef.current("consistency", false, mapped);
          }
        } catch (err) {
          if (controller.signal.aborted) setTaskStatus({ state: "idle" });
          else setTaskStatus({ state: "error", message: errorMessage(err) });
        } finally {
          if (controllersRef.current.get(task) === controller) controllersRef.current.delete(task);
          pendingSpansRef.current.delete(task);
        }
      };

      // 同一槽位上的任务串行；不同槽位并行
      const chain = slotChainRef.current;
      const previous = chain.get(slot) ?? Promise.resolve();
      const next = previous.then(job, job);
      chain.set(slot, next);
    },
    [available, isDemo],
  );

  useLayoutEffect(() => {
    runTaskRef.current = runTask;
  }, [runTask]);

  const run = useCallback((manual: boolean) => runTask("proofread", manual), [runTask]);
  const runConsistency = useCallback((manual: boolean) => runTask("consistency", manual), [runTask]);

  // 卸载时中断在飞请求
  useEffect(
    () => () => {
      for (const controller of controllersRef.current.values()) controller.abort();
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
    consistencyStatus,
    available,
    isDemo,
    hasCharacters: materials.characters.length > 0,
    run,
    runConsistency,
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
