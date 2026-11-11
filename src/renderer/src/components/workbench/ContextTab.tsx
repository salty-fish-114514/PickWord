import { Block, Switch } from "./shared";
import type { WorkbenchTab } from "./tabs";
import { Icon } from "../Icon";
import { chapterLabel, type Chapter } from "../../lib/chapters";
import type { MaterialHit } from "../../lib/materials";
import type { ResolvedSegment } from "../../lib/outline";
import { PROMPT_MODE_LABEL, type PromptMode } from "../../lib/promptBuilder";
import type { ContextState, Materials } from "../../lib/types";
import { countChars } from "../../../../shared/text";

interface ContextTabProps {
  context: ContextState;
  onContextChange: <K extends keyof ContextState>(key: K, value: ContextState[K]) => void;
  mode: PromptMode;
  anchored: boolean;
  /** 光标所在的大纲段与它此刻是否在注入。 */
  currentSegment: ResolvedSegment;
  injecting: boolean;
  notices: string[];
  anchorNotice: string | null;
  bodyLength: number;
  /** 当前正文窗口里命中（名字 / 别名出现）的卡片：只做展示，不进提示词。 */
  hits: MaterialHit[];
  materials: Materials;
  currentChapter: Chapter;
  onOpenTab: (tab: WorkbenchTab) => void;
}

/**
 * 「上下文」：一眼看清这次送给模型的四样东西 —— 风格参考、大纲、人物与设定、正文窗口。
 * 风格参考在这里直接编辑（它不属于任何一章）；大纲与素材只给开关和摘要，细编辑在各自的页签。
 */
export function ContextTab({
  context,
  onContextChange,
  mode,
  anchored,
  currentSegment,
  injecting,
  notices,
  anchorNotice,
  bodyLength,
  hits,
  materials,
  currentChapter,
  onOpenTab,
}: ContextTabProps) {
  const segment = currentSegment.segment;
  const where = `${chapterLabel(currentChapter)} · 大纲段 ${currentSegment.ordinal}/${currentSegment.count}`;
  const outlineSummary = !context.outlineEnabled
    ? "未使用（总开关已关）"
    : !segment || !segment.text.trim()
      ? `${where}：这一段还没写大纲`
      : !segment.inject
        ? `${where}：本段已单独关闭注入`
        : injecting
          ? `${where} · ${countChars(segment.text)} 字`
          : `${where}：光标还在段起点之前`;
  return (
    <>
      <div className="mode-chip" title="由「风格参考」「大纲」两个开关共同决定">
        <Icon name="sparkle" size={14} />
        <span>
          当前：{PROMPT_MODE_LABEL[mode]}
          {anchored ? " · 正文从段起点开始" : ""}
        </span>
      </div>

      {anchorNotice && <p className="anchor-notice">{anchorNotice}</p>}

      <Block
        title="风格参考"
        action={<Switch checked={context.styleEnabled} label="使用风格参考" onChange={(next) => onContextChange("styleEnabled", next)} />}
      >
        <textarea
          className={`context-textarea ${context.styleEnabled ? "" : "is-disabled"}`}
          value={context.styleText}
          disabled={!context.styleEnabled}
          rows={5}
          aria-label="风格参考文本"
          placeholder="（可选）粘贴几段你想模仿的文字，AI 预测的词会更贴近这种风格……"
          onChange={(event) => onContextChange("styleText", event.target.value)}
        />
        {context.styleEnabled && (
          <p className="context-hint">
            {countChars(context.styleText)} 字 · 风格文本位于提示词最前面且固定不变，缓存必然命中，可以放心贴长文。长篇的各卷共用同一份。
          </p>
        )}
      </Block>

      <Block
        title="大纲段"
        action={<Switch checked={context.outlineEnabled} label="注入大纲段" onChange={(next) => onContextChange("outlineEnabled", next)} />}
      >
        <div className="context-summary">
          <span>{outlineSummary}</span>
          <button className="link-button" type="button" onClick={() => onOpenTab("outline")}>
            编辑大纲
          </button>
        </div>
        <p className="context-hint">只注入光标所在段的大纲；总纲只给自己看。</p>
      </Block>

      <Block title="人物与设定 · 只统计，不进提示词">
        {hits.length === 0 ? (
          <div className="context-summary">
            <span>
              {materials.characters.length + materials.lore.length === 0
                ? "还没有角色卡或设定条目"
                : "当前正文窗口里没有出现已建卡的名字"}
            </span>
            <button className="link-button" type="button" onClick={() => onOpenTab("characters")}>
              管理卡片
            </button>
          </div>
        ) : (
          <ul className="hit-list">
            {hits.map((hit) => (
              <li key={`${hit.kind}:${hit.id}`} className="hit-item">
                <Icon name={hit.kind === "character" ? "person" : "lore"} size={14} />
                <span className="hit-name">{hit.name}</span>
                <span className="hit-count">本窗口出现 {hit.count} 次</span>
              </li>
            ))}
          </ul>
        )}
        <p className="context-hint">
          名字（或别名）出现在当前正文窗口里就列在这儿，纯本地统计：卡片内容不会送进提示词。名字另外用于「提及 N 次」、重复提示的白名单和专名写法检查。
        </p>
      </Block>

      <div className="context-footer">
        <div className="context-meter">
          <span>本次送入正文</span>
          <strong>{bodyLength} 字</strong>
        </div>
        {notices.length > 0 && (
          <ul className="context-notices">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
