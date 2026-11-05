/**
 * 模型画像：提示词模板、终止符、上下文长度。
 *
 * 归属：主进程在后端就绪后从 llama-server 的 /props + /tokenize 推断出 ModelProfile，
 * renderer 通过 model:profile 读取；renderer 自己不再维护任何模型族相关的常量。
 * 这里只放「两边都要用」的类型与默认值（默认 = Qwen ChatML，与历史行为一致）。
 */

export type PromptTemplateId = 'chatml' | 'gemma' | 'llama3'

/**
 * 四段式提示词模板。promptBuilder.assemble() 按
 *   systemOpen + 系统文案 + systemClose + userOpen + 用户指令 + userClose + assistantOpen + 正文
 * 的顺序拼接，不同模型族只是标记不同。
 */
export interface PromptTemplate {
  id: PromptTemplateId
  systemOpen: string
  systemClose: string
  userOpen: string
  userClose: string
  assistantOpen: string
}

export const CHATML_TEMPLATE: PromptTemplate = {
  id: 'chatml',
  systemOpen: '<|im_start|>system\n',
  systemClose: '<|im_end|>\n',
  userOpen: '<|im_start|>user\n',
  userClose: '<|im_end|>\n',
  assistantOpen: '<|im_start|>assistant\n'
}

/** Gemma 没有 system 角色：系统文案并入第一轮 user。 */
export const GEMMA_TEMPLATE: PromptTemplate = {
  id: 'gemma',
  systemOpen: '<start_of_turn>user\n',
  systemClose: '\n\n',
  userOpen: '',
  userClose: '<end_of_turn>\n',
  assistantOpen: '<start_of_turn>model\n'
}

export const LLAMA3_TEMPLATE: PromptTemplate = {
  id: 'llama3',
  systemOpen: '<|start_header_id|>system<|end_header_id|>\n\n',
  systemClose: '<|eot_id|>',
  userOpen: '<|start_header_id|>user<|end_header_id|>\n\n',
  userClose: '<|eot_id|>',
  assistantOpen: '<|start_header_id|>assistant<|end_header_id|>\n\n'
}

export const PROMPT_TEMPLATES: Record<PromptTemplateId, PromptTemplate> = {
  chatml: CHATML_TEMPLATE,
  gemma: GEMMA_TEMPLATE,
  llama3: LLAMA3_TEMPLATE
}

/** 可能代表「文本结束」的标记。哪些真的是单个 token，主进程启动后用 /tokenize 确认。 */
export const DEFAULT_EOS_TEXTS: readonly string[] = [
  '<|im_end|>',
  '<|endoftext|>',
  '<|eot_id|>',
  '<end_of_turn>',
  '<eos>',
  '</s>',
  '<|end|>'
]

/** 不是结束符、但也不该出现在候选里的特殊标记（思考标记、对话开始标记）。 */
export const DEFAULT_HIDDEN_TEXTS: readonly string[] = ['<think>', '</think>', '<|im_start|>']

export interface ModelProfile {
  modelName: string
  /** llama-server 实际生效的「每槽」上下文长度（/props 的 n_ctx 已是单槽值）；null = 主进程也没查到。 */
  contextLength: number | null
  /** 并行槽位数（/props 的 total_slots）。≥ 2 时纠错等后台任务才能用槽 1，不与候选抢缓存。 */
  slots: number
  template: PromptTemplate
  /**
   * 非思考模式下 assistant 回合开头应有的空思考块（Qwen3 / Qwen3.5 的 chat_template 在
   * enable_thinking=false 时就是注入它）。'' = 模型没有思考模式。
   *
   * ★ 事故记录（2026-10-14，Qwen3.5-9B Q4，纠错首版；详见 structure.md 开头）：
   *   prompt 停在 `<|im_start|>assistant\n` 就套 GBNF 文法，模型对明显病句一律回「无」，
   *   日志 predicted_n=2 —— 只吐了「无」+EOS。原因：模型的自然首 token 是 `<think>`，被文法判非法后
   *   合法集合只剩「无 / A / B」，「无」是唯一一个 token 就能合法结束的输出，于是判断被迫提前到第一个 token
   *   并坍缩。约束解码只在合法 token 里重新归一化，不会补上被排除的自然首 token。
   *   指令类任务（纠错）必须把它接在 assistantOpen 之后，模型才处于训练时的「直接作答」分布；
   *   微调时训练样本的回合格式也必须与运行时逐字节一致（含这个空思考块）。
   *
   * ★ 2026-10-25 起续写也统一加上它（promptBuilder.assemble）：候选 / 短句展开 / 纠错三条链路
   *   的 assistant 回合开头完全一致，都是「assistantOpen + 空思考块」，之后才各自接正文或输出格式。
   *   理由是这就是底模训进去的分布（Qwen 官方 chat_template 在 enable_thinking=false 时的写法），
   *   也便于将来做 SFT：一套样本格式覆盖全部任务。此前「续写有意不加」的决定已作废。
   */
  noThinkPrefix: string
  /** 终止符文本（含服务器报告的 eos_token），renderer 的 mock / 兜底判断用。 */
  eosTexts: string[]
}

/** 没有主进程（浏览器演示）或后端未就绪时使用的画像。 */
export const NO_THINK_PREFIX = '<think>\n\n</think>\n\n'

export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  modelName: '',
  contextLength: null,
  slots: 1,
  template: CHATML_TEMPLATE,
  noThinkPrefix: '',
  eosTexts: [...DEFAULT_EOS_TEXTS]
}

/**
 * 从 llama-server /props 的 chat_template（Jinja 文本）或模型名推断模板。
 * 识别不出来时保持 ChatML（历史默认），不报错。
 */
/** 模板里出现 <think>（或模型名是 Qwen3.5）即视为有思考开关。 */
export function detectNoThinkPrefix(chatTemplate: string, modelName: string): string {
  if (chatTemplate.includes('<think>') || /qwen3\.5/i.test(modelName)) return NO_THINK_PREFIX
  return ''
}

export function detectPromptTemplate(chatTemplate: string, modelName: string): PromptTemplate {
  if (chatTemplate.includes('<|im_start|>')) return CHATML_TEMPLATE
  if (chatTemplate.includes('<start_of_turn>')) return GEMMA_TEMPLATE
  if (chatTemplate.includes('<|start_header_id|>')) return LLAMA3_TEMPLATE
  if (/gemma/i.test(modelName)) return GEMMA_TEMPLATE
  if (/llama-?3/i.test(modelName)) return LLAMA3_TEMPLATE
  return CHATML_TEMPLATE
}
