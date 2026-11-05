/**
 * 版本号驱动的保存：每次改动 +1；保存成功时记下版本，二者相等 = 已落盘。
 *
 * 同时来的自动保存、手动保存与返回首页会共享一个在飞 Promise；期间又改了正文，
 * 则等它结束后继续保存最新版本，直到落盘版本与编辑器版本一致。
 */
import { useRef, useState } from "react";

import type { SaveStatus } from "./types";

export interface VersionedSave {
  saveStatus: SaveStatus;
  /** 正文 / 上下文有改动时调用。 */
  markDirty: () => void;
  /** 把最新版本落盘；返回是否成功（没有改动时直接 true）。 */
  save: () => Promise<boolean>;
  /** 供只注册一次的监听器（关窗落盘、自动保存计时器）调用最新版本的 save。 */
  saveRef: React.RefObject<() => Promise<boolean>>;
  isDirty: () => boolean;
}

/**
 * @param persist 真正的写入动作；抛错 = 失败。第二个参数 isLatest() 告诉它
 *                「写入期间有没有新的改动」，用于决定要不要把主进程回传的标题同步进编辑器。
 */
export function useVersionedSave(persist: (isLatest: () => boolean) => Promise<void>): VersionedSave {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const versionRef = useRef(0);
  const savedRef = useRef(0);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  function markDirty() {
    versionRef.current += 1;
    // 上次保存失败也照样置为 dirty：下一次自动保存会重试，失败会再次显示「保存失败」。
    setSaveStatus("dirty");
  }

  async function save(): Promise<boolean> {
    if (inFlightRef.current) {
      const previousSucceeded = await inFlightRef.current;
      if (!previousSucceeded) return false;
      if (savedRef.current === versionRef.current) return true;
    }
    const version = versionRef.current;
    if (version === savedRef.current) return true;

    setSaveStatus("saving");
    const operation = (async () => {
      try {
        await persistRef.current(() => version === versionRef.current);
        savedRef.current = version;
        setSaveStatus(version === versionRef.current ? "saved" : "dirty");
        return true;
      } catch {
        setSaveStatus("error");
        return false;
      }
    })();
    inFlightRef.current = operation;
    const succeeded = await operation;
    if (inFlightRef.current === operation) inFlightRef.current = null;
    if (!succeeded) return false;
    return savedRef.current === versionRef.current ? true : save();
  }

  const saveRef = useRef(save);
  saveRef.current = save;

  return {
    saveStatus,
    markDirty,
    save,
    saveRef,
    isDirty: () => versionRef.current !== savedRef.current,
  };
}
