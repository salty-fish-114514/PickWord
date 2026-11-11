import { useEffect, useRef, useState } from "react";

import type { SearchMatchStarts } from "./editorText";

const EMPTY_MATCHES = new Uint32Array(0);
const DEBOUNCE_MS = 80;

interface WorkerResponse {
  requestId: number;
  matches: ArrayBuffer;
  preferredIndex: number;
}

interface SearchResult {
  requestId: number;
  content: string;
  query: string;
  preferredOffset: number | null;
  matches: SearchMatchStarts;
  preferredIndex: number;
}

export interface SearchWorkerResult {
  matches: SearchMatchStarts;
  preferredIndex: number;
  ready: boolean;
}

/** Search scans are debounced and run in a cancellable, chunk-yielding Web Worker. */
export function useSearchWorker(
  content: string,
  query: string,
  enabled: boolean,
  preferredOffset: number | null,
): SearchWorkerResult {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const lastSentContentRef = useRef<string | null>(null);
  const requestContextRef = useRef<Pick<
    SearchResult,
    "requestId" | "content" | "query" | "preferredOffset"
  > | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!enabled || !query) {
      workerRef.current?.postMessage({
        requestId,
        content: null,
        query: "",
        preferredOffset: null,
      });
      setResult({
        requestId,
        content,
        query,
        preferredOffset,
        matches: EMPTY_MATCHES,
        preferredIndex: -1,
      });
      return;
    }

    const timer = window.setTimeout(() => {
      let worker = workerRef.current;
      if (!worker) {
        worker = new Worker(
          new URL("../workers/search.worker.ts", import.meta.url),
          {
            type: "module",
          },
        );
        workerRef.current = worker;
        worker.addEventListener(
          "message",
          (event: MessageEvent<WorkerResponse>) => {
            const response = event.data;
            if (response.requestId !== requestIdRef.current) return;
            const current = requestContextRef.current;
            if (!current || current.requestId !== response.requestId) return;
            setResult({
              ...current,
              matches: new Uint32Array(response.matches),
              preferredIndex: response.preferredIndex,
            });
          },
        );
      }
      requestContextRef.current = {
        requestId,
        content,
        query,
        preferredOffset,
      };
      const contentChanged = lastSentContentRef.current !== content;
      lastSentContentRef.current = content;
      worker.postMessage({
        requestId,
        content: contentChanged ? content : null,
        query,
        preferredOffset,
      });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [content, query, enabled, preferredOffset]);

  const current =
    result !== null &&
    result.content === content &&
    result.query === query &&
    result.preferredOffset === preferredOffset;

  return {
    matches: current ? result.matches : EMPTY_MATCHES,
    preferredIndex: current ? result.preferredIndex : -1,
    ready: !enabled || !query || current,
  };
}
