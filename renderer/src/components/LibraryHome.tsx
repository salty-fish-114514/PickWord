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
  /** 本地模型状态与加载进度，首页顶部也要显示（作者一进来就知道还要等多久）。 */
  backendStatus: BackendStatus;
  backendProgress: BackendProgress | null;
  backendIsDemo: boolean;
  /** 后端实际生效的上下文长度（ModelProfile），给设置面板做说明。 */
  backendContextLen?: number | null;
  backendSlots?: number | null;
  onBackendRetry: () => void;
  onBackendLog: () => void;
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onCreate: () => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (ids: string[]) => Promise<void>;
  /** 长篇：新建 / 追加一卷 / 改书名 / 短篇升级 / 单卷降回短篇。 */
  onCreateBook: (title: string) => Promise<void>;
  onCreateVolume: (bookId: string) => Promise<void>;
  onRenameBook: (bookId: string, title: string) => Promise<void>;
  onConvertToBook: (id: string) => Promise<void>;
  onConvertToStandalone: (bookId: string) => Promise<void>;
  onImport: (files: File[]) => Promise<ImportReport>;
  onChooseDirectory: () => Promise<boolean>;
  onResetDirectory: () => Promise<void>;
  onSettingsChange: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  onResetAdvanced: () => void;
  /** 打开「模型与推理」面板（警告条与设置面板都从这里进）；演示模式下不传。 */
  onOpenBackendSettings?: () => void;
  /** 设置「基本」页「关于与更新」块用；onCheckUpdate 不传则该块不显示（演示模式）。 */
  appVersion?: string | null;
  updateBusy?: boolean;
  onCheckUpdate?: () => void;
  /** 设置「基本」页的「重看新手引导」。 */
  onReplayOnboarding?: () => void;
}

/** 首页的一张卡片：独立短篇，或把同一部长篇的各卷归成一张。 */
type LibraryItem =
  | { kind: "doc"; key: string; entry: LibraryEntry }
  | {
      kind: "book";
      key: string;
      id: string;
      title: string;
      /** 按卷序号升序。 */
      volumes: LibraryEntry[];
      /** 最近交互的那一卷（点开卡片默认打开它）。 */
      latest: LibraryEntry;
      characterCount: number;
      interactedAt: number;
    };

/** entries 已按最近交互排序；长篇按首次出现的位置占位，各卷归并。 */
function groupEntries(entries: LibraryEntry[]): LibraryItem[] {
  const items: LibraryItem[] = [];
  const books = new Map<string, Extract<LibraryItem, { kind: "book" }>>();
  for (const entry of entries) {
    if (!entry.book) {
      items.push({ kind: "doc", key: entry.id, entry });
      continue;
    }
    let book = books.get(entry.book.id);
    if (!book) {
      book = {
        kind: "book",
        key: `book:${entry.book.id}`,
        id: entry.book.id,
        title: entry.book.title,
        volumes: [],
        latest: entry,
        characterCount: 0,
        interactedAt: entry.interactedAt,
      };
      books.set(entry.book.id, book);
      items.push(book);
    }
    book.volumes.push(entry);
    book.characterCount += entry.characterCount;
    if (entry.interactedAt > book.latest.interactedAt) book.latest = entry;
    book.interactedAt = Math.max(book.interactedAt, entry.interactedAt);
  }
  for (const book of books.values()) book.volumes.sort((a, b) => (a.book?.volume ?? 0) - (b.book?.volume ?? 0));
  return items;
}

