import type { Candidate } from "./types";

export interface DiversityOptions {
  /** 只重排前多少项；后面的候选保持模型原始顺序。 */
  windowSize: number;

  /**
   * 纯标点惩罚。
   * logprob 减 1.5，相当于排序权重大约乘以 e^-1.5 ≈ 0.22。
   */
  punctuationPenalty: number;

  /** 纯空格或制表符的惩罚。 */
  whitespacePenalty: number;

  /** 换行仍有写作价值，所以惩罚小于普通标点。 */
  newlinePenalty: number;

  /** 与前排候选字面相似时的最大惩罚。 */
  similarityPenalty: number;

  /** 每多出现一个相同首字候选，追加的惩罚。 */
  sameInitialPenalty: number;
}

const DEFAULT_OPTIONS: DiversityOptions = {
  windowSize: 20,
  punctuationPenalty: 1.5,
  whitespacePenalty: 1.0,
  newlinePenalty: 0.4,
  similarityPenalty: 1.3,
  sameInitialPenalty: 0.35,
};

/**
 * 只生成比较键，绝不修改实际插入正文的 candidate.text。
 *
 * NFKC 会统一部分全角/半角形式；
 * trim 和空白折叠只用于比较，不会吃掉候选原本的空格或换行。
 */
function comparisonKey(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function isNewlineOnly(text: string): boolean {
  return text.length > 0 && /^[\r\n]+$/u.test(text);
}

function isWhitespaceOnly(text: string): boolean {
  return text.length > 0 && /^\s+$/u.test(text);
}

/**
 * Unicode P 类别包含中英文标点。
 * 先去掉空白，所以 " 。" 也会被识别为纯标点。
 */
function isPunctuationOnly(text: string): boolean {
  const compact = text
    .normalize("NFKC")
    .replace(/\s+/gu, "");

  return compact.length > 0 && /^\p{P}+$/u.test(compact);
}

function baseScore(candidate: Candidate): number {
  if (
    typeof candidate.logit === "number" &&
    Number.isFinite(candidate.logit)
  ) {
    return candidate.logit;
  }

  return Math.log(Math.max(candidate.prob, 1e-12));
}

/** Levenshtein 编辑距离。候选通常很短，这个动态规划的开销可以忽略。 */
function editDistance(left: string[], right: string[]): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;

    for (let j = 1; j <= right.length; j++) {
      const old = previous[j];
      const replaceCost = left[i - 1] === right[j - 1] ? 0 : 1;

      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + replaceCost,
      );

      diagonal = old;
    }
  }

  return previous[right.length];
}

function commonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;

  while (length < limit && left[length] === right[length]) {
    length += 1;
  }

  return length;
}

function commonSuffixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;

  while (
    length < limit &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1;
  }

  return length;
}

function bigramSet(chars: string[]): Set<string> {
  const result = new Set<string>();

  for (let i = 0; i < chars.length - 1; i++) {
    result.add(chars[i] + chars[i + 1]);
  }

  return result;
}

/** 字符二元组的 Dice 系数。 */
function bigramDice(left: string[], right: string[]): number {
  if (left.length < 3 || right.length < 3) return 0;

  const leftSet = bigramSet(left);
  const rightSet = bigramSet(right);

  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection += 1;
  }

  const denominator = leftSet.size + rightSet.size;
  return denominator > 0 ? (2 * intersection) / denominator : 0;
}

/**
 * 字面相似度，范围 0～1。
 *
 * 特意不计算语义相似度，因此：
 *   愤怒 / 恼火 / 生气 → 基本不受影响
 *   立刻 / 马上         → 基本不受影响
 *
 * 但下面这些会受到影响：
 *   慢慢走来 / 慢慢走去
 *   转过身去 / 转过头去
 *   他说道 / 他继续说道
 */
