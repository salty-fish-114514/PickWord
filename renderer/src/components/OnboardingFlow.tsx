/**
 * 新手引导：首次进入 App 弹一次；设置「基本」页可重看。
 *
 * 8 页；**每一步都能跳过**——「下一步」永不锁定，试做页的 ✓ 只是鼓励不是门槛。
 * 试做页（A2 候选 / A3 两个长按键 / A4 大纲段）嵌真实编辑器：练习文稿不落库
 * （自动保存关、onSave 空转），触发参数临时调快（停笔 0.6 秒出候选），完成动作
 * 由 WritingEditor 的 onTaskEvent 上报打勾。
 * LLM 相关参数（上下文、槽位、温度……）全程零出现。
 * 文案与布局以 ui-draft.md（用户手改定稿）为准。
 */
import { useCallback, useMemo, useState } from "react";

import { PresetCards } from "./PresetCards";
import { emptyDocument } from "../lib/library";
import { HOLD_KEY_SHORT, applyPreset, type SettingsValues } from "../lib/settings";
import type { DocumentPayload, LibraryEntry } from "../lib/types";
import { WritingEditor, type WritingTaskEvent } from "../WritingEditor";

/** A2 / A3 共用的练习句。 */
const PRACTICE_TEXT = "夜色像一张浸了水的宣纸，慢慢";

/** A4 的练习章：章节标记行 + 章首段 + 两个正文段（在第二段里右键起大纲段）。 */
const PRACTICE_CHAPTER = [
  "--第1章 雾溪镇--",
  "陆青梧是在一个落雨的傍晚到雾溪镇的。",
  "",
  "镇口的青石板路被两百年的脚步磨得发亮。他收紧书箱的带子，把伞压低了一些。",
  "",
  "私塾在镇东，窗纸破了一个洞，风从那里进来，翻动桌上的历书。",
].join("\n");

const TASKS: WritingTaskEvent[] = ["candidate-accepted", "hold-hide", "hold-expand", "outline-segment"];

type Tasks = Record<WritingTaskEvent, boolean>;

/** 练习用编辑器：真实组件，只是不落库、触发调快、纠错关掉（别在引导里添乱）。 */
function PracticeEditor({
  practiceKey,
  text,
  settings,
  onTaskEvent,
}: {
  practiceKey: string;
  text: string;
  settings: SettingsValues;
  onTaskEvent: (event: WritingTaskEvent) => void;
}) {
  const doc = useMemo<DocumentPayload>(() => emptyDocument("练习", text), [text]);
  const practiceSettings = useMemo<SettingsValues>(
    () => ({
      ...settings,
      autoSaveEnabled: false,
      triggerDelay: 600,
      quickMode: false,
      keepPopover: false,
      expandAuto: false,
      proofreadAuto: false,
      proofreadLocal: false,
    }),
    [settings],
  );
  const noopSave = useCallback(
    async (): Promise<LibraryEntry> => ({
      id: "onboarding-practice",
      title: "练习",
      excerpt: "",
      sourceFormat: "txt",
      characterCount: 0,
      updatedAt: Date.now(),
      interactedAt: Date.now(),
    }),
    [],
  );
  return (
    <div className="onboarding-practice">
      <WritingEditor
        key={practiceKey}
        initial={doc}
        sourceFormat="txt"
        settings={practiceSettings}
        onToggleAutoSave={() => undefined}
        onSettingChange={() => undefined}
        onSave={noopSave}
        onBack={() => undefined}
        onTaskEvent={onTaskEvent}
      />
    </div>
  );
}

type SettingsPanelChange = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;

interface OnboardingFlowProps {
  settings: SettingsValues;
  /** A7 选预设直接写进真实设置（之后随时可逐项改）。 */
  onSettingsChange: SettingsPanelChange;
  /** create = A8「新建文稿并开始写作」；close = 其它任何离开方式。 */
  onFinish: (action: "close" | "create") => void;
}

const PAGE_COUNT = 8;



