import type { ReactNode } from "react";

import { CharactersTab } from "./CharactersTab";
import { ContextTab } from "./ContextTab";
import { LoreTab } from "./LoreTab";
import { OutlineTab } from "./OutlineTab";
import { ProofreadTab, type ProofreadTabProps } from "./ProofreadTab";
import { WORKBENCH_TABS, type WorkbenchTab } from "./tabs";
import { Icon } from "../Icon";
import type { Chapter, ChapterIndex } from "../../lib/chapters";
import type { MaterialHit } from "../../lib/materials";
import type { OutlineLayout, ResolvedSegment } from "../../lib/outline";
import type { PromptMode } from "../../lib/promptBuilder";
import type { ContextState, Materials } from "../../lib/types";

export type { WorkbenchTab } from "./tabs";

export interface WorkbenchProps {
  tab: WorkbenchTab | null;
  onSelectTab: (tab: WorkbenchTab | null) => void;

  /* 上下文 */
  context: ContextState;
  onContextChange: <K extends keyof ContextState>(key: K, value: ContextState[K]) => void;
  mode: PromptMode;
  anchored: boolean;
  anchorHardLimit: number;
  notices: string[];
  anchorNotice: string | null;
  /** 本次真正送进 prompt 的正文字数（已去掉章节标记行与空白）。 */
  bodyLength: number;
  /** 当前正文窗口里命中的卡片名字：只做展示与本地统计，不进提示词。 */
  hits: MaterialHit[];

  /* 大纲段（lib/outline.ts） */
  chapterIndex: ChapterIndex;
  currentChapter: Chapter;
  outlineLayout: OutlineLayout;
  currentSegment: ResolvedSegment;
  injecting: boolean;
  outlineFocusKey: string | null;
  onOutlineFocusHandled: () => void;
  onSegmentText: (resolved: ResolvedSegment, text: string) => void;
  onSegmentInject: (resolved: ResolvedSegment, inject: boolean) => void;
  onAddSegmentAtCaret: () => void;
  onMoveSegmentToCaret: (resolved: ResolvedSegment) => void;
  onRemoveSegment: (resolved: ResolvedSegment, merge: boolean) => void;
  onLocateSegment: (resolved: ResolvedSegment) => void;
  onJumpToChapter: (chapter: Chapter) => void;

  /* 素材 */
  materials: Materials;
  onMaterialsChange: (next: Materials) => void;
  /** 全文（面板里统计提及次数、提取候选名字用；由 useDeferredValue 包过，不卡打字）。 */
  text: string;
  /** 编辑器当前选中的文字（「新建角色」默认名字）。 */
  selectedText: string;

  /* 纠错 */
  proofread: ProofreadTabProps;
}

/** 右侧竖排图标栏：点击切换面板；再点当前项收起。 */
export function WorkbenchRail({
  tab,
  onSelectTab,
  badges,
}: {
  tab: WorkbenchTab | null;
  onSelectTab: (tab: WorkbenchTab | null) => void;
  badges: Partial<Record<WorkbenchTab, number>>;
}) {
  return (
    <nav className="workbench-rail" aria-label="写作面板">
      {WORKBENCH_TABS.map((item) => (
        <button
          key={item.id}
          className={`icon-button rail-button ${tab === item.id ? "is-active" : ""}`}
          type="button"
          title={item.label}
          aria-label={item.label}
          aria-pressed={tab === item.id}
          onClick={() => onSelectTab(tab === item.id ? null : item.id)}
        >
          <Icon name={item.icon} size={21} />
          <span className="rail-label">{item.label}</span>
          {badges[item.id] ? <span className="rail-badge">{badges[item.id]}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function Shell({ tab, onClose, children }: { tab: WorkbenchTab; onClose: () => void; children: ReactNode }) {
  const meta = WORKBENCH_TABS.find((item) => item.id === tab) ?? WORKBENCH_TABS[0];
  return (
    <aside className="side-panel context-sidebar workbench-panel" aria-label={meta.label}>
      <div className="panel-heading">
        <div>
          <span className="panel-eyebrow">{meta.eyebrow}</span>
          <h2>{meta.label}</h2>
        </div>
        <button className="icon-button panel-close" type="button" onClick={onClose} aria-label="收起面板">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </aside>
  );
}

/** 右侧面板本体（tab 为 null 时不渲染）。 */
export function WorkbenchPanel(props: WorkbenchProps) {
  const { tab, onSelectTab } = props;
  if (!tab) return null;
  const close = () => onSelectTab(null);
  return (
    <Shell tab={tab} onClose={close}>
      {tab === "context" && (
        <ContextTab
          context={props.context}
          onContextChange={props.onContextChange}
          mode={props.mode}
          anchored={props.anchored}
          currentSegment={props.currentSegment}
          injecting={props.injecting}
          notices={props.notices}
          anchorNotice={props.anchorNotice}
          bodyLength={props.bodyLength}
          hits={props.hits}
          materials={props.materials}
          currentChapter={props.currentChapter}
          onOpenTab={onSelectTab}
        />
      )}
      {tab === "outline" && (
        <OutlineTab
          notes={props.context.outlineText}
          onNotesChange={(text) => props.onContextChange("outlineText", text)}
          outlineEnabled={props.context.outlineEnabled}
          onOutlineEnabledChange={(next) => props.onContextChange("outlineEnabled", next)}
          text={props.text}
          chapterIndex={props.chapterIndex}
          currentChapter={props.currentChapter}
          layout={props.outlineLayout}
          current={props.currentSegment}
          injecting={props.injecting}
          anchorHardLimit={props.anchorHardLimit}
          focusKey={props.outlineFocusKey}
          onFocusHandled={props.onOutlineFocusHandled}
          onSegmentText={props.onSegmentText}
          onSegmentInject={props.onSegmentInject}
          onAddAtCaret={props.onAddSegmentAtCaret}
          onMoveToCaret={props.onMoveSegmentToCaret}
          onRemove={props.onRemoveSegment}
          onLocate={props.onLocateSegment}
          onJumpToChapter={props.onJumpToChapter}
        />
      )}
      {tab === "characters" && (
        <CharactersTab
          materials={props.materials}
          onChange={props.onMaterialsChange}
          text={props.text}
          chapterIndex={props.chapterIndex}
          currentChapter={props.currentChapter}
          selectedText={props.selectedText}
        />
      )}
      {tab === "lore" && (
        <LoreTab
          materials={props.materials}
          onChange={props.onMaterialsChange}
          text={props.text}
          selectedText={props.selectedText}
        />
      )}
      {tab === "proofread" && <ProofreadTab {...props.proofread} />}
    </Shell>
  );
}
