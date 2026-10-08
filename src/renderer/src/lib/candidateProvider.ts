/**
 * 候选词数据源。
 *
 * 这里是「唯一的数据源切换点」：
 *   chooseCandidateSource() 检测 window.api 是否存在，
 *   存在 → realCandidateProvider（走 Electron IPC）
 *   不存在 → mockCandidateProvider（浏览器演示）
 * 集成到 Electron 时，除了 preload 暴露 api，这个文件之外的代码一行都不用改。
 *
 * 概率的分工：
 *   后端只负责给 logit / logprob（原始数值），
 *   前端用 applySoftening() + 设置里的温度算出展示概率。
 *   这样「软化温度」才能做成可调设置，不用每次改温度都重新请求。
 */

import type { Candidate, CandidateProvider, CandidateRequest } from "./types";

/** 后端固定返回的候选数量。前端自己分页展示，设置里的「每页候选数」只控制每页显示几个。 */
export const BACKEND_TOP_K = 100;

/**
 * ═══ 前端是怎么认出「终止符」的 ═══
 *
 * 前端自己**不做分词**，也拿不到 token id 表，所以只能靠两条线索：
 *   1. 主进程在 Candidate 上标好的 isEos（最可靠：主进程按 token id 判断，
 *      Qwen2/2.5/3 的 <|im_end|> = 151645，<|endoftext|> = 151643）；
 *   2. 主进程没标时，退而比对候选的**文本**是否正好等于下面这些特殊 token 的字符串形式。
 *
 * 第 2 条有两个已知的坑，都需要主进程配合（见 INTEGRATION.md）：
 *   - llama-server 对特殊 token 的 `token` 字段有时返回空串 ""，文本比对就会漏掉；
 *   - 纯续写（plain）模式下 prompt 里没有 <|im_start|>，Qwen 很少会预测 <|im_end|>，
 *     更可能给出 <|endoftext|>，所以列表里两者都要有。
 *
 * 识别出来之后还要过两道门槛才算一次「命中」（见 App.tsx runJob）：
 *   - 排名门槛：出现在前 eosScanTopN 个候选里；
 *   - 概率门槛：软化后的概率 ≥ eosMinProb（默认 10%）。
 * 以及一条前置条件：**只在大纲模式下计数**。纯续写 / 仅风格模式没有「本章该收尾」的概念，
 * 模型偶尔给出终止符只是统计噪声，不应打扰作者。
 */
export const EOS_TOKENS = ["<|im_end|>", "</s>", "<|endoftext|>", "<|end|>", "<|eot_id|>", "<|im_start|>"];

/** 判断一个候选文本是不是终止符。 */
export function isEosText(text: string): boolean {
  return EOS_TOKENS.includes(text.trim());
}

/* ════════════════════════════════════════════════════════════════
   模型加载进度（演示）
   ════════════════════════════════════════════════════════════════ */

/**
 * 浏览器演示用的「假加载」：几秒内从 0 走到 1，模拟读取权重 → 分配 KV → 预热的过程，
 * 让首页和编辑器的进度条有东西可看。真实环境由主进程推送 BackendProgress。
 * 返回取消函数。
 */
export function simulateBackendProgress(
  onProgress: (progress: { fraction: number; summary: string; etaSeconds?: number; prefillTokensPerSecond?: number }) => void,
  onReady: () => void,
): () => void {
  const totalMs = 4200;
  const started = performance.now();
  let timer: number | null = null;

  const tick = () => {
    const elapsed = performance.now() - started;
    const fraction = Math.min(1, elapsed / totalMs);
    const remaining = Math.max(0, (totalMs - elapsed) / 1000);
    const summary =
      fraction < 0.55
        ? `读取模型权重 ${(fraction / 0.55 * 1.8).toFixed(1)} GB / 1.8 GB`
        : fraction < 0.85
          ? "分配 KV cache（16384 token）"
          : "预热推理内核";
    onProgress({ fraction, summary, etaSeconds: remaining, prefillTokensPerSecond: 900 });
    if (fraction >= 1) {
      onReady();
      return;
    }
    timer = window.setTimeout(tick, 180);
  };
  timer = window.setTimeout(tick, 120);

  return () => {
    if (timer !== null) window.clearTimeout(timer);
  };
}

/**
 * 估算重算一段上下文要多少秒。
 * 字符数 × 每字 token 密度 ÷ prefill 速度。中文常规文本约 0.6 token/字；
 * 速度未知时按一台普通 CPU 的保守值 300 token/s 估。
 */
export function estimatePrefillSeconds(chars: number, tokensPerSecond: number | undefined): number {
  const tokens = chars * 0.6;
  const speed = tokensPerSecond && tokensPerSecond > 0 ? tokensPerSecond : 300;
  return tokens / speed;
}

