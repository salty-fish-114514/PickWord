/**
 * 探针 3：素材的纯脚本侧——建卡提取、提及计数、别名解析、卡片结构。
 *
 * 这一层从头到尾都是确定性脚本，一个模型都不调；卡片也没有「注入」开关了。
 */
import { countMentions, extractCandidateNames, findMaterialHits, newCharacterCard, newLoreEntry, parseAliases } from "../../src/renderer/src/lib/materials";
import type { Materials } from "../../src/renderer/src/lib/types";

console.log("█ 探针 3 · 素材的纯脚本侧\n");

const body =
  "陆青梧推开木门。老周在柜台后面抬头，喊了一声「青梧丫头」。\n" +
  "她没答话。沈砚之的名字在她舌尖转了一圈，又被咽了回去。\n" +
  "沈砚之，沈砚之。门外的雨声盖住了这两个字。\n" +
  "雾溪镇的雨季能下一个月，铺子里的木头都发了胀。";

const materials: Materials = {
  characters: [
    { ...newCharacterCard("陆青梧"), aliases: parseAliases("青梧;青梧丫头") },
    newCharacterCard("沈砚之"),
    { ...newCharacterCard("老周"), group: "minor" },
  ],
  lore: [newLoreEntry("雾溪镇", "place")],
};

console.log("═══ 1. 建卡候选提取（右键「添加人物」用的就是它） ═══");
// 门槛是「片段出现 ≥3 次」+「左右邻字够杂」，所以选一段里反复出现的生面孔才提得出来。
const selection =
  "陆青梧把半张地图塞进怀里。老周在柜台后面叹了口气。\n" +
  "裴知远站在门口没进来。裴知远看着她，裴知远什么也没说。\n" +
  "地图的一角露在外面，裴知远的目光落在那一角上。";
const known = materials.characters.flatMap((c) => [c.name, ...c.aliases]);
console.log("选中文本：", selection.replace(/\n/g, "⏎"));
console.log("已有名字（会被跳过）：", known.join("、"));
const extracted = extractCandidateNames(selection, known);
if (extracted.length === 0) console.log("  （没有达到 3 次门槛的新名字）");
for (const item of extracted) console.log(`  ${item.text} ×${item.count}`);

console.log("\n═══ 2. 提及计数（别名合并计数，长名优先） ═══");
const mentions = countMentions([...materials.characters, ...materials.lore], body);
for (const card of [...materials.characters, ...materials.lore]) {
  console.log(`  ${card.name}（${card.aliases.join("/") || "无别名"}）：${mentions.get(card.id) ?? 0} 次`);
}

console.log("\n═══ 3. 窗口命中（面板展示用，不进提示词） ═══");
for (const hit of findMaterialHits(materials, body, 0, body.length)) {
  console.log(`  [${hit.kind}] ${hit.name} ×${hit.count}　首次出现偏移 ${hit.first}`);
}

console.log("\n═══ 4. 别名解析（纵向一行一个，也兼容老数据里的顿号/分号） ═══");
console.log("  「青梧;小陆， 阿梧、青梧」→", parseAliases("青梧;小陆， 阿梧、青梧"));

console.log("\n═══ 5. 新建卡片的结构（已无 inject 字段） ═══");
console.log("  人物卡：", JSON.stringify(newCharacterCard("陆青梧")));
console.log("  设定条：", JSON.stringify(newLoreEntry("雾溪镇", "place")));