export function OnboardingFlow({ settings, onSettingsChange, onFinish }: OnboardingFlowProps) {
  const [page, setPage] = useState(0);
  const [tasks, setTasks] = useState<Tasks>(() => Object.fromEntries(TASKS.map((task) => [task, false])) as Tasks);

  const markTask = useCallback((event: WritingTaskEvent) => {
    setTasks((prev) => (prev[event] ? prev : { ...prev, [event]: true }));
  }, []);

  const hideKeyLabel = HOLD_KEY_SHORT[settings.hideKey] || "隐藏键";
  const expandKeyLabel = HOLD_KEY_SHORT[settings.expandKey] || "展开键";

  const titles = [
    "欢迎使用 PickWord",
    "从选择中写作",
    "展开与淡化候选",
    "书 · 章 · 大纲段",
    "自动纠错及润色辅助",
    "人物与设定",
    "选择一套预设",
    "好了",
  ];

  function renderBody() {
    switch (page) {
      case 0:
        return (
          <div className="onboarding-copy">
            <p>这是一个完全离线的写作软件：模型跑在你自己的显卡上，文字从不离开这台电脑。</p>
            <p>接下来两分钟，带你把最常用的几件事各做一遍。</p>
          </div>
        );
      case 1:
        return (
          <div className="onboarding-copy">
            <p>写作时停笔片刻，光标旁会浮出几个候选词。</p>
            <p>
              按数字键直接插入；按 Esc 立即收起浮窗；继续打字则浮窗自动消失，下一次停笔再出候选。
            </p>
            <PracticeEditor practiceKey="p2" text={PRACTICE_TEXT} settings={settings} onTaskEvent={markTask} />
            <p className="onboarding-task">
              {tasks["candidate-accepted"] ? "✓ 已接受一个候选" : "在上面的句子里停笔等候选出现，按数字键接受一个。不做也可以直接「下一步」。"}
            </p>
          </div>
        );
      case 2:
        return (
          <div className="onboarding-copy">
            <p>
              <strong>长按 {hideKeyLabel}</strong> 浮窗暂时淡化，恢复常规交互
            </p>
            <p>
              <strong>长按 {expandKeyLabel}</strong> 候选词依次长成短句，数字键接受整句
            </p>
            <PracticeEditor practiceKey="p3" text={PRACTICE_TEXT} settings={settings} onTaskEvent={markTask} />
            <p className="onboarding-task">
              {tasks["hold-hide"] ? "✓ " : "○ "}
              长按 {hideKeyLabel}，看浮窗淡下去，松开恢复  {tasks["hold-expand"] ? "✓ " : "○ "}
              长按 {expandKeyLabel}，看候选长成短句（不做也可下一步）
            </p>
            <p className="setting-hint">键位可在 设置 → 高级设置 里改，也可以关掉。</p>
          </div>
        );
      case 3:
        return (
          <div className="onboarding-copy">
            <p>开启大纲模式，可以让候选词更贴合你的情节。</p>
            <p>一本书可以分为若干个大纲段，每一段大纲相互独立。</p>
            <p>若文章较长，可以在书内分章，以及在章节外分卷（需要将作品转换为长篇）。</p>
            <PracticeEditor practiceKey="p4" text={PRACTICE_CHAPTER} settings={settings} onTaskEvent={markTask} />
            <p className="onboarding-task">
              {tasks["outline-segment"]
                ? "✓ 已新起一个大纲段（看状态栏的「段 i/n」变了）"
                : "把光标点进第二个正文段，右键 → 「从这里新起大纲段」。不做也可以直接「下一步」。"}
            </p>
          </div>
        );
      case 4:
        return (
          <div className="onboarding-copy">
            <p>
              软件可以自动识别并标注错别字、语病、专名前后不一致（如「莱奥拉 / 莱奥菈」）、重复片段、表述过于单调等小瑕疵。
            </p>
            <div className="onboarding-legend">
              <span>
                语法问题 <em className="onboarding-squiggle">～～～～</em>（波浪线）
              </span>
              <span>
                单调开头 <em className="onboarding-monotone">██████</em>（深色底）
              </span>
            </div>
            <p>自动纠错提示可以在设置关闭。</p>
          </div>
        );
      case 5:
        return (
          <div className="onboarding-copy">
            <p>人物卡：背景 / 性格 / 外观，可加自定义字段。</p>
            <p>设定条：地点 / 组织 / 物品。</p>
            <div className="onboarding-card-mock" aria-hidden="true">
              <strong>陆青梧</strong>
              <span>别名：阿梧</span>
              <p>背景：雾溪镇新来的教书先生……</p>
            </div>
            <p>软件会自动识别已设定的人物，在写作时方便查阅。</p>
          </div>
        );
      case 6:
        return (
          <div className="onboarding-copy">
            <PresetCards values={settings} onApply={(name) => applyPreset(name, settings, onSettingsChange)} />
            <p className="setting-hint">之后随时可在设置里逐项改；不选就保持当前设置。</p>
          </div>
        );
      case 7:
        return (
          <div className="onboarding-copy">
            <p>现在建第一篇文稿，或者打开已有的书。</p>
            <p>忘了什么不要紧：设置 → 基本 → 重看新手引导。</p>
            <div className="onboarding-final-actions">
              <button type="button" className="setup-primary-button" onClick={() => onFinish("create")}>
                新建文稿并开始写作
              </button>
              <button type="button" className="setup-secondary-button" onClick={() => onFinish("close")}>
                先逛逛文库
              </button>
            </div>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="backend-dialog onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header className="backend-dialog-head">
          <div>
            <h2 id="onboarding-title">{titles[page]}</h2>
            <p className="setup-section-subtitle">
              {page + 1} / {PAGE_COUNT}
            </p>
          </div>
          <button type="button" className="quiet-button" onClick={() => onFinish("close")}>
            跳过引导
          </button>
        </header>

        <div className="onboarding-body">{renderBody()}</div>

        <footer className="setup-actions backend-dialog-actions">
          {page > 0 && page < PAGE_COUNT - 1 && (
            <button type="button" className="setup-secondary-button" onClick={() => setPage(page - 1)}>
              ← 上一步
            </button>
          )}
          <div className="onboarding-dots" aria-hidden="true">
            {Array.from({ length: PAGE_COUNT }, (_, index) => (
              <span key={index} className={index === page ? "is-current" : ""} />
            ))}
          </div>
          {page < PAGE_COUNT - 1 ? (
            <button type="button" className="setup-primary-button" onClick={() => setPage(page + 1)}>
              {page === 0 ? "开始 →" : "下一步 →"}
            </button>
          ) : (
            <button type="button" className="setup-secondary-button" onClick={() => setPage(page - 1)}>
              ← 上一步
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