/**
 * 把 logits 变成「不那么极端」的相对概率。
 *
 * 为什么需要它：
 * 原始 softmax 会让 top1 吃掉 60%~90% 的概率，后面几十个词全是 0.00x，
 * 展示出来几乎全是 0%，概率条也全是空的，对作者毫无参考价值。
 * 这里用一个温度参数 T（T > 1 时分布更平缓）做软化：
 *     p_i = exp(logit_i / T) / Σ exp(logit_j / T)
 * 先减去最大值再取 exp，是数值稳定性的标准做法（避免 exp 溢出）。
 * logprob 与 logit 只差一个常数，代入这个公式结果完全一样，所以后端给哪个都行。
 */
export function softenLogits(logits: number[], temperature: number): number[] {
  if (logits.length === 0) return [];
  const t = Math.max(0.05, temperature);
  const maxLogit = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp((logit - maxLogit) / t));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
}

/**
 * 对一组候选应用软化：用 logit（缺失时用 log(prob) 代替）重新算 prob，并按新 prob 降序。
 * 这是幂等的：对已经软化过的列表再调一次（比如用户拖动温度滑杆），结果仍然正确，
 * 因为我们始终从 logit 字段出发，而不是从上一次的 prob 出发。
 */
export function applySoftening(candidates: Candidate[], temperature: number): Candidate[] {
  if (candidates.length === 0) return [];
  const logits = candidates.map((item) => {
    if (typeof item.logit === "number" && Number.isFinite(item.logit)) return item.logit;
    return item.prob > 0 ? Math.log(item.prob) : -30;
  });
  const probs = softenLogits(logits, temperature);
  return candidates
    .map((item, index) => ({ ...item, logit: logits[index], prob: probs[index] ?? 0 }))
    .sort((left, right) => right.prob - left.prob);
}

let requestCounter = 0;

/** 生成请求 id：时间戳 + 自增计数，进程内唯一即可。 */
export function createRequestId(): string {
  requestCounter += 1;
  return `${Date.now().toString(36)}-${requestCounter}`;
}

/* ════════════════════════════════════════════════════════════════
   演示数据源
   ════════════════════════════════════════════════════════════════ */

/** 演示用词库：按语义分组，mock 会根据光标前文字挑选更贴合的组。 */
const WORD_POOL = {
  general: [
    "也许", "忽然", "仍然", "终于", "只是", "仿佛", "沉默", "远方", "微光", "轻轻地",
    "很久以后", "没有回答", "从那以后", "在某个清晨", "一瞬间", "慢慢地", "于是", "然而",
    "大概", "始终", "偶尔", "依旧", "分明", "渐渐", "不知为何", "像是", "此刻", "后来",
    "我想", "他说", "她抬起头", "窗外", "灯下", "夜里", "清晨", "黄昏", "空气里", "沉沉地",
    "静静地", "无声地", "缓缓", "忽明忽暗", "一点点", "所有的", "那些", "这一切", "心里",
    "手指", "呼吸", "影子", "声音", "味道", "温度", "距离", "时间", "记忆", "念头",
  ],
  river: [
    "水纹", "岸边", "船影", "月色", "雾气", "灯火", "很远的地方", "安静下来", "向前流去",
    "轻轻晃动", "一圈涟漪", "没有声响", "泛起", "浮着", "沉下去", "漂远", "靠岸", "渡口",
    "芦苇", "潮气", "波光", "倒影", "水声",
  ],
  dialogue: [
    "他顿了顿", "我说", "你知道吗", "她笑了", "没有人说话", "过了一会儿", "声音很轻",
    "像在自言自语", "低声说", "摇了摇头", "点点头", "沉默了很久",
  ],
  punctuation: ["，", "。", "；", "：", "、", "——", "……", "？", "！", "“", "”", "\n"],
};

/** 从词库里组一个去重的候选集合，长度恰好 count。 */
function buildWordList(prefix: string, count: number): string[] {
  const tail = prefix.slice(-24);
  const words: string[] = [];

  if (/河|水|岸|船|波|渡|雨|湖/.test(tail)) words.push(...WORD_POOL.river);
  if (/[“”"]|说|问|答/.test(tail)) words.push(...WORD_POOL.dialogue);
  words.push(...WORD_POOL.general, ...WORD_POOL.punctuation);

  const unique = [...new Set(words)];
  // 词库不足时，用组合词补足，保证能演示分页（PageUp/PageDown）。
  let index = 0;
  while (unique.length < count) {
    const base = WORD_POOL.general[index % WORD_POOL.general.length];
    const suffix = WORD_POOL.general[(index * 7 + 3) % WORD_POOL.general.length];
    const combined = `${base}${suffix}`;
    if (!unique.includes(combined)) unique.push(combined);
    index += 1;
  }
  return unique.slice(0, count);
}

/** 可被 AbortSignal 打断的 sleep。旧请求被取消时会立刻 reject，不会白白占着 timer。 */
function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("请求已取消", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 演示数据源：生成 topK 个候选，附带伪 logit 与「原始 softmax」概率（T=1，故意很极端）。
 * 当光标前刚好是句号/问号/感叹号时，有较大概率把 <|im_end|> 放进前 20，
 * 用来演示「EOS 弱提醒 Toast」。
 */
export const mockCandidateProvider: CandidateProvider = async (
  request: CandidateRequest,
  signal: AbortSignal,
): Promise<Candidate[]> => {
  // 真实本地模型大约几百毫秒，这里模拟 260~620ms。
  await waitWithAbort(260 + Math.random() * 360, signal);

  const words = buildWordList(request.bodyPrefix, request.topK);
  // 递减的伪 logits：头部高、尾部低，再叠加随机扰动，接近真实模型的长尾分布。
  const logits = words.map((_, index) => 6.5 - index * 0.11 + (Math.random() - 0.5) * 1.6);

  const tail = request.bodyPrefix.trimEnd();
  const endsSentence = /[。！？”]$/.test(tail);
  const paragraphEnded = /\n\s*$/.test(request.bodyPrefix);
  if ((endsSentence || paragraphEnded) && Math.random() < 0.72) {
    const position = Math.floor(Math.random() * 14) + 2;
    words.splice(position, 0, "<|im_end|>");
    logits.splice(position, 0, 5.4 + Math.random() * 1.2);
  }

  const rawProbs = softenLogits(logits, 1);
  return words
    .map((text, index) => ({
      text,
      prob: rawProbs[index] ?? 0,
      logit: logits[index],
      isEos: isEosText(text),
    }))
    .sort((left, right) => (right.logit ?? 0) - (left.logit ?? 0))
    .slice(0, request.topK);
};

/* ════════════════════════════════════════════════════════════════
   真实数据源（Electron IPC）
   ════════════════════════════════════════════════════════════════ */

/**
 * 通过 preload 暴露的 window.api.getCandidates 走 IPC。
 *
 * 关于取消：AbortSignal 过不了 ipcRenderer.invoke，所以这里把 abort 翻译成
 * window.api.cancelCandidates(requestId)，由主进程中断对 llama-server 的 HTTP 请求。
 * 主进程没实现 cancel 时也不会报错：UI 层的「单飞 + 最新优先」策略保证最多只有一个请求在飞。
 */
export const realCandidateProvider: CandidateProvider = async (
  request: CandidateRequest,
  signal: AbortSignal,
): Promise<Candidate[]> => {
  if (signal.aborted) throw new DOMException("请求已取消", "AbortError");

  const api = window.api;
  const getCandidates = api?.getCandidates;
  if (!getCandidates) throw new Error("主进程尚未暴露 getCandidates 接口。");

  const onAbort = () => {
    void api?.cancelCandidates?.(request.requestId);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await getCandidates(request);
    if (signal.aborted) throw new DOMException("请求已取消", "AbortError");

    // 规范化：补 logit（缺失时用 log(prob)）、补 isEos。
    return result.map((item) => ({
      ...item,
      logit:
        typeof item.logit === "number" && Number.isFinite(item.logit)
          ? item.logit
          : item.prob > 0
            ? Math.log(item.prob)
            : undefined,
      isEos: item.isEos ?? isEosText(item.text),
    }));
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

export interface CandidateSource {
  provider: CandidateProvider;
  /** true = 浏览器演示模式（界面底部会显示「演示模式」）。 */
  isDemo: boolean;
  /**
   * 后端是否支持真正取消。
   * true  → 新请求到来时立即 abort 在飞请求（后端会尽早停下），再发新请求；
   * false → 「单飞」：在飞请求不打断，新请求排队，只保留最新的一个（防止后端堆积）。
   */
  supportsCancel: boolean;
}

/** 启动时自动选择数据源。整个应用只有这一处做判断。 */
export function chooseCandidateSource(): CandidateSource {
  if (typeof window !== "undefined" && typeof window.api?.getCandidates === "function") {
    return {
      provider: realCandidateProvider,
      isDemo: false,
      supportsCancel: typeof window.api.cancelCandidates === "function",
    };
  }
  // mock 的 abort 会真正停掉计时器，所以它「支持取消」。
  return { provider: mockCandidateProvider, isDemo: true, supportsCancel: true };
}

/**
 * 按概率随机采样一个候选（「随机取词键」用）。
 * 标准轮盘赌：把所有概率累加，取一个 [0, total) 随机数落在哪个区间就选谁。
 * 从全部候选（不只是当前页）里采样，低频词也有机会出现。
 */
export function sampleByProbability(candidates: Candidate[]): Candidate | null {
  const usable = candidates.filter((item) => !item.isEos && item.prob > 0);
  if (usable.length === 0) return null;

  const total = usable.reduce((sum, item) => sum + item.prob, 0);
  let dice = Math.random() * total;
  for (const candidate of usable) {
    dice -= candidate.prob;
    if (dice <= 0) return candidate;
  }
  return usable[usable.length - 1];
}
