/**
 * 短句展开的编排：浮窗里的候选行依次（1 → N）从词长成短句，流式显示。
 *
 *   - 每行一次 /completion：候选提示词 + 该候选词，槽 0，前缀全部命中缓存，只解码（~24 token）。
 *   - 串行：llama-server 各槽 KV 不共享，没有 n>1；五次就是五次纯解码。
 *   - 任何会改变文本 / 光标 / 候选的事件都要 clear()；结果按候选的全局序号存，翻页不串行。
 *   - start() 是「补齐」而不是「重来」：已完成的行（其它页的也一样）保留并跳过，只解码缺的；
 *     翻回上一页短句还在，停笔自动展开 / 长按只补当前页没展开的行。
 *   - 流式中接受 = 取已显示的部分（已定），由调用方读 rows[index].text。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { EXPAND_SAMPLING, EXPAND_STOPS, chooseExpandStream, finalizeExpansion } from "./expansion";

const expandSource = chooseExpandStream();

export interface ExpansionRow {
  /** 已经流出来的续写（不含候选词本身）。 */
  text: string;
  done: boolean;
  error?: string;
}

export interface ExpandItem {
  /** 候选在整个列表里的序号（翻页后仍然唯一）。 */
  index: number;
  text: string;
}

export interface Expander {
  rows: Record<number, ExpansionRow>;
  running: boolean;
  isDemo: boolean;
  /** 补齐这些行：已完成的跳过，正在流的上一轮先停掉（半截行丢弃，若仍在 items 里会重做）。 */
  start: (prompt: string, items: ExpandItem[]) => void;
  /** 这些行里有没有还没展开完的（决定要不要再计时）。 */
  hasPending: (items: ExpandItem[]) => boolean;
  /** 停止解码，保留已出的文字。 */
  cancel: () => void;
  /** 停止并清空。 */
  clear: () => void;
}

export function useExpander(): Expander {
  const [rows, setRowsState] = useState<Record<number, ExpansionRow>>({});
  const [running, setRunning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  /** rows 的同步镜像：start() 要立刻知道哪些行已完成。 */
  const rowsRef = useRef<Record<number, ExpansionRow>>({});
  const setRows = useCallback((update: (prev: Record<number, ExpansionRow>) => Record<number, ExpansionRow>) => {
    rowsRef.current = update(rowsRef.current);
    setRowsState(rowsRef.current);
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const clear = useCallback(() => {
    cancel();
    generationRef.current += 1;
    // 每次按键都会经过这里：没东西可清时不触发重渲染
    setRows((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    setRunning((prev) => (prev ? false : prev));
  }, [cancel, setRows]);

  const hasPending = useCallback(
    (items: ExpandItem[]) =>
      items.some((item) => item.text.trim().length > 0 && !item.text.includes("<|") && !rowsRef.current[item.index]?.done),
    [],
  );

  const start = useCallback(
    (prompt: string, items: ExpandItem[]) => {
      cancel();
      const generation = ++generationRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      // 上一轮没流完的半截行丢掉（在 items 里的会重做），已完成的全部保留
      setRows((prev) => {
        const next: Record<number, ExpansionRow> = {};
        for (const [key, row] of Object.entries(prev)) if (row.done) next[Number(key)] = row;
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
      const todo = items.filter((item) => item.text.trim().length > 0 && !item.text.includes("<|") && !rowsRef.current[item.index]?.done);
      if (todo.length === 0) {
        setRunning(false);
        return;
      }
      setRunning(true);

      void (async () => {
        for (const item of todo) {
          if (controller.signal.aborted) break;
          setRows((prev) => ({ ...prev, [item.index]: { text: "", done: false } }));
          try {
            const result = await expandSource.stream(
              {
                requestId: crypto.randomUUID(),
                prompt: prompt + item.text,
                idSlot: 0,
                nPredict: EXPAND_SAMPLING.nPredict,
                temperature: EXPAND_SAMPLING.temperature,
                topP: EXPAND_SAMPLING.topP,
                repeatPenalty: EXPAND_SAMPLING.repeatPenalty,
                stop: EXPAND_STOPS,
              },
              controller.signal,
              (chunk) => {
                if (generationRef.current !== generation) return;
                setRows((prev) => {
                  const row = prev[item.index];
                  return { ...prev, [item.index]: { text: (row?.text ?? "") + chunk, done: false } };
                });
              },
            );
            if (generationRef.current !== generation) return;
            const text = finalizeExpansion(result);
            setRows((prev) => ({ ...prev, [item.index]: { text, done: true } }));
          } catch (err) {
            if (controller.signal.aborted || generationRef.current !== generation) break;
            const message = err instanceof Error ? err.message : String(err);
            setRows((prev) => ({ ...prev, [item.index]: { text: prev[item.index]?.text ?? "", done: true, error: message } }));
            break; // 一行失败多半是后端问题，后面的行也别再撞了
          }
        }
        if (generationRef.current === generation) {
          // 被取消时把半截行定格（去掉闪烁光标），文字保留
          setRows((prev) => {
            let changed = false;
            const next: Record<number, ExpansionRow> = {};
            for (const [key, row] of Object.entries(prev)) {
              if (row.done) next[Number(key)] = row;
              else {
                changed = true;
                next[Number(key)] = { ...row, done: true };
              }
            }
            return changed ? next : prev;
          });
          setRunning(false);
          if (controllerRef.current === controller) controllerRef.current = null;
        }
      })();
    },
    [cancel, setRows],
  );

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { rows, running, isDemo: expandSource.isDemo, start, hasPending, cancel, clear };
}
