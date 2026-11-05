/**
 * 多篇文稿的数据适配层。UI 只调用 LibraryProvider，不直接拼文件路径。
 *
 * Electron 下由主进程按稳定 id 操作（src/main/library.ts）；
 * 浏览器演示模式下整个文库退回 localStorage。
 */

import { EMPTY_MATERIALS, type Materials } from "../../../shared/materials";
import { countChars, makeExcerpt } from "../../../shared/text";
import { platform } from "./platform";
import type { BookRef, DocumentPayload, LibraryDirectory, LibraryEntry, LibraryFormat } from "./types";

export interface LibraryProvider {
  readonly isDemo: boolean;
  list(): Promise<LibraryEntry[]>;
  read(id: string): Promise<DocumentPayload>;
  create(document: DocumentPayload, format: LibraryFormat): Promise<LibraryEntry>;
  save(id: string, document: DocumentPayload): Promise<LibraryEntry>;
  rename(id: string, title: string): Promise<LibraryEntry>;
  remove(ids: string[]): Promise<void>;
  touch(id: string): Promise<LibraryEntry>;
  /** 长篇：新建（返回第一卷）/ 追加一卷 / 改书名 / 短篇升级 / 单卷降回短篇。 */
  createBook(title: string): Promise<LibraryEntry>;
  createVolume(bookId: string): Promise<LibraryEntry>;
  renameBook(bookId: string, title: string): Promise<void>;
  convertToBook(id: string): Promise<LibraryEntry>;
  convertToStandalone(bookId: string): Promise<LibraryEntry>;
  getDirectory(): Promise<LibraryDirectory>;
  chooseDirectory(): Promise<LibraryDirectory | null>;
  resetDirectory(): Promise<LibraryDirectory>;
}

/** 空文稿（新建 / 导入时的起点）。 */
export function emptyDocument(title: string, content = ""): DocumentPayload {
  return {
    title,
    content,
    styleText: "",
    outlineText: "",
    styleEnabled: false,
    outlineEnabled: true,
    outlineSegments: [],
    anchor: null,
    chapterOutlines: {},
    materials: EMPTY_MATERIALS,
  };
}

interface MockRecord {
  entry: LibraryEntry;
  document: DocumentPayload;
}

/** 演示文库里的一部长篇：风格与素材由各卷共用（与主进程 book.json 的职责一致）。 */
interface MockBook {
  id: string;
  title: string;
  styleText: string;
  styleEnabled: boolean;
  materials: Materials;
}

interface MockStore {
  records: MockRecord[];
  books?: MockBook[];
  directory: LibraryDirectory;
}

const LIBRARY_KEY = "zixia-library-v1";
const LEGACY_DOCUMENT_KEYS = ["zixia-writing-document-v3", "zixia-writing-document-v2", "zixia-writing-document-v1"];
const DEMO_DIRECTORY: LibraryDirectory = { path: "浏览器本地存储（演示模式）", isDefault: true };
let memoryStore: MockStore | null = null;

/** 文库摘要不带整篇正文，避免首页为每张封面渲染大字符串。 */
function toEntry(
  id: string,
  document: DocumentPayload,
  sourceFormat: LibraryFormat,
  time: number,
  book?: BookRef,
): LibraryEntry {
  const entry: LibraryEntry = {
    id,
    title: document.title.trim() || "未命名文稿",
    excerpt: makeExcerpt(document.content),
    sourceFormat,
    characterCount: countChars(document.content),
    updatedAt: time,
    interactedAt: time,
  };
  if (book) entry.book = { ...book };
  return entry;
}

/** 旧版单篇演示稿只作为一篇导入新文库，原 localStorage 数据不会删除。 */
function legacyDocument(): DocumentPayload | null {
  for (const key of LEGACY_DOCUMENT_KEYS) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.content !== "string") continue;
      const anchor = record.anchor;
      const safeAnchor =
        typeof anchor === "object" && anchor !== null &&
        typeof (anchor as Record<string, unknown>).offset === "number" &&
        typeof (anchor as Record<string, unknown>).fingerprint === "string"
          ? (anchor as { offset: number; fingerprint: string })
          : null;
      return {
        ...emptyDocument(typeof record.title === "string" ? record.title : "上次文稿", record.content),
        styleText: typeof record.styleText === "string" ? record.styleText : "",
        outlineText: typeof record.outlineText === "string" ? record.outlineText : "",
        styleEnabled: record.styleEnabled === true,
        outlineEnabled: record.outlineEnabled === true,
        anchor: safeAnchor,
      };
    } catch {
      // 当前旧键格式损坏时继续检查其余版本，不覆盖旧数据。
    }
  }
  return null;
}