function lexicalSimilarity(leftText: string, rightText: string): number {
  const leftKey = comparisonKey(leftText);
  const rightKey = comparisonKey(rightText);

  if (!leftKey || !rightKey) return 0;
  if (leftKey === rightKey) return 1;

  const left = Array.from(leftKey);
  const right = Array.from(rightKey);
  const minLength = Math.min(left.length, right.length);
  const maxLength = Math.max(left.length, right.length);

  // 单字之间不做字面相似度判断。
  if (minLength <= 1) return 0;

  let similarity = 0;

  /*
   * 包含关系：
   *   "说道" / "继续说道"
   *   "走过去" / "慢慢走过去"
   */
  if (leftKey.includes(rightKey) || rightKey.includes(leftKey)) {
    similarity = Math.max(similarity, minLength / maxLength);
  }

  /*
   * 两字词只共享一个字的信息太弱。
   *
   * 例如：
   *   马上 / 马车
   *   战争 / 战役
   *
   * 因此编辑距离和公共前后缀只对至少三字的候选启用。
   * 两字候选的扎堆主要由“相同首字惩罚”处理。
   */
  if (maxLength >= 3) {
    const distance = editDistance(left, right);
    similarity = Math.max(
      similarity,
      1 - distance / maxLength,
    );
  }

  if (minLength >= 3) {
    const affixLength = Math.max(
      commonPrefixLength(left, right),
      commonSuffixLength(left, right),
    );

    similarity = Math.max(
      similarity,
      affixLength / minLength,
      bigramDice(left, right),
    );
  }

  return Math.max(0, Math.min(1, similarity));
}

/**
 * 相同首字分桶。
 *
 * 单字候选不分桶，因为它没有“同词头变体”的问题；
 * 纯标点、空格和换行也不参与。
 */
function initialKey(text: string): string | null {
  if (
    isNewlineOnly(text) ||
    isWhitespaceOnly(text) ||
    isPunctuationOnly(text)
  ) {
    return null;
  }

  const chars = Array.from(comparisonKey(text));
  return chars.length >= 2 ? chars[0] : null;
}

/**
 * 对候选的前若干项做轻量多样化重排。
 *
 * 重要约定：
 *   1. 不删除候选；
 *   2. 不修改 candidate.text；
 *   3. 不修改原始 logit / prob；
 *   4. windowSize 以外保持模型原始顺序。
 */
export function diversifyCandidates(
  candidates: Candidate[],
  options?: Partial<DiversityOptions>,
): Candidate[] {
  if (candidates.length <= 1) return candidates;

  const config: DiversityOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const targetSize = Math.min(
    Math.max(1, config.windowSize),
    candidates.length,
  );

  const remaining = candidates.map((candidate, originalIndex) => ({
    candidate,
    originalIndex,
  }));

  const selected: Candidate[] = [];
  const initialCounts = new Map<string, number>();

  while (selected.length < targetSize && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    let bestOriginalIndex = Infinity;

    for (let index = 0; index < remaining.length; index++) {
      const entry = remaining[index];
      const candidate = entry.candidate;
      let score = baseScore(candidate);

      if (isNewlineOnly(candidate.text)) {
        score -= config.newlinePenalty;
      } else if (isWhitespaceOnly(candidate.text)) {
        score -= config.whitespacePenalty;
      } else if (isPunctuationOnly(candidate.text)) {
        score -= config.punctuationPenalty;
      }

      // 和已进入前排的候选比较，只取最高字面相似度。
      let maximumSimilarity = 0;

      for (const previous of selected) {
        // 标点之间没有必要做词形相似度比较。
        if (
          isPunctuationOnly(candidate.text) ||
          isPunctuationOnly(previous.text) ||
          isWhitespaceOnly(candidate.text) ||
          isWhitespaceOnly(previous.text) ||
          isNewlineOnly(candidate.text) ||
          isNewlineOnly(previous.text)
        ) {
          continue;
        }

        maximumSimilarity = Math.max(
          maximumSimilarity,
          lexicalSimilarity(candidate.text, previous.text),
        );
      }

      score -= maximumSimilarity * config.similarityPenalty;

      const initial = initialKey(candidate.text);
      if (initial) {
        score -=
          (initialCounts.get(initial) ?? 0) *
          config.sameInitialPenalty;
      }

      /*
       * 得分相同时保持模型原始顺序。
       * 这样重排结果稳定，不会在多次相同请求间无故跳动。
       */
      if (
        score > bestScore ||
        (score === bestScore &&
          entry.originalIndex < bestOriginalIndex)
      ) {
        bestIndex = index;
        bestScore = score;
        bestOriginalIndex = entry.originalIndex;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    selected.push(picked.candidate);

    const initial = initialKey(picked.candidate.text);
    if (initial) {
      initialCounts.set(
        initial,
        (initialCounts.get(initial) ?? 0) + 1,
      );
    }
  }

  /*
   * 未进入重排窗口的候选恢复模型原始顺序。
   * remaining 在多次 splice 后仍然保持相对顺序，不过显式排序更清楚。
   */
  remaining.sort(
    (left, right) => left.originalIndex - right.originalIndex,
  );

  return [
    ...selected,
    ...remaining.map((entry) => entry.candidate),
  ];
}