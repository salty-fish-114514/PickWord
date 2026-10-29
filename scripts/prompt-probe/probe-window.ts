/**
 * 探针 2：纠错窗口 vs「人物与设定」面板的口径差异。
 *
 * 素材已经完全不进提示词，所以这里量的只是**面板口径**：
 *   纠错送进模型的是 resolveProofWindow 圈出的窗口（章节标记行被等长空格掩掉）；
 *   面板统计命中用的是续写的「本次送入正文」范围（buildPrompt 的 bodyStart/bodyEnd）。
 * 两者不是同一个窗口，所以面板上会出现「这段里根本没露面的角色」——这是展示口径，不是提示词泄漏。
 */
import { buildPrompt } from "../../src/renderer/src/lib/promptBuilder";
import { findMaterialHits } from "../../src/renderer/src/lib/materials";
import { buildProofreadPrompt, maskChapterMarks, resolveProofWindow } from "../../src/renderer/src/lib/proofread";
import { CHATML_TEMPLATE, NO_THINK_PREFIX } from "../../src/shared/modelProfile";
import type { Materials } from "../../src/shared/materials";

console.log("█ 探针 2 · 纠错窗口 vs 面板命中口径\n");

const materials: Materials = {
  characters: [
    { id: "c1", name: "陆青梧", aliases: ["青梧"], group: "main", background: "", personality: "", appearance: "", extra: [] },
    { id: "c2", name: "沈砚之", aliases: [], group: "main", background: "", personality: "", appearance: "", extra: [] },
    { id: "c3", name: "老周", aliases: [], group: "minor", background: "", personality: "", appearance: "", extra: [] },
  ],
  lore: [{ id: "l1", name: "雾溪镇", aliases: [], category: "place", text: "江南小城，雨季能下一个月。" }],
};

const ch1 = "--第1章 旧雨--\n陆青梧回到雾溪镇，在老周的铺子里坐了一下午。雨从早上就没停过。\n\n";
const ch2mark = "--第2章 来客--\n";
const current = "雨已经下了三天。陆青梧把伞靠在门边。\n屋里比她离开时干净，干净得反常。\n沈砚之是在这时候敲的门。\n";
const text = ch1 + ch2mark + current;
const caret = text.length;

const built = buildPrompt({ docText: text, cursorOffset: caret, noThinkPrefix: NO_THINK_PREFIX, template: CHATML_TEMPLATE });
const proof = resolveProofWindow(text, caret, null, false);

console.log("续写「本次送入正文」范围：", built.bodyStart, "→", built.bodyEnd, `（${built.bodyChars} 字）`);
console.log("纠错窗口范围：           ", proof.start, "→", proof.end);

console.log("\n纠错真正送进模型的文本（章节标记行已掩成等长空格）：");
console.log(JSON.stringify(maskChapterMarks(text.slice(proof.start, proof.end))));
console.log("\n完整纠错 prompt：");
console.log(buildProofreadPrompt(CHATML_TEMPLATE, maskChapterMarks(text.slice(proof.start, proof.end)), NO_THINK_PREFIX));
console.log("[prompt 结束]");

console.log("\n面板显示的命中（范围＝本次送入正文，只做展示与本地统计）：");
const shown = findMaterialHits(materials, text, built.bodyStart, built.bodyEnd);
for (const hit of shown) console.log(`  ${hit.name}（${hit.count} 次）`);

const inProof = findMaterialHits(materials, text, proof.start, proof.end);
console.log("\n纠错窗口里的命中（模型实际看到的）：");
for (const hit of inProof) console.log(`  ${hit.name}（${hit.count} 次）`);

const same = shown.length === inProof.length && shown.every((h, i) => h.id === inProof[i].id && h.count === inProof[i].count);
console.log(same ? "\n→ 这段样稿很短，两个窗口覆盖的人名恰好一致。" : "\n→ 两个窗口不一致：面板是「本次送入正文」的范围，纠错是它自己的窗口。");
console.log("→ 关键是口径写清楚了：面板说的是「这段窗口出现了谁」，不是「模型看到了谁」；");
console.log("  章节一长，纠错窗口就会切掉前面的段落，而面板跟着续写窗口走，两者本来就不必相同。");
console.log("→ 无论哪一种，素材都不会进提示词——提示词里连「人物与设定」这个标题都没有。");
