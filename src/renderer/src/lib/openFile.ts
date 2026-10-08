/**
 * 打开文件：把 .txt / .md / .docx 的原始字节变成纯文本。
 *
 * 设计要点：
 *   ● 全部在 renderer 里解析，**零第三方依赖**。浏览器演示和 Electron 共用同一份代码：
 *       浏览器：<input type="file"> 读到 ArrayBuffer；
 *       Electron：主进程弹对话框、读文件，把字节通过 window.api.openDocument 交给这里。
 *   ● Word 兼容是「只读」的：只提取段落文字，不碰格式、图片、表格样式；
 *     保存永远只写 txt，不会也不可能修改原 .docx。
 *   ● 旧版 .doc（二进制格式）不支持：它不是 zip，解析成本极高，让用户另存为 .docx / .txt。
 *   ● 中文 txt 在 Windows 上经常是 GBK / GB18030 编码，所以文本解码要先试 UTF-8，失败再试 GB18030。
 *
 * .docx 是什么：一个 zip 压缩包，正文在 word/document.xml 里，
 * 每个 <w:p> 是一个段落，段落里的 <w:t> 是文字，<w:tab/> 是制表符，<w:br/> 是软换行。
 */

export type OpenedFormat = "txt" | "docx";

export interface ParsedFile {
  /** 建议用作文稿标题（去掉扩展名的文件名）。 */
  title: string;
  /** 纯文本，统一为 LF 换行。 */
  text: string;
  format: OpenedFormat;
  /** 文本编码（docx 恒为 UTF-8）。 */
  encoding: string;
}

/** 超过这个大小的文件直接拒绝，避免一次性吃光内存。 */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "text"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function stripExtension(name: string): string {
  const base = name.replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim() || "未命名";
}

/** 统一换行、去掉 BOM。锚点偏移都是按 LF 文本算的，所以必须在入口处统一。 */
function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/* ════════════════════════════════════════════════════════════════
   一、文本解码（UTF-8 → GB18030 兜底）
   ════════════════════════════════════════════════════════════════ */

export function decodeTextBytes(bytes: Uint8Array): { text: string; encoding: string } {
  // 带 BOM 的情况直接按 BOM 判定
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: normalizeText(new TextDecoder("utf-8").decode(bytes)), encoding: "UTF-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: normalizeText(new TextDecoder("utf-16le").decode(bytes)), encoding: "UTF-16 LE" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: normalizeText(new TextDecoder("utf-16be").decode(bytes)), encoding: "UTF-16 BE" };
  }

  // fatal: true → 遇到非法 UTF-8 序列就抛异常，而不是悄悄换成「�」
  try {
    return { text: normalizeText(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), encoding: "UTF-8" };
  } catch {
    // 不是合法 UTF-8，多半是 GBK 系列
  }

  try {
    return { text: normalizeText(new TextDecoder("gb18030").decode(bytes)), encoding: "GB18030" };
  } catch {
    // 运行环境不支持 gb18030（Electron / Chromium 都支持，这里只是兜底）
    return { text: normalizeText(new TextDecoder("utf-8").decode(bytes)), encoding: "UTF-8（含无法识别的字符）" };
  }
}

/* ════════════════════════════════════════════════════════════════
   二、.docx：手写最小 zip 读取 + 提取段落文字
   ════════════════════════════════════════════════════════════════ */

interface ZipEntry {
  method: number;
  compressedSize: number;
  dataOffset: number;
}

/**
 * 在 zip 的「中央目录」里按文件名查找条目。
 * zip 文件结构：[本地文件头+数据]… [中央目录]… [目录结尾记录 EOCD]。
 * 从文件末尾往前找 EOCD（签名 0x06054b50），再由它定位中央目录。
 */
