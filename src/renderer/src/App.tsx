/**
 * App.tsx - 文库入口
 * 
 * 应用启动后先进入文库，只有选择了某篇文稿才挂载编辑器。
 * 每篇文稿独立按 id 读取/保存；editor 的 key 也使用 id，切换时自动隔离撤销栈、
 * 候选请求、光标和输入法状态，避免另一篇文稿继承旧编辑器的临时状态。
 */

import { useEffect, useState } from "react";

import { Icon } from "./components/Icon";
import { LibraryHome, type ImportReport } from "./components/LibraryHome";
import { chooseCandidateSource } from "./lib/candidateProvider";
import { useBackendStatus } from "./lib/useBackendStatus";
import { chooseLibraryProvider, sortLibrary } from "./lib/library";
import { MAX_FILE_BYTES, parseOpenedFile } from "./lib/openFile";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type SettingsValues,
} from "./lib/settings";
import type {
  DocumentPayload,
  LibraryDirectory,
  LibraryEntry,
  LibraryFormat,
} from "./lib/types";
import { WritingEditor } from "./WritingEditor";

/* ════════════════════════════════════════════════════════════════
   常量与初始数据
   ════════════════════════════════════════════════════════════════ */

const SETTINGS_KEY = "zixia-writing-settings-v3";

/** 启动时决定数据源：有 window.api 走真实 IPC，否则走演示 mock。 */
const candidateSource = chooseCandidateSource();
/** 多篇文稿有单独的按 ID 数据源；不能用旧版全局 currentPath 保存新文库。 */
const libraryProvider = chooseLibraryProvider();

/* ════════════════════════════════════════════════════════════════
   主组件
   ════════════════════════════════════════════════════════════════ */

interface ActiveManuscript {
  entry: LibraryEntry;
  document: DocumentPayload;
}

/**
 * 应用入口：启动先进入文库，只有选择了某篇文稿才挂载编辑器。
 * 每篇文稿独立按 id 读取/保存；editor 的 key 也使用 id，切换时自动隔离撤销栈、
 * 候选请求、光标和输入法状态，避免另一篇文稿继承旧编辑器的临时状态。
 */
interface AppProps {
  /** 用户跳过了初始配置，模型可能不可用 */
  skippedSetup?: boolean;
  /** 从设置面板触发「重新配置模型」 */
  onReconfigure?: () => void;
}

export default function App({ skippedSetup: _skippedSetup, onReconfigure }: AppProps) {
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
        onReconfigure={onReconfigure}
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
