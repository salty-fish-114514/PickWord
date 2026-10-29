/**
 * 检查更新（renderer 侧唯一入口）。
 *
 * 提示策略：
 *   - 启动后延迟自动检查一次；有新版本才弹。
 *   - 每个版本只提示一次：「忽略此版本」把 tag 写进 localStorage，该版本永不再弹；
 *     出了更新的版本会再弹（tag 不同）。
 *   - 设置「基本」页的「检查更新」是手动入口，任何时候都给明确结果（含「已是最新」）。
 *   - 下载走镜像逐个试；全部失败 = 降级为应用内提示，不跳浏览器。
 * 浏览器演示 / 开发模式 supported=false，直接说明原因。
 */
import { useCallback, useEffect, useState } from "react";
import { platform } from "./platform";
import type { UpdateInfo, UpdateProgress } from "./types";

/** 「忽略此版本」记录；只存 tag 字符串，换版本自动失效。 */
const PROMPTED_KEY = "pickword-update-prompted";

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "installing";

export interface UpdaterState {
  phase: UpdatePhase;
  /** 最近一次检查结果；null = 还没查过。 */
  info: UpdateInfo | null;
  progress: UpdateProgress | null;
  /** 下载失败等信息（降级提示用）；关弹窗时清空。 */
  error: string | null;
  dialogOpen: boolean;
  /** 下载成功后的安装包路径，install 用。 */
  exePath: string | null;
  /** manual=true 时无论有没有新版本都弹窗给结果。 */
  check: (manual: boolean) => void;
  startDownload: () => void;
  install: () => void;
  ignoreVersion: () => void;
  closeDialog: () => void;
}

function readPrompted(): string {
  try {
    return localStorage.getItem(PROMPTED_KEY) ?? "";
  } catch {
    return "";
  }
}

export function useUpdater(): UpdaterState {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [exePath, setExePath] = useState<string | null>(null);

  // 下载进度推送（整个生命周期只订阅一次）。
  useEffect(() => {
    if (!platform.api) return undefined;
    return platform.api.onUpdateProgress((p) => setProgress(p));
  }, []);

  const check = useCallback((manual: boolean) => {
    if (!platform.api) {
      setInfo({ supported: false, currentVersion: "演示模式", available: false, reason: "浏览器演示里没有更新功能" });
      if (manual) setDialogOpen(true);
      return;
    }
    setPhase("checking");
    setError(null);
    void platform.api
      .checkUpdate()
      .then((result) => {
        setInfo(result);
        setPhase("idle");
        if (manual) {
          setDialogOpen(true);
        } else if (result.available && result.latest && readPrompted() !== result.latest) {
          setDialogOpen(true);
        }
      })
      .catch((err: unknown) => {
        setPhase("idle");
        setError(err instanceof Error ? err.message : String(err));
        if (manual) setDialogOpen(true);
      });
  }, []);

  const startDownload = useCallback(() => {
    if (!platform.api || !info?.available || !info.latest) return;
    setPhase("downloading");
    setError(null);
    setProgress(null);
    setExePath(null);
    void platform.api
      .downloadUpdate(info)
      .then((file) => {
        setExePath(file);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        // 降级路径：所有镜像都失败，只在应用内提示，不跳浏览器。
        setPhase("idle");
        setError(`下载失败：${err instanceof Error ? err.message : String(err)}`);
      });
  }, [info]);

  const install = useCallback(() => {
    if (!platform.api || !exePath) return;
    setPhase("installing");
    platform.api.installUpdate(exePath).catch(() => setPhase("ready"));
  }, [exePath]);

  const ignoreVersion = useCallback(() => {
    if (info?.latest) {
      try {
        localStorage.setItem(PROMPTED_KEY, info.latest);
      } catch {
        /* 存不下就算了：下次启动还会提示一次，无伤大雅 */
      }
    }
    setDialogOpen(false);
  }, [info]);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setError(null);
  }, []);

  return { phase, info, progress, error, dialogOpen, exePath, check, startDownload, install, ignoreVersion, closeDialog };
}