const EXAMPLE_TEXTS: Array<{ title: string; content: string; format: LibraryFormat }> = [
  {
    title: "河水慢下来时",
    format: "txt",
    content: "风从南边吹来，河面上浮着一层薄薄的光。\n\n我原以为，离开一座城市需要一个很盛大的理由。后来才发现，很多时候只是某个普通的清晨。\n\n船还没有靠岸，远处的钟声先一步抵达。",
  },
  {
    title: "雾里的来信",
    format: "txt",
    content: "那封信是在雨停之后到的。信封边缘沾了水，字迹却还清楚。\n\n她坐在窗前，迟迟没有拆开，仿佛只要不开口，某些告别就永远不会发生。",
  },
  {
    title: "旧街口的灯",
    format: "md",
    content: "街角的灯亮得太早，像有人替黄昏记错了时间。\n\n他从巷子里走出来，手里提着一袋热栗子。风穿过衣袖，带走了这个秋天最后一点暖意。",
  },
  {
    title: "春天没有尽头",
    format: "txt",
    content: "山路走到一半，花忽然开了。\n\n不是漫山遍野的那种开法，只是石缝里一朵很小的白花，让人忍不住停下脚步。",
  },
  {
    title: "深夜电台",
    format: "docx",
    content: "凌晨两点，收音机里传来一阵轻微的杂音。\n\n主持人说，今晚的最后一首歌，送给所有还在路上的人。她放下笔，看了一眼没有回音的手机。",
  },
  {
    title: "慢行的邮车",
    format: "txt",
    content: "邮车经过小镇时，天还没有亮。\n\n每到这个时辰，面包房总会先开门，玻璃窗里升起柔软的白雾。父亲说，总会有人等一封信。",
  },
];

function seedStore(): MockStore {
  const legacy = legacyDocument();
  const samples = legacy
    ? [{ title: legacy.title, content: legacy.content, format: "txt" as LibraryFormat }]
    : EXAMPLE_TEXTS;
  const now = Date.now();
  return {
    directory: DEMO_DIRECTORY,
    records: samples.map((sample, index) => {
      const document = index === 0 && legacy ? legacy : emptyDocument(sample.title, sample.content);
      const id = crypto.randomUUID();
      const time = now - index * 86_400_000;
      return { document, entry: toEntry(id, document, sample.format, time) };
    }),
  };
}

function loadStore(): MockStore {
  if (memoryStore) return memoryStore;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LIBRARY_KEY);
  } catch {
    memoryStore = seedStore();
    return memoryStore;
  }

  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error("文库格式错误");
      const candidate = parsed as Partial<MockStore>;
      if (!Array.isArray(candidate.records) || typeof candidate.directory?.path !== "string") {
        throw new Error("文库格式错误");
      }
      memoryStore = candidate as MockStore;
      return memoryStore;
    } catch {
      throw new Error("演示文库数据无法读取；原始浏览器存储未被覆盖。请备份后检查本地存储。");
    }
  }

  const seeded = seedStore();
  try {
    window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(seeded));
  } catch {
    // 禁用本地存储时本次会话仍能演示；刷新后内容可能丢失，首页会明确标注演示模式。
  }
  memoryStore = seeded;
  return seeded;
}

/** 先成功写入再发布到内存；空间不足时抛错，UI 不会误报「已保存」。 */
function publish(store: MockStore): void {
  try {
    window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(store));
  } catch {
    throw new Error("浏览器本地存储空间不足或不可用，请先导出 TXT 备份文稿。");
  }
  memoryStore = store;
}

function nextInteraction(records: MockRecord[]): number {
  return records.reduce(
    (newest, record) => Math.max(newest, record.entry.interactedAt + 1),
    Date.now(),
  );
}

function findRecord(id: string): MockRecord {
  const record = loadStore().records.find((item) => item.entry.id === id);
  if (!record) throw new Error("这篇文稿已经不存在，请返回首页刷新文库。");
  return record;
}

function findBook(bookId: string | undefined): MockBook | null {
  if (!bookId) return null;
  return (loadStore().books ?? []).find((book) => book.id === bookId) ?? null;
}

function uniqueBookTitle(requested: string, store: MockStore, excludeId?: string): string {
  const title = requested.trim() || "未命名长篇";
  const used = new Set((store.books ?? []).filter((b) => b.id !== excludeId).map((b) => b.title.toLocaleLowerCase()));
  if (!used.has(title.toLocaleLowerCase())) return title;
  let index = 2;
  while (used.has(`${title} (${index})`.toLocaleLowerCase())) index += 1;
  return `${title} (${index})`;
}

function uniqueTitle(requested: string, records: MockRecord[], excludeId?: string): string {
  const title = requested.trim() || "未命名文稿";
  const used = new Set(
    records.filter((item) => item.entry.id !== excludeId && !item.entry.book).map((item) => item.entry.title.toLocaleLowerCase()),
  );
  if (!used.has(title.toLocaleLowerCase())) return title;
  let index = 2;
  while (used.has(`${title} (${index})`.toLocaleLowerCase())) index += 1;
  return `${title} (${index})`;
}