function volumeLabel(entry: LibraryEntry): string {
  const n = (entry.book?.volume ?? 0) + 1;
  return entry.title && entry.title !== `第${n}卷` ? `第${n}卷 · ${entry.title}` : `第${n}卷`;
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
  backendStatus,
  backendProgress,
  backendIsDemo,
  backendContextLen = null,
  backendSlots = null,
  onBackendRetry,
  onBackendLog,
  onRefresh,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onCreateBook,
  onCreateVolume,
  onRenameBook,
  onConvertToBook,
  onConvertToStandalone,
  onImport,
  onChooseDirectory,
  onResetDirectory,
  onSettingsChange,
  onResetAdvanced,
  onOpenBackendSettings,
  appVersion = null,
  updateBusy = false,
  onCheckUpdate,
  onReplayOnboarding,
}: LibraryHomeProps) {
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  /** 通用的「输入一个名字」对话框：改名 / 改书名 / 新建长篇。 */
  const [nameDialog, setNameDialog] = useState<{
    eyebrow: string;
    title: string;
    description: string;
    confirmLabel: string;
    submit: (value: string) => Promise<void>;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const items = useMemo(() => groupEntries(entries), [entries]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    if (!term) return items;
    const matches = (entry: LibraryEntry) => `${entry.title} ${entry.excerpt}`.toLocaleLowerCase("zh-CN").includes(term);
    return items.filter((item) =>
      item.kind === "doc"
        ? matches(item.entry)
        : item.title.toLocaleLowerCase("zh-CN").includes(term) || item.volumes.some(matches),
    );
  }, [items, query]);
  /** 当前结果里所有可选中的文稿 id（长篇展开为各卷）。 */
  const filteredIds = useMemo(
    () => filtered.flatMap((item) => (item.kind === "doc" ? [item.entry.id] : item.volumes.map((v) => v.id))),
    [filtered],
  );

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

  function toggleSelection(ids: string[]) {
    setSelected((previous) => {
      const next = new Set(previous);
      const allIn = ids.every((id) => next.has(id));
      ids.forEach((id) => (allIn ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  function itemIds(item: LibraryItem): string[] {
    return item.kind === "doc" ? [item.entry.id] : item.volumes.map((v) => v.id);
  }

  function exitSelection() {
    setSelected(new Set());
    setSelecting(false);
  }

  function startRename(entry: LibraryEntry) {
    setMenuId(null);
    setRenameValue(entry.title);
    setNameDialog({
      eyebrow: "文稿管理",
      title: entry.book ? "修改卷标题" : "修改名称",
      description: entry.book ? "只改这一卷的标题，文件名跟随书名。" : "文稿内容与上下文不会改变。",
      confirmLabel: "保存名称",
      submit: async (value) => {
        await onRename(entry.id, value);
        setFeedback({ kind: "success", message: "已改名，并移到最近交互的位置。" });
      },
    });
  }

  function startRenameBook(book: Extract<LibraryItem, { kind: "book" }>) {
    setMenuId(null);
    setRenameValue(book.title);
    setNameDialog({
      eyebrow: "长篇管理",
      title: "修改书名",
      description: "整本书的文件夹与各卷文件会一起改名。",
      confirmLabel: "保存书名",
      submit: async (value) => {
        await onRenameBook(book.id, value);
        setFeedback({ kind: "success", message: "书名已修改。" });
      },
    });
  }

  function startCreateBook() {
    setRenameValue("");
    setNameDialog({
      eyebrow: "新建长篇",
      title: "给这部长篇起个名字",
      description: "长篇以文件夹存放，可以分成多卷；风格参考、角色与设定由各卷共用。",
      confirmLabel: "创建并开始写",
      submit: (value) => onCreateBook(value),
    });
  }

  async function confirmNameDialog() {
    const dialog = nameDialog;
    if (!dialog) return;
    const value = renameValue.trim();
    if (!value) {
      setFeedback({ kind: "error", message: "名称不能为空。" });
      return;
    }
    await act(async () => {
      await dialog.submit(value);
      setNameDialog(null);
    });
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
    if (working || nameDialog || deleteIds) return;
    void importFiles(Array.from(event.dataTransfer.files));
  }

  const allVisibleSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));

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

      {/* 模型不可用时显示警告条：引导用户回到配置页完成设置 */}
      {!backendIsDemo && (backendStatus === "stopped" || backendStatus === "error") && onOpenBackendSettings && (
        <div className="library-model-warning" role="alert">
          <div className="library-model-warning-content">
            <Icon name="warning" size={18} />
            <div>
              <strong>本地模型尚未就绪</strong>
              <span>
                {backendStatus === "stopped"
                  ? "模型服务未启动，候选词功能暂不可用。"
                  : "模型启动失败，请检查配置或重新设置。"}
              </span>
            </div>
          </div>
          <button className="library-model-warning-action" type="button" onClick={onOpenBackendSettings}>
            模型与推理
          </button>
        </div>
      )}

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
                <button
                  className="library-text-action"
                  type="button"
                  disabled={working || loading}
                  title="分卷、分章的长篇：一个文件夹，多卷 txt"
                  onClick={startCreateBook}
                >
                  新建长篇
                </button>
                <button className="library-primary-action" type="button" disabled={working || loading} onClick={() => void act(onCreate)}>
                  <Icon name="plus" size={18} />
                  新建文稿
                </button>
              </div>
            </div>

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
                    if (allVisibleSelected) filteredIds.forEach((id) => next.delete(id));
                    else filteredIds.forEach((id) => next.add(id));
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
                {filtered.map((item) => {
                  const ids = itemIds(item);
                  const isSelected = ids.every((id) => selected.has(id));
                  const entry = item.kind === "doc" ? item.entry : item.latest;
                  const title = item.kind === "doc" ? item.entry.title : item.title;
                  const count = item.kind === "doc" ? item.entry.characterCount : item.characterCount;
                  const menuOpen = menuId === item.key;
                  return (
                    <article className="manuscript-item" role="listitem" key={item.key}>
                      <div className={`manuscript-cover-frame ${isSelected ? "is-selected" : ""} ${item.kind === "book" ? "is-book" : ""}`}>
                        <button
                          className="manuscript-cover"
                          type="button"
                          aria-label={selecting ? `选择${title}` : `打开${title}`}
                          aria-pressed={selecting ? isSelected : undefined}
                          onClick={() => selecting ? toggleSelection(ids) : void act(() => onOpen(entry.id))}
                        >
                          {item.kind === "book" ? (
                            <span className="manuscript-type is-book">
                              <Icon name="book" size={12} />
                              长篇 · {item.volumes.length} 卷
                            </span>
                          ) : (
                            <span className={`manuscript-type is-${entry.sourceFormat}`}>
                              {entry.sourceFormat.toUpperCase()}
                            </span>
                          )}
                          <span className="manuscript-excerpt">{entry.excerpt || "在这里开始写作。"}</span>
                          <span className="manuscript-watermark">{count.toLocaleString("zh-CN")} 字</span>
                        </button>

                        {selecting ? (
                          <span className={`manuscript-check ${isSelected ? "is-checked" : ""}`} aria-hidden="true">
                            {isSelected ? "✓" : ""}
                          </span>
                        ) : (
                          <div className="manuscript-menu-area">
                            <button
                              className="manuscript-menu-trigger"
                              type="button"
                              aria-label={`${title}的管理菜单`}
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              onClick={() => setMenuId((previous) => previous === item.key ? null : item.key)}
                            >
                              <Icon name="more" size={16} />
                            </button>
                            {menuOpen && item.kind === "doc" && (
                              <div className="manuscript-menu" role="menu">
                                <button type="button" role="menuitem" onClick={() => startRename(item.entry)}>
                                  <Icon name="edit" size={15} />改名
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  title="原稿成为第一卷，之后可以继续加卷"
                                  onClick={() => { setMenuId(null); void act(() => onConvertToBook(item.entry.id), "已升级为长篇，原稿成为第一卷。"); }}
                                >
                                  <Icon name="book" size={15} />升级为长篇
                                </button>
                                <button
                                  className="is-danger"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setMenuId(null); setDeleteIds([item.entry.id]); }}
                                >
                                  <Icon name="trash" size={15} />删除
                                </button>
                              </div>
                            )}
                            {menuOpen && item.kind === "book" && (
                              <div className="manuscript-menu" role="menu">
                                <div className="manuscript-menu-caption">各卷</div>
                                {item.volumes.map((volume) => (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    key={volume.id}
                                    className="manuscript-menu-volume"
                                    onClick={() => { setMenuId(null); void act(() => onOpen(volume.id)); }}
                                  >
                                    <span>{volumeLabel(volume)}</span>
                                    <span className="manuscript-menu-meta">{volume.characterCount.toLocaleString("zh-CN")} 字</span>
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setMenuId(null); void act(() => onCreateVolume(item.id), "已新建一卷。"); }}
                                >
                                  <Icon name="plus" size={15} />新建一卷
                                </button>
                                <button type="button" role="menuitem" onClick={() => startRenameBook(item)}>
                                  <Icon name="edit" size={15} />改书名
                                </button>
                                {item.volumes.length === 1 && (
                                  <button type="button" role="menuitem" onClick={() => startRename(item.volumes[0])}>
                                    <Icon name="edit" size={15} />改卷标题
                                  </button>
                                )}
                                {item.volumes.length === 1 && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuId(null); void act(() => onConvertToStandalone(item.id), "已降为短篇。"); }}
                                  >
                                    <Icon name="export" size={15} />降为短篇
                                  </button>
                                )}
                                <button
                                  className="is-danger"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setMenuId(null); setDeleteIds(ids); }}
                                >
                                  <Icon name="trash" size={15} />删除整本
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="manuscript-label">
                        <span className="manuscript-title" title={title}>{title}</span>
                        <span className="manuscript-date">{shortDate(item.kind === "doc" ? item.entry.interactedAt : item.interactedAt)}</span>
                      </div>
                    </article>
                  );
                })}
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
            onOpenBackendSettings={onOpenBackendSettings}
            detectedContextLen={backendContextLen}
            detectedSlots={backendSlots}
            appVersion={appVersion}
            updateBusy={updateBusy}
            onCheckUpdate={onCheckUpdate}
            onReplayOnboarding={onReplayOnboarding}
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

      {nameDialog && (
        <div className="library-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setNameDialog(null);
        }}>
          <section className="library-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title">
            <span className="library-dialog-eyebrow">{nameDialog.eyebrow}</span>
            <h2 id="rename-title">{nameDialog.title}</h2>
            <p>{nameDialog.description}</p>
            <input
              autoFocus
              className="library-dialog-input"
              aria-label="名称"
              value={renameValue}
              maxLength={80}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") void confirmNameDialog();
                if (event.key === "Escape") setNameDialog(null);
              }}
            />
            {feedback?.kind === "error" && <p className="library-dialog-error" role="alert">{feedback.message}</p>}
            <div className="library-dialog-actions">
              <button type="button" onClick={() => setNameDialog(null)}>取消</button>
              <button className="is-primary" type="button" disabled={working || !renameValue.trim()} onClick={() => void confirmNameDialog()}>
                {nameDialog.confirmLabel}
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