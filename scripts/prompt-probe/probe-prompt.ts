/**
 * 探针 1：三条模型链路的实际提示词骨架（续写两种模式 / 纠错 / 展开的公共前缀）。
 *
 * 只调渲染层纯函数，不需要 Electron 与 React。跑法见同目录 README.md。
 */
import { buildPrompt } from "../../src/renderer/src/lib/promptBuilder";
import { buildProofreadPrompt, maskChapterMarks } from "../../src/renderer/src/lib/proofread";
import {
  CHATML_TEMPLATE,
  DEFAULT_MODEL_PROFILE,
  NO_THINK_PREFIX,
  detectNoThinkPrefix,
  detectPromptTemplate,
} from "../../src/shared/modelProfile";

console.log("█ 探针 1 · 三条链路的提示词骨架\n");

/**
 * 用 llama-server /props 会返回的那两个字段推断画像，和主进程走的是同一条路：
 * chat_template 里出现 </tool_response> → ChatML，出现 <think> → 预填空思考块。
 * DEFAULT_MODEL_PROFILE 只是「后端未就绪 / 浏览器演示」的兜底，它的 noThinkPrefix 是空串。
 */
const chatTemplate = "{%- if enable_thinking %}<think>{%- endif %}<|fim_prefix|>{{ role }}\n{{ content }}<|fim_suffix|>\n";
const modelName = "qwen3.5-4b";
const noThinkPrefix = detectNoThinkPrefix(chatTemplate, modelName);
const template = detectPromptTemplate(chatTemplate, modelName);
/** 只可能来自角色卡的文本：出现在提示词里就说明素材还在被注入。 */
const CARD_ONLY_TEXT = "性格：寡言，认死理";

const earlier = "陆青梧回到雾溪，在老周的铺子里坐了一下午。雨从早上就没停过。\n\n";
const chapterMark = "--第2章 来客--\n";
const current = "雨已经下了三天。陆青梧把伞靠在门边，指节上还留着锁芯的铁锈味。\n屋里比她离开时干净，干净得反常。\n";
const docText = earlier + chapterMark + current;
const caret = docText.length;

const outlineText = "陆青梧发现祖屋门锁被换过；沈砚之冒雨登门，要买她手里的半张地图。";
const styleText = "他写字很慢，一笔一画都像在刻。窗外的雨声把屋子泡得发白。";

console.log("推断出的模板：", template === CHATML_TEMPLATE ? "ChatML" : template.systemOpen);
console.log("noThinkPrefix =", JSON.stringify(noThinkPrefix), "／等于官方常量：", noThinkPrefix === NO_THINK_PREFIX);
console.log("兜底画像（后端未就绪时）noThinkPrefix =", JSON.stringify(DEFAULT_MODEL_PROFILE.noThinkPrefix));

console.log("\n═══ 1. 续写 · 快速模式（无大纲无风格） ═══");
const plain = buildPrompt({ docText, cursorOffset: caret, noThinkPrefix, template });
console.log(plain.prompt);
console.log("[prompt 结束]");

console.log("\n═══ 2. 续写 · 普通模式（大纲 + 风格） ═══");
// 大纲注入时 App 会带上锚点（当前大纲段的段首）：正文严格取 [锚点, 光标)
const anchorOffset = earlier.length + chapterMark.length;
const full = buildPrompt({ docText, cursorOffset: caret, outlineText, styleText, anchorOffset, noThinkPrefix, template });
console.log(full.prompt);
console.log("[prompt 结束]");

console.log("\n═══ 3. 纠错（正文在 user 回合，assistant 只有空思考块） ═══");
const window = maskChapterMarks(docText.slice(0, caret));
console.log(buildProofreadPrompt(template, window, noThinkPrefix));
console.log("[prompt 结束]");

console.log("\n═══ 4. 检查项 ═══");
const checks: Array<[string, boolean]> = [
  ["快速模式 assistant 以空思考块开头", plain.prompt.includes(CHATML_TEMPLATE.assistantOpen + noThinkPrefix + "正文：\n")],
  ["普通模式 assistant = 空思考块 + 大纲 + 正文", full.prompt.includes(noThinkPrefix + `大纲：\n${outlineText}\n\n正文：\n`)],
  ["章节标题不出现在任何提示词里", !plain.prompt.includes("第2章") && !full.prompt.includes("第2章") && !plain.prompt.includes(chapterMark.trim())],
  ["提示词里没有「人物与设定」素材块", !full.prompt.includes("人物与设定") && !full.prompt.includes(CARD_ONLY_TEXT)],
  ["纠错窗口里章节标记行被等长空格掩掉", !buildProofreadPrompt(template, window, noThinkPrefix).includes("--第2章")],
  ["三条链路共用同一个空思考块字面量", buildProofreadPrompt(template, window, noThinkPrefix).endsWith(noThinkPrefix)],
  ["大纲模式下正文严格取自锚点", full.anchored && full.bodyStart === anchorOffset],
];
for (const [label, ok] of checks) console.log(`  ${ok ? "✔" : "✘"} ${label}`);

console.log("\n═══ 5. 字数口径 ═══");
console.log(`  模式：${full.mode}　body 偏移：${full.bodyStart} → ${full.bodyEnd}　硬上限：${full.hardLimit} 字`);
console.log(`  原始偏移差（旧口径，含章节标记与空白）：${full.bodyEnd - full.bodyStart}`);
console.log(`  bodyChars（真实送入字数，countChars）：${full.bodyChars}`);
console.log("  notices：", full.notices.length ? full.notices : "（无）");
