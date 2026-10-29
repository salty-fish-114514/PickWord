/**
 * 本机中文字体：探测 + 列表。
 *
 * 四条原则：
 *   1. 不打包任何字体文件（避免版权问题），只读本机已安装的字体；
 *   2. 零依赖：用 canvas 把样本字画出来、比对像素，判断「这个字体名在这台机器上
 *      是否真的装上了、而且带中文字形」；
 *   3. 名字从哪来不影响结论：候选清单 / 主进程读系统字体表 / queryLocalFonts 都只是
 *      「待验证的名字」，装没装一律由像素说了算——所以用户自己装的字体也认得出来；
 *   4. 只影响编辑器里的正文显示，不写进文稿、不进提示词、不按文稿分别保存。
 *
 * 为什么不用别的办法：
 *   · `document.fonts.check("32px 字体名")` 对不存在的字体也返回 true，没法用；
 *   · 量宽度也不行——中文方块字的字宽就是 1em，任何字体（含兜底）都量出同样宽度，
 *     区分不开「字体提供了字形」和「兜底字体提供了字形」。所以看像素。
 */

import { platform } from "./platform";

/** 当尺子 / 兜底用的字体：一定存在。 */
const RULER = "monospace";
/** 只在中文样本上比对像素，用来判断「有没有中文字形」。 */
const CJK_SAMPLE = "汉雨";
/** 混排样本：同一款字体的别名（宋体 / SimSun）画出来像素完全相同，用来去重。 */
const MIXED_SAMPLE = "汉字雨Wg7";
/**
 * 单次绘画的画布尺寸。必须够宽：样本要完整画进画布，否则超出右边界的那部分
 * （例如混排样本里的拉丁字母）根本不参与像素比对，判断就失真了。
 */
const CANVAS_W = 240;
const CANVAS_H = 48;
/** 单个字体名 / 名单长度上限（异常数据防御）。 */
const MAX_FONT_NAME_LEN = 48;
/** 名字会被拼进 CSS 的 `"名字", 兜底` 里，带引号/分号/大括号的（注册表脏数据）一律不要。 */
const NAME_SAFE = /^[^"\\;{}]+$/;
const MAX_FONTS = 400;

/** 编辑器正文字体的默认值（自带字体，本机缺字时再逐级退）。 */
export const DEFAULT_FONT_STACK = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", SimSun, serif';

/** 常见中文字体候选：中文名在前，同款字体的英文名在后（去重时保留先出现的）。 */
const CANDIDATES = [
  "宋体",
  "SimSun",
  "新宋体",
  "NSimSun",
  "微软雅黑",
  "Microsoft YaHei",
  "黑体",
  "SimHei",
  "楷体",
  "KaiTi",
  "仿宋",
  "FangSong",
  "等线",
  "DengXian",
  "华文宋体",
  "STSong",
  "华文中宋",
  "STZhongsong",
  "华文楷体",
  "STKaiti",
  "华文细黑",
  "STXihei",
  "华文行楷",
  "STXingkai",
  "幼圆",
  "YouYuan",
  "隶书",
  "LiSu",
  "思源宋体",
  "Source Han Serif SC",
  "思源黑体",
  "Source Han Sans SC",
  "Noto Serif CJK SC",
  "Noto Sans CJK SC",
  "Noto Serif SC",
  "Noto Sans SC",
  "霞鹜文楷",
  "LXGW WenKai",
  "阿里巴巴普惠体",
  "Alibaba PuHuiTi",
  "鸿蒙黑体",
  "HarmonyOS Sans SC",
  "MiSans",
  "OPPO Sans",
  "苹方-简",
  "PingFang SC",
  "宋体-简",
  "Songti SC",
  "楷体-简",
  "Kaiti SC",
  "冬青黑体简体中文",
  "Hiragino Sans GB",
  "文泉驿微米黑",
  "WenQuanYi Micro Hei",
  "文泉驿正黑",
  "WenQuanYi Zen Hei",
  "更纱黑体 SC",
  "Sarasa Gothic SC",
  "得意黑",
  "Smiley Sans",
  "朱雀仿宋",
  "Zhuque Fangsong",
  "微软正黑体",
  "Microsoft JhengHei",
  "细明体",
  "MingLiU",
  "新细明体",
  "PMingLiU",
];

/**
 * 名字里像中文 / CJK 的线索。只在「像素与系统兜底完全相同」时用来区分
 * 「它本身就是本机的中文兜底字体」和「它只是一款西文字体」，不用于过滤输入名单——
 * 否则用拉丁字母命名、用户自己装的中文字体就会被挡在外面。
 */
const CJK_NAME_HINT = /[\u3400-\u9fff]|CJK|Han|Hei|Song|Sun|Kai|Ming|WenKai|Fangsong|PingFang|Sarasa|YaHei|JhengHei|Hiragino|Noto (Sans|Serif)/i;

/** 「字体族名 + 兜底」拼成可用的 font-family 值；family 为空时就是默认字体栈。 */
export function fontStackFor(family: string | null | undefined): string {
  const name = typeof family === "string" ? family.trim() : "";
  return name && NAME_SAFE.test(name) ? `"${name}", ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK;
}

/**
 * 把 text 用「字体名 + 兜底」画一遍，返回像素签名（FNV-1a 哈希）。
 * family 为空串时就是纯兜底字体画的，用作基准。
 */
function pixelSignature(ctx: CanvasRenderingContext2D, family: string, text: string): string {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.font = family ? `32px "${family}", ${RULER}` : `32px ${RULER}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000";
  ctx.fillText(text, 2, 36);
  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i += 4) {
    hash ^= data[i + 3]; // 只看 alpha：黑字画在透明底上
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** 探测用的工作上下文：一次探测内复用画布与两个基准签名。 */
interface Probe {
  ctx: CanvasRenderingContext2D;
  /** 名字不存在时、中文样例由系统兜底画出的签名（兜底通常是本机默认的中文字体）。 */
  fallbackCjk: string;
  /** 名字不存在时、混排样例的签名（用来判断「这个名字到底有没有对应的字体」）。 */
  fallbackMixed: string;
  /** 已经收进列表的字体的混排签名（同一款字体的别名签名相同）。 */
  mixedSeen: Set<string>;
}

function createProbe(): Probe | null {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  return {
    ctx,
    fallbackCjk: pixelSignature(ctx, "", CJK_SAMPLE),
    fallbackMixed: pixelSignature(ctx, "", MIXED_SAMPLE),
    mixedSeen: new Set<string>(),
  };
}

/**
 * 名字 → 这台机器上可用吗？可用就返回它的混排签名（用于别名去重）。
 *
 * 两步判断：
 *   1. 存在性：混排样例的像素与「名字不存在时」不同 → 这个名字确实对应一款字体（不存在时完全走兜底）；
 *   2. 中文字形：中文样例的像素与兜底不同 → 它自己带中文字形。
 *      若与兜底相同，则有两种可能：（a）只是一款西文字体（Arial 之类），（b）它本身就是
 *      系统画中文用的兜底字体（名字听起来是中文的，例如「文泉驿正黑」）——这时用名字做判断。
 */
function verifyFont(probe: Probe, family: string): string | null {
  const { ctx } = probe;
  const name = family.trim();
  if (!name || name.length > MAX_FONT_NAME_LEN || !NAME_SAFE.test(name)) return null;
  const mixed = pixelSignature(ctx, name, MIXED_SAMPLE);
  if (mixed === probe.fallbackMixed) return null; // 名字不存在
  if (pixelSignature(ctx, name, CJK_SAMPLE) !== probe.fallbackCjk) return mixed; // 自带中文字形
  return CJK_NAME_HINT.test(name) ? mixed : null;
}

/** 逐个验证并追加；已收过同签名的名字跳过，列表长度到上限为止。 */
function appendVerified(probe: Probe, names: string[], out: string[]): void {
  const seenNames = new Set(out.map((item) => item.toLowerCase()));
  for (const candidate of names) {
    if (out.length >= MAX_FONTS) return;
    const family = candidate.trim();
    if (!family || seenNames.has(family.toLowerCase())) continue;
    const signature = verifyFont(probe, family);
    if (!signature || probe.mixedSeen.has(signature)) continue;
    probe.mixedSeen.add(signature);
    seenNames.add(family.toLowerCase());
    out.push(family);
  }
}

/**
 * 候选清单之外的字体名（用户自己装的也在里面），两个来源：
 *   1. `platform.api.listSystemFonts()` —— Electron：主进程读系统字体表，最完整（见 main/fonts.ts）；
 *   2. `navigator.queryLocalFonts()` —— 浏览器里 Chromium 的 Local Font Access，
 *      需要在用户手势里调用，拿不到权限就当没有。
 * 名字都只是「待验证的线索」，装没装、有没有中文字形由像素决定。
 */
async function listSystemFontCandidates(force: boolean): Promise<string[]> {
  const names: string[] = [];

  const listSystemFonts = platform.api?.listSystemFonts;
  if (listSystemFonts) {
    try {
      const list = await listSystemFonts(force);
      if (Array.isArray(list)) names.push(...list.filter((item): item is string => typeof item === "string"));
    } catch {
      // 主进程读不到（非 Windows / PowerShell 受限）时不影响候选清单那条路
    }
  }

  const access = navigator as Navigator & { queryLocalFonts?: () => Promise<Array<{ family?: unknown }>> };
  if (typeof access.queryLocalFonts === "function") {
    try {
      const fonts = await access.queryLocalFonts();
      for (const font of fonts) {
        const family = typeof font?.family === "string" ? font.family.trim() : "";
        if (family) names.push(family);
      }
    } catch {
      // 没有权限 / 不在用户手势里 / 被权限策略挡下：静默跳过
    }
  }

  return Array.from(new Set(names));
}

let pending: Promise<string[]> | null = null;

/**
 * 列出本机已安装的中文字体（结果在一次会话内缓存；失败返回空列表）。
 * force = true 时丢掉缓存重新探测——装了新字体不用重启应用，见「重新检测」。
 *
 * 必须在用户手势（点击）里调用：queryLocalFonts 要求文档处于「短暂激活」状态。
 */
export function listLocalCjkFonts(force = false): Promise<string[]> {
  if (pending && !force) return pending;
  pending = (async () => {
    const probe = createProbe();
    if (!probe) return [];
    const out: string[] = [];
    // 常见字体在前（作者多半先想看到宋体系），系统里其余的按名字顺序补在后面。
    appendVerified(probe, CANDIDATES, out);
    const extras = await listSystemFontCandidates(force);
    appendVerified(probe, extras, out);
    return out;
  })().catch(() => [] as string[]);
  return pending;
}