/** 浏览器完整演示版：每个文稿都是独立记录，保存永远按 id，不触碰 Electron 的旧 currentPath。 */
const mockLibraryProvider: LibraryProvider = {
  isDemo: true,
  async list() {
    return loadStore().records.map((item) => ({ ...item.entry }));
  },
  async read(id) {
    const record = findRecord(id);
    const book = findBook(record.entry.book?.id);
    const document = record.document;
    return {
      ...document,
      anchor: document.anchor ? { ...document.anchor } : null,
      chapterOutlines: { ...(document.chapterOutlines ?? {}) },
      outlineSegments: document.outlineSegments?.map((segment) => ({ ...segment, anchor: { ...segment.anchor } })),
      ...(book
        ? { styleText: book.styleText, styleEnabled: book.styleEnabled, materials: book.materials }
        : { materials: document.materials ?? EMPTY_MATERIALS }),
    };
  },
  async create(input, format) {
    const store = loadStore();
    const document = { ...input, title: uniqueTitle(input.title, store.records) };
    const entry = toEntry(crypto.randomUUID(), document, format, nextInteraction(store.records));
    publish({ ...store, records: [...store.records, { entry, document }] });
    return { ...entry };
  },
  async save(id, input) {
    const store = loadStore();
    const current = findRecord(id);
    const bookRef = current.entry.book;
    const title = bookRef ? input.title.trim() || current.entry.title : uniqueTitle(input.title, store.records, id);
    // 卷：风格与素材写回书，旁车里不重复保存
    const document = bookRef
      ? { ...input, title, styleText: "", styleEnabled: false, materials: EMPTY_MATERIALS }
      : { ...input, title };
    const entry = toEntry(id, document, current.entry.sourceFormat, nextInteraction(store.records), bookRef);
    const books = bookRef
      ? (store.books ?? []).map((book) =>
          book.id === bookRef.id
            ? { ...book, styleText: input.styleText, styleEnabled: input.styleEnabled, materials: input.materials ?? EMPTY_MATERIALS }
            : book,
        )
      : store.books;
    publish({ ...store, books, records: store.records.map((item) => item.entry.id === id ? { entry, document } : item) });
    return { ...entry };
  },
  async rename(id, title) {
    if (!title.trim()) throw new Error("文稿标题不能为空。");
    const store = loadStore();
    const current = findRecord(id);
    const bookRef = current.entry.book;
    const document = { ...current.document, title: bookRef ? title.trim() : uniqueTitle(title, store.records, id) };
    const entry = toEntry(id, document, current.entry.sourceFormat, nextInteraction(store.records), bookRef);
    publish({ ...store, records: store.records.map((item) => item.entry.id === id ? { entry, document } : item) });
    return { ...entry };
  },
  async remove(ids) {
    const store = loadStore();
    if (ids.some((id) => !store.records.some((item) => item.entry.id === id))) {
      throw new Error("部分文稿已不存在，请刷新文库后重试。");
    }
    const deleting = new Set(ids);
    const records = store.records.filter((item) => !deleting.has(item.entry.id));
    // 一卷不剩的长篇连同书一起删除
    const books = (store.books ?? []).filter((book) => records.some((item) => item.entry.book?.id === book.id));
    publish({ ...store, books, records });
  },
  async createBook(title) {
    const store = loadStore();
    const book: MockBook = {
      id: crypto.randomUUID(),
      title: uniqueBookTitle(title, store),
      styleText: "",
      styleEnabled: false,
      materials: EMPTY_MATERIALS,
    };
    const document = emptyDocument("第1卷");
    const entry = toEntry(crypto.randomUUID(), document, "txt", nextInteraction(store.records), {
      id: book.id,
      title: book.title,
      volume: 0,
    });
    publish({ ...store, books: [...(store.books ?? []), book], records: [...store.records, { entry, document }] });
    return { ...entry };
  },
  async createVolume(bookId) {
    const store = loadStore();
    const book = findBook(bookId);
    if (!book) throw new Error("这部长篇已经不存在，请返回首页刷新文库。");
    const volumes = store.records.filter((item) => item.entry.book?.id === bookId).map((item) => item.entry.book?.volume ?? 0);
    const volume = volumes.length === 0 ? 0 : Math.max(...volumes) + 1;
    const document = emptyDocument(`第${volume + 1}卷`);
    const entry = toEntry(crypto.randomUUID(), document, "txt", nextInteraction(store.records), {
      id: book.id,
      title: book.title,
      volume,
    });
    publish({ ...store, records: [...store.records, { entry, document }] });
    return { ...entry };
  },
  async renameBook(bookId, title) {
    if (!title.trim()) throw new Error("书名不能为空。");
    const store = loadStore();
    if (!findBook(bookId)) throw new Error("这部长篇已经不存在，请返回首页刷新文库。");
    const nextTitle = uniqueBookTitle(title, store, bookId);
    publish({
      ...store,
      books: (store.books ?? []).map((book) => book.id === bookId ? { ...book, title: nextTitle } : book),
      records: store.records.map((item) =>
        item.entry.book?.id === bookId
          ? { ...item, entry: { ...item.entry, book: { ...item.entry.book, title: nextTitle } } }
          : item,
      ),
    });
  },
  async convertToBook(id) {
    const store = loadStore();
    const current = findRecord(id);
    if (current.entry.book) throw new Error("这篇文稿已经是长篇的一卷。");
    const book: MockBook = {
      id: crypto.randomUUID(),
      title: uniqueBookTitle(current.entry.title, store),
      styleText: current.document.styleText,
      styleEnabled: current.document.styleEnabled,
      materials: current.document.materials ?? EMPTY_MATERIALS,
    };
    const document = { ...current.document, title: "第1卷", styleText: "", styleEnabled: false, materials: EMPTY_MATERIALS };
    const entry = toEntry(id, document, current.entry.sourceFormat, nextInteraction(store.records), {
      id: book.id,
      title: book.title,
      volume: 0,
    });
    publish({
      ...store,
      books: [...(store.books ?? []), book],
      records: store.records.map((item) => item.entry.id === id ? { entry, document } : item),
    });
    return { ...entry };
  },
  async convertToStandalone(bookId) {
    const store = loadStore();
    const book = findBook(bookId);
    if (!book) throw new Error("这部长篇已经不存在，请返回首页刷新文库。");
    const volumes = store.records.filter((item) => item.entry.book?.id === bookId);
    if (volumes.length !== 1) throw new Error("只有单卷的长篇才能降回短篇。");
    const only = volumes[0];
    const document = {
      ...only.document,
      title: uniqueTitle(book.title, store.records, only.entry.id),
      styleText: book.styleText,
      styleEnabled: book.styleEnabled,
      materials: book.materials,
    };
    const entry = toEntry(only.entry.id, document, only.entry.sourceFormat, nextInteraction(store.records));
    publish({
      ...store,
      books: (store.books ?? []).filter((item) => item.id !== bookId),
      records: store.records.map((item) => item.entry.id === only.entry.id ? { entry, document } : item),
    });
    return { ...entry };
  },
  async touch(id) {
    const store = loadStore();
    const current = findRecord(id);
    const entry = { ...current.entry, interactedAt: nextInteraction(store.records) };
    publish({ ...store, records: store.records.map((item) => item.entry.id === id ? { ...item, entry } : item) });
    return { ...entry };
  },
  async getDirectory() {
    return { ...loadStore().directory };
  },
  async chooseDirectory() {
    const picker = window as Window & { showDirectoryPicker?: () => Promise<{ name: string }> };
    let name: string;
    if (picker.showDirectoryPicker) {
      try {
        name = (await picker.showDirectoryPicker()).name;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
      }
    } else {
      const answer = window.prompt("演示模式：输入文件夹名称。实际文稿仍保存在浏览器 localStorage。", "我的文稿");
      if (answer === null) return null;
      name = answer;
    }
    if (!name.trim()) throw new Error("请输入一个有效的文件夹名称。");
    const store = loadStore();
    const directory = { path: `演示目录 / ${name.trim()}（正文仍在浏览器存储）`, isDefault: false };
    publish({ ...store, directory });
    return directory;
  },
  async resetDirectory() {
    const store = loadStore();
    publish({ ...store, directory: DEMO_DIRECTORY });
    return { ...DEMO_DIRECTORY };
  },
};

/** Electron 下走主进程文库；浏览器演示走 localStorage。 */
export function chooseLibraryProvider(): LibraryProvider {
  const api = platform.api;
  if (!api) return mockLibraryProvider;
  return {
    isDemo: false,
    list: api.listLibraryDocuments,
    read: api.readLibraryDocument,
    create: api.createLibraryDocument,
    save: api.saveLibraryDocument,
    rename: api.renameLibraryDocument,
    remove: api.deleteLibraryDocuments,
    touch: api.touchLibraryDocument,
    createBook: api.createLibraryBook,
    createVolume: api.createLibraryVolume,
    renameBook: api.renameLibraryBook,
    convertToBook: api.convertLibraryToBook,
    convertToStandalone: api.convertLibraryToStandalone,
    getDirectory: api.getLibraryDirectory,
    chooseDirectory: api.chooseLibraryDirectory,
    resetDirectory: api.resetLibraryDirectory,
  };
}

export function sortLibrary(entries: LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort((a, b) =>
    b.interactedAt - a.interactedAt || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, "zh-CN"),
  );
}