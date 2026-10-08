import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";

import { BackendStatusBar } from "./BackendStatusBar";
import { BrandLogo } from "./BrandLogo";
import { Icon } from "./Icon";
import { SettingsPanel } from "./SettingsPanel";
import type { SettingsValues } from "../lib/settings";
import type { BackendProgress, BackendStatus, LibraryDirectory, LibraryEntry } from "../lib/types";

export interface ImportReport {
  imported: number;
  errors: string[];
}

interface LibraryHomeProps {
  entries: LibraryEntry[];
  directory: LibraryDirectory;
  settings: SettingsValues;
  loading: boolean;
  error: string | null;
  isDemo: boolean;
  hasLegacyApi: boolean;
  /** 本地模型状态与加载进度，首页顶部也要显示（作者一进来就知道还要等多久）。 */
  backendStatus: BackendStatus;
  backendProgress: BackendProgress | null;
  backendIsDemo: boolean;
  onBackendRetry: () => void;
  onBackendLog: () => void;
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onCreate: () => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (ids: string[]) => Promise<void>;
  onImport: (files: File[]) => Promise<ImportReport>;
  onChooseDirectory: () => Promise<boolean>;
  onResetDirectory: () => Promise<void>;
  onSettingsChange: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  onResetAdvanced: () => void;
}

/** 显示最后一次交互的时间。排序使用完整时间戳，文字只是给作者阅读。 */
function shortDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "今天";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

/**
 * 文库首页：每张文稿像一张小型纸页，排列次序由 App 按 interactedAt 降序提供。
 * 卡片代表真正可点击的交互容器，封面仅展示文稿内容，不额外叠促销标签或统计条。
 */
export function LibraryHome({
  entries,
  directory,
  settings,
  loading,
  error,
  isDemo,
  hasLegacyApi,
  backendStatus,
  backendProgress,
  backendIsDemo,
  onBackendRetry,
  onBackendLog,
  onRefresh,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onImport,
  onChooseDirectory,
  onResetDirectory,
  onSettingsChange,
  onResetAdvanced,
}: LibraryHomeProps) {
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    if (!term) return entries;
    return entries.filter((entry) =>
      `${entry.title} ${entry.excerpt}`.toLocaleLowerCase("zh-CN").includes(term),
    );
  }, [entries, query]);

  /** 首页快捷键只在首页挂载；进入编辑器后，编辑器会自行处理 Ctrl+F 和 Ctrl+S。 */
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        inputRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** 点击菜单外侧收起菜单；不需要用模态层阻断整页操作。 */
  useEffect(() => {
    if (!menuId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".manuscript-menu-area")) {
        setMenuId(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuId]);

  /** 异步操作统一显示进度与失败信息，避免静默吞掉磁盘/IPC 错误。 */
  async function act(operation: () => Promise<void>, success?: string) {
    if (working) return;
    setWorking(true);
    setFeedback(null);
    try {
      await operation();
      if (success) setFeedback({ kind: "success", message: success });
    } catch (caught) {
      setFeedback({ kind: "error", message: caught instanceof Error ? caught.message : "操作失败，请重试。" });
    } finally {
      setWorking(false);
    }
  }

  function toggleSelection(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelection() {
    setSelected(new Set());
    setSelecting(false);
  }

  function startRename(entry: LibraryEntry) {
    setMenuId(null);
    setRenameValue(entry.title);
    setRenaming(entry);
  }

  async function confirmRename() {
    const entry = renaming;
    if (!entry) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) {
      setFeedback({ kind: "error", message: "文稿名称不能为空。" });
      return;
    }
    await act(async () => {
      await onRename(entry.id, nextTitle);
      setRenaming(null);
    }, "文稿已改名，并移到最近交互的位置。");
  }

  async function confirmDelete() {
    const ids = deleteIds;
    if (!ids?.length) return;
    await act(async () => {
      await onDelete(ids);
      setDeleteIds(null);
      exitSelection();
    }, `已删除 ${ids.length} 篇文稿。`);
  }

  /** 拖拽与文件选择器共用同一条导入路径；每个文件单独解析，坏文件不会挡住其他文件。 */
  async function importFiles(files: File[]) {
    if (!files.length) return;
    await act(async () => {
      const result = await onImport(files);
      if (result.errors.length) {
        setFeedback({
          kind: "error",
          message: `成功导入 ${result.imported} 篇；${result.errors.join("；")}`,
        });
      } else {
        setFeedback({ kind: "success", message: `已导入 ${result.imported} 篇文稿。原始文件不会被修改。` });
      }
    });
  }

  function handleFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // 再次选择同名文件也需要触发 onChange
    void importFiles(files);
  }

  function isFileDrag(event: DragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    // 某些系统在 dragleave 时清空 dataTransfer.types；此时仍要让覆盖层正常收起。
    if (!dragging) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event) && event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    if (working || renaming || deleteIds) return;
    void importFiles(Array.from(event.dataTransfer.files));
  }

  const allVisibleSelected = filtered.length > 0 && filtered.every((entry) => selected.has(entry.id));

  return (
    <div
      className="library-home"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="library-topbar">
        <div className="library-brand" aria-label="PickWord 本地写作">
          <span className="library-brand-symbol">
            <BrandLogo size={40} />
          </span>
          <span className="library-brand-name">PickWord</span>
          <span className="library-brand-separator" />
          <span className="library-brand-caption">本地写作</span>
        </div>

        <label className="library-search" aria-label="搜索文稿">
          <Icon name="search" size={17} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文稿标题或正文"
            aria-label="搜索文稿标题或正文"
          />
          <span className="library-search-shortcut">Ctrl F</span>
        </label>

        <div className="library-top-actions">
          <button className="library-top-action import-action" type="button" onClick={() => inputRef.current?.click()}>
            <Icon name="upload" size={17} />
            <span>导入文稿</span>
          </button>
          <button
            className={`library-top-action ${settingsOpen ? "is-current" : ""}`}
            type="button"
            title="设置：保存位置、候选、主题、键位"
            aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <Icon name="settings" size={19} />
            <span>设置</span>
          </button>
        </div>
      </header>

      {/* 模型状态与加载进度：放在顶栏下方一整行，加载时作者能看到摘要和剩余时间 */}
      <div className="library-backend-row">
        <BackendStatusBar
          status={backendStatus}
          progress={backendProgress}
          isDemo={backendIsDemo}
          onRetry={onBackendRetry}
          onOpenLog={onBackendLog}
        />
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".txt,.md,.markdown,.docx,text/plain"
        multiple
        hidden
        onChange={handleFilesPicked}
      />

      <div className="library-workspace">
        <main className="library-content">
          <div className="library-content-inner">
            <div className="library-heading-row">
              <div>
                <span className="library-eyebrow">你的写作空间</span>
                <h1>我的文稿</h1>
                <p>每一个片段，都从此刻继续。</p>
              </div>
              <div className="library-heading-actions">
                <button
                  className={`library-text-action ${selecting ? "is-current" : ""}`}
                  type="button"
                  disabled={loading || working || entries.length === 0}
                  onClick={() => selecting ? exitSelection() : setSelecting(true)}
                >
                  {selecting ? "退出管理" : "批量管理"}
                </button>
                <button className="library-primary-action" type="button" disabled={working || loading} onClick={() => void act(onCreate)}>
                  <Icon name="plus" size={18} />
                  新建文稿
                </button>
              </div>
            </div>

            {isDemo && hasLegacyApi && (
              <div className="library-notice" role="status">
                当前主进程尚未提供多篇文稿的按 ID 接口。这里是浏览器本地演示文库，不会修改原有单篇文稿或主进程的保存目标。接入步骤见 INTEGRATION.md。
              </div>
            )}

            {error && (
              <div className="library-message is-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => void act(onRefresh)}>重试</button>
              </div>
            )}
            {feedback && (
              <div className={`library-message is-${feedback.kind}`} role="status">
                <span>{feedback.message}</span>
                <button type="button" aria-label="关闭提示" onClick={() => setFeedback(null)}>
                  <Icon name="close" size={15} />
                </button>
              </div>
            )}

            <div className="library-divider" />

            {selecting && (
              <div className="library-selection-bar">
                <span>已选 {selected.size} 篇</span>
                <button
                  type="button"
                  onClick={() => setSelected((previous) => {
                    const next = new Set(previous);
                    if (allVisibleSelected) filtered.forEach((entry) => next.delete(entry.id));
                    else filtered.forEach((entry) => next.add(entry.id));
                    return next;
                  })}
                >
                  {allVisibleSelected ? "取消当前结果" : "全选当前结果"}
                </button>
                <button
                  className="selection-delete"
                  type="button"
                  disabled={selected.size === 0 || working}
                  onClick={() => setDeleteIds([...selected])}
                >
                  <Icon name="trash" size={15} />
                  删除所选
                </button>
              </div>
            )}

            <div className="library-section-caption">
              <span>{query ? `搜索结果 · ${filtered.length} 篇` : "最近写作"}</span>
              <span>按最近交互排列</span>
            </div>

            {loading ? (
              <div className="library-empty">正在整理你的文稿…</div>
            ) : filtered.length === 0 ? (
              <div className="library-empty">
                <p>{query ? "没有找到相符的文稿" : "这里还没有文稿"}</p>
                <span>{query ? "试试更短的关键词。" : "写下第一段，或将 TXT、Markdown、Word 文档拖到这里。"}</span>
                {!query && <button type="button" onClick={() => void act(onCreate)}>新建一篇</button>}
              </div>
            ) : (
              <div className="library-grid" role="list" aria-label="文稿列表">
                {filtered.map((entry) => (
                  <article className="manuscript-item" role="listitem" key={entry.id}>
                    <div className={`manuscript-cover-frame ${selected.has(entry.id) ? "is-selected" : ""}`}>
                      <button
                        className="manuscript-cover"
                        type="button"
                        aria-label={selecting ? `选择${entry.title}` : `打开${entry.title}`}
                        aria-pressed={selecting ? selected.has(entry.id) : undefined}
                        onClick={() => selecting ? toggleSelection(entry.id) : void act(() => onOpen(entry.id))}
                      >
                        <span className={`manuscript-type is-${entry.sourceFormat}`}>
                          {entry.sourceFormat.toUpperCase()}
                        </span>
                        <span className="manuscript-excerpt">{entry.excerpt || "在这里开始写作。"}</span>
                        <span className="manuscript-watermark">PickWord · 本地写作</span>
                      </button>

                      {selecting ? (
                        <span className={`manuscript-check ${selected.has(entry.id) ? "is-checked" : ""}`} aria-hidden="true">
                          {selected.has(entry.id) ? "✓" : ""}
                        </span>
                      ) : (
                        <div className="manuscript-menu-area">
                          <button
                            className="manuscript-menu-trigger"
                            type="button"
                            aria-label={`${entry.title}的管理菜单`}
                            aria-haspopup="menu"
                            aria-expanded={menuId === entry.id}
                            onClick={() => setMenuId((previous) => previous === entry.id ? null : entry.id)}
                          >
                            <Icon name="more" size={16} />
                          </button>
                          {menuId === entry.id && (
                            <div className="manuscript-menu" role="menu">
                              <button type="button" role="menuitem" onClick={() => startRename(entry)}>
                                <Icon name="edit" size={15} />改名
                              </button>
                              <button
                                className="is-danger"
                                type="button"
                                role="menuitem"
                                onClick={() => { setMenuId(null); setDeleteIds([entry.id]); }}
                              >
                                <Icon name="trash" size={15} />删除
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="manuscript-label">
                      <span className="manuscript-title" title={entry.title}>{entry.title}</span>
                      <span className="manuscript-date">{shortDate(entry.interactedAt)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </main>

        {settingsOpen && (
          <SettingsPanel
            values={settings}
            directory={directory}
            isDemoLibrary={isDemo}
            directoryBusy={working}
            onChooseDirectory={() => void act(async () => {
              const changed = await onChooseDirectory();
              if (changed) setFeedback({ kind: "success", message: "保存位置已更新，文库中的文章仍可正常打开。" });
            })}
            onResetDirectory={() => void act(onResetDirectory, "已恢复默认保存位置。")}
            onChange={onSettingsChange}
            onResetAdvanced={onResetAdvanced}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      <footer className="library-footer">
        <span className="library-footer-directory" title={directory.path}>
          <Icon name="folder" size={15} />
          {directory.path}
        </span>
        <span>{isDemo ? "演示文库 · 浏览器本地存储" : "本地文稿 · 不上传云端"}</span>
      </footer>

      {dragging && (
        <div className="library-drop-overlay" aria-hidden="true">
          <Icon name="upload" size={31} />
          <strong>松开即可导入</strong>
          <span>支持 TXT、Markdown 和 Word 文档</span>
        </div>
      )}

      {renaming && (
        <div className="library-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRenaming(null);
        }}>
          <section className="library-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title">
            <span className="library-dialog-eyebrow">文稿管理</span>
            <h2 id="rename-title">修改名称</h2>
            <p>文稿内容与上下文不会改变。</p>
            <input
              autoFocus
              className="library-dialog-input"
              aria-label="新的文稿名称"
              value={renameValue}
              maxLength={80}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") void confirmRename();
                if (event.key === "Escape") setRenaming(null);
              }}
            />
            {feedback?.kind === "error" && <p className="library-dialog-error" role="alert">{feedback.message}</p>}
            <div className="library-dialog-actions">
              <button type="button" onClick={() => setRenaming(null)}>取消</button>
              <button className="is-primary" type="button" disabled={working || !renameValue.trim()} onClick={() => void confirmRename()}>
                保存名称
              </button>
            </div>
          </section>
        </div>
      )}

      {deleteIds && (
        <div className="library-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDeleteIds(null);
        }}>
          <section className="library-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description">
            <span className="library-dialog-eyebrow">确认操作</span>
            <h2 id="delete-title">删除 {deleteIds.length} 篇文稿？</h2>
            <p id="delete-description">文稿和对应的写作上下文会一并移除。请确认不再需要它们。</p>
            {feedback?.kind === "error" && <p className="library-dialog-error" role="alert">{feedback.message}</p>}
            <div className="library-dialog-actions">
              <button type="button" onClick={() => setDeleteIds(null)}>取消</button>
              <button className="is-danger" type="button" disabled={working} onClick={() => void confirmDelete()}>
                确认删除
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}