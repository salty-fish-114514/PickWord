/**
 * 探针 4：纠错的本地层（不花算力、边写边算）。
 *
 * 本地层与人设无关，删掉人设校验之后照常工作：重复片段、段落开头单调、专名写法不一致。
 */
import { findLocalHints, findNameVariants, LOCAL_GRAM, LOCAL_SPAN } from "../../src/renderer/src/lib/monotony";

console.log("█ 探针 4 · 纠错本地层\n");

function show(title: string, issues: Array<{ quote: string; message: string; ranges: Array<{ start: number; end: number }> }>) {
  console.log(`\n── ${title} ──`);
  if (issues.length === 0) {
    console.log("  （无提示）");
    return;
  }
  for (const issue of issues) {
    console.log(`  「${issue.quote}」 ${issue.message}`);
    console.log(`    位置：${issue.ranges.map((r) => `${r.start}-${r.end}`).join("、")}`);
  }
}

console.log(`参数：LOCAL_GRAM=${LOCAL_GRAM} 字起报，LOCAL_SPAN=${LOCAL_SPAN} 字内算「相近位置」`);

// A：专名写法不一致（同长度、只差一个字、且比正名少见得多）
const a = "莱奥拉走进 hall。莱奥拉没有回头。莱奥拉把灯放下。莱奥菈的名字被人叫错了。";
show("A 组 · 专名变体（莱奥拉 / 莱奥菈）", findNameVariants(a, 0, a.length, ["莱奥拉"]));

// A2：门槛偏严的情形——变体出现次数不算「少见得多」就不报
const a2 = "莱奥拉走进 hall。莱奥菈没有回头。莱奥拉把灯放下。莱奥菈的名字被人叫错了。";
show("A2 组 · 变体与正名各半（预期：不报）", findNameVariants(a2, 0, a2.length, ["莱奥拉"]));

// A3：两字名不查（变体太多，误报率不可接受）
const a3 = "老周抬起头。老舟没有说话。老周又低下头。";
show("A3 组 · 两字名（老周 / 老舟，预期：不报）", findNameVariants(a3, 0, a3.length, ["老周"]));

// B：短距离内重复的片段
const b = "他把门推开一条缝。门缝里透出光。他又把门推开一条缝，光更亮了一些。";
show("B 组 · 重复片段", findLocalHints(b, 0, b.length));

// B2：人名不参与重复判定 —— 忽略名单只跳过「整段片段里含这个名字」的那些，
//     少一个字的子片段（「青梧把伞」）仍会被报出来，这是本地层已知的宽松处。
const b2 = "陆青梧把伞收起来。陆青梧把伞放在门边。陆青梧把伞忘了。";
show("B2 组 · 重复片段但把「陆青梧」列入忽略名单", findLocalHints(b2, 0, b2.length, { ignoreNames: ["陆青梧"] }));

// C：连续 ≥ 3 段用同样两个字开头
const c = "他把伞放下。\n他把门推开。\n他把灯熄了。\n窗外雨还在下。\n";
show("C 组 · 段落开头单调", findLocalHints(c, 0, c.length));
