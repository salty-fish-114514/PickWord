/**
 * 候选结果的后处理（纯函数）：排序 → 软化 → 终止符判定 → 过滤 → 多样化重排。
 * 从 WritingEditor 抽出来，便于单测，也让编辑器只关心「拿到结果后更新哪些 state」。
 */
import { applySoftening } from "./candidateProvider";
import { diversifyCandidates } from "./candidateDiversity";
import type { Candidate } from "./types";

export interface PostprocessOptions {
  softenTemperature: number;
  /** 在候选的前 N 个里扫描终止符。 */
  eosScanTopN: number;
  /** 终止符软化后概率至少要达到它才算命中。 */
  eosMinProb: number;
  /** 只有大纲参与 prompt 时才判定终止符（纯续写 / 仅风格没有「本章该收尾」的概念）。 */
  outlineMode: boolean;
}

export interface PostprocessResult {
  /** 展示给作者的候选：已去掉终止符、重新软化、多样化重排。 */
  candidates: Candidate[];
  /** 本次是否命中终止符（outlineMode=false 时恒为 false）。 */
  eosHit: boolean;
}

export function postprocessCandidates(result: Candidate[], options: PostprocessOptions): PostprocessResult {
  const sorted = [...result].sort(
    (left, right) => (right.logit ?? Math.log(right.prob || 1e-9)) - (left.logit ?? Math.log(left.prob || 1e-9)),
  );

  // 先对**全部**候选（含终止符）软化一次：终止符的概率要和其它词放在同一把尺子上比，
  // 才能用「≥ 10%」这样的阈值；单独拿它的原始 softmax 值没有意义。
  let eosHit = false;
  if (options.outlineMode) {
    const softenedAll = applySoftening(sorted, options.softenTemperature);
    eosHit = softenedAll.slice(0, options.eosScanTopN).some((item) => item.isEos && item.prob >= options.eosMinProb);
  }

  // 终止符不展示给作者；去掉它之后再软化一次，让展示的百分比加起来是 100%。
  const usable = applySoftening(
    sorted.filter((item) => !item.isEos && item.text.length > 0),
    options.softenTemperature,
  );

  // 轻量多样化重排：降低纯标点/空格候选的排名，惩罚与前排候选字面相似的项目。
  // 不删除候选、不修改原始 prob/logit。
  return { candidates: diversifyCandidates(usable), eosHit };
}