function findZipEntry(bytes: Uint8Array, wanted: string): ZipEntry | null {
  if (bytes.length < 22) throw new Error("文件已损坏，或不是有效的 .docx。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 65535); // EOCD 后面的注释最长 65535 字节
  for (let index = bytes.length - 22; index >= lowest; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new Error("文件已损坏，或不是有效的 .docx。");

  const entryCount = view.getUint16(eocd + 10, true);
  let position = view.getUint32(eocd + 16, true);
  const nameDecoder = new TextDecoder("utf-8");

  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > bytes.length || view.getUint32(position, true) !== 0x02014b50) break;

    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    const name = nameDecoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));

    if (name === wanted) {
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error("该 .docx 使用了 zip64 扩展，暂不支持，请另存为 .txt 后打开。");
      }
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("文件已损坏，或不是有效的 .docx。");
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      return { method, compressedSize, dataOffset: localOffset + 30 + localNameLength + localExtraLength };
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** 用浏览器内置的 DecompressionStream 解 deflate（zip 里的压缩算法）。 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前环境不支持解压 .docx，请另存为 .txt 后打开。");
  }
  // 拷贝一份：确保交给 Blob 的是独立的 ArrayBuffer（避免 SharedArrayBuffer 类型问题）
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** 取出一个 <w:p> 段落里的文字。文本框（txbxContent）与 mc:Fallback 里的内容跳过，避免重复。 */
function paragraphText(paragraph: Element): string {
  let out = "";
  const visit = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.localName === "Fallback" || child.localName === "txbxContent") continue;
      if (child.namespaceURI === W_NS) {
        switch (child.localName) {
          case "t":
            out += child.textContent ?? "";
            continue;
          case "tab":
            out += "\t";
            continue;
          case "br":
          case "cr":
            out += "\n";
            continue;
          case "noBreakHyphen":
            out += "-";
            continue;
          default:
            break;
        }
      }
      visit(child);
    }
  };
  visit(paragraph);
  return out;
}

/** 遍历文档主体，按出现顺序收集所有段落（表格单元格里的段落也会被收集）。 */
function collectParagraphs(root: Element, lines: string[]): void {
  for (const child of Array.from(root.children)) {
    if (child.localName === "Fallback" || child.localName === "txbxContent") continue;
    if (child.namespaceURI === W_NS && child.localName === "p") {
      lines.push(paragraphText(child));
    } else {
      collectParagraphs(child, lines);
    }
  }
}

export async function readDocxText(bytes: Uint8Array): Promise<string> {
  const entry = findZipEntry(bytes, "word/document.xml");
  if (!entry) throw new Error("没有在文件中找到正文（word/document.xml），它可能不是有效的 .docx。");

  const raw = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let xmlBytes: Uint8Array;
  if (entry.method === 0) xmlBytes = raw; // 0 = 仅存储，未压缩
  else if (entry.method === 8) xmlBytes = await inflateRaw(raw); // 8 = deflate
  else throw new Error("该 .docx 使用了不支持的压缩方式，请另存为 .txt 后打开。");

  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("正文解析失败，文件可能已损坏。");
  }

  const lines: string[] = [];
  collectParagraphs(document.documentElement, lines);
  return normalizeText(lines.join("\n")).replace(/\s+$/, "");
}

/* ════════════════════════════════════════════════════════════════
   三、统一入口
   ════════════════════════════════════════════════════════════════ */

/**
 * 根据文件名（扩展名）选择解析方式。失败时抛出带中文说明的 Error，调用方直接展示 message 即可。
 */
export async function parseOpenedFile(name: string, bytes: Uint8Array): Promise<ParsedFile> {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error("文件超过 30 MB，已拒绝打开。");
  }

  const extension = extensionOf(name);
  const title = stripExtension(name);

  if (extension === "doc") {
    throw new Error("暂不支持旧版 .doc 格式。请在 Word 中另存为 .docx 或 .txt 后再打开。");
  }
  if (extension === "docx") {
    return { title, text: await readDocxText(bytes), format: "docx", encoding: "UTF-8" };
  }
  if (TEXT_EXTENSIONS.has(extension) || extension === "") {
    const { text, encoding } = decodeTextBytes(bytes);
    return { title, text, format: "txt", encoding };
  }
  throw new Error(`暂不支持 .${extension} 文件。目前可以打开 .txt、.md 和 .docx。`);
}
