import { useState } from "react";

import { Icon } from "./Icon";
import type { LibraryDirectory } from "../lib/types";
import {
  HOLD_KEY_LABEL,
  SAMPLE_KEY_LABEL,
  isHoldKey,
  SETTING_LIMITS,
  applyPreset,
  detectPreset,
  formatSeconds,
  type HoldKey,
  type SettingsValues,
} from "../lib/settings";
import { PresetCards } from "./PresetCards";

/** 百分比显示的设置项（内部存 0~1）：把范围也换算成百分比。 */
function percentLimits(key: "eosMinProb" | "fadeOpacity") {
  const { min, max } = SETTING_LIMITS[key];
  return { min: Math.round(min * 100), max: Math.round(max * 100), step: 1 };
}

/** 一个通用的滑杆设置项，避免复制粘贴十几遍相同的 JSX。 */
function RangeSetting({
  id,
  label,
  value,
  min,
  max,
  step,
  unit,
  minLabel,
  maxLabel,
  hint,
  format,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  minLabel: string;
  maxLabel: string;
  hint?: string;
  /** 自定义数值显示（比如 3000 → "3 秒"）。 */
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="setting-block">
      <div className="setting-label-row">
        <label htmlFor={id}>{label}</label>
        <output>{format ? format(value) : `${value} ${unit}`}</output>
      </div>
      <input
        id={id}
        className="range-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="range-ends">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      {hint && <p className="setting-hint">{hint}</p>}
    </div>
  );
}

/** 原生 <select> 的薄包装：只用于键位选择，零第三方依赖。 */
function SelectSetting<T extends string>({
  id,
  label,
  value,
  options,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: Record<T, string>;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="setting-block">
      <div className="setting-label-row">
        <label htmlFor={id}>{label}</label>
      </div>
      <select id={id} className="select-field" value={value} onChange={(event) => onChange(event.target.value)}>
        {(Object.keys(options) as T[]).map((key) => (
          <option key={key} value={key}>
            {options[key]}
          </option>
        ))}
      </select>
      {hint && <p className="setting-hint">{hint}</p>}
    </div>
  );
}

/** 写作节奏预设：一键把六项自动参数拨到一套选好的默认值；单项另改过就显示「自定义」。 */
function PresetSetting({
  values,
  detectedSlots,
  onChange,
  onOpenBackendSettings,
}: {
  values: SettingsValues;
  detectedSlots: number | null;
  onChange: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  onOpenBackendSettings?: () => void;
}) {
  const current = detectPreset(values);
  const needSlots = detectedSlots !== null && detectedSlots < 2;
  return (
    <div className="setting-block theme-block">
      <span className="setting-title">写作节奏{current === "custom" ? "（自定义）" : ""}</span>
      <PresetCards values={values} onApply={(name) => applyPreset(name, values, onChange)} />
      <p className="setting-hint">
        {current === "custom" ? "下面的自动项已单独改过；点一张卡可整体恢复。" : "随时可以在下面逐项调整；调过任何一项即变为「自定义」。"}{" "}
        槽 0 出候选和展开，槽 1 纠错；这些自动项也可以在下面和「纠错」页单独开关。
      </p>
      {needSlots && (
        <p className="setting-hint is-warning">
          本地模型目前只有 {detectedSlots} 个槽位，自动纠错用不上（它会和候选抢上下文缓存）。到「模型与推理」把「并行槽位」设为 2 即可启用。
          {onOpenBackendSettings && (
            <>
              {" "}
              <button className="link-button" type="button" onClick={onOpenBackendSettings}>
                打开模型与推理
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** 「标题 + 说明 + 开关」一行，快速模式 / 浮窗常驻共用。 */
function SwitchSetting({
  title,
  description,
  checked,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="setting-block quick-mode-block">
      <div className="quick-mode-copy">
        <span className="setting-title">{title}</span>
        <p>{description}</p>
      </div>
      <button
        className={`switch ${checked ? "is-on" : ""}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={onToggle}
      >
        <span />
      </button>
    </div>
  );
}

interface SettingsPanelProps {
  values: SettingsValues;
  directory: LibraryDirectory;
  isDemoLibrary: boolean;
  directoryBusy: boolean;
  onChooseDirectory: () => void;
  onResetDirectory: () => void;
  onChange: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  onResetAdvanced: () => void;
  onClose: () => void;
  /** 打开「模型与推理」面板（换模型 / 引擎 / 设备 / 启动参数）。演示模式没有。 */
  onOpenBackendSettings?: () => void;
  /** 后端实际生效的上下文长度（来自 ModelProfile）；有值时滑杆只作兜底。 */
  detectedContextLen?: number | null;
  /** 后端实际的并行槽位数；自动纠错需要 2 个。 */
  detectedSlots?: number | null;
  /** 当前应用版本（基本页「关于与更新」显示用）；浏览器演示里拿不到。 */
  appVersion?: string | null;
  /** 检查更新 / 下载进行中：按钮转「正在检查…」并禁用。 */
  updateBusy?: boolean;
  /** 手动检查更新：结果永远弹 UpdateDialog（含「已是最新」）。 */
  onCheckUpdate?: () => void;
  /** 重看新手引导（App 重新弹 OnboardingFlow）。 */
  onReplayOnboarding?: () => void;
}

/**
 * 设置面板：两页。
 *   基本页：作家一眼能懂的几项；底部有一个「高级设置」入口。
 *   高级页：模型上下文、窗口、概率软化、EOS 提醒、浮窗淡化、键位 —— 圈外作家不需要碰。
 */
export function SettingsPanel({
  values,
  directory,
  isDemoLibrary,
  directoryBusy,
  onChooseDirectory,
  onResetDirectory,
  onChange,
  onResetAdvanced,
  onClose,
  onOpenBackendSettings,
  detectedContextLen,
  detectedSlots = null,
  appVersion = null,
  updateBusy = false,
  onCheckUpdate,
  onReplayOnboarding,
}: SettingsPanelProps) {
  const [page, setPage] = useState<"basic" | "advanced">("basic");

  return (
    <aside className="side-panel settings-panel" aria-label="编辑设置">
      <div className="panel-heading">
        <div>
          <span className="panel-eyebrow">{page === "basic" ? "写作偏好" : "高级设置"}</span>
          <h2>{page === "basic" ? "编辑设置" : "参数与键位"}</h2>
        </div>
        <button className="icon-button panel-close" type="button" onClick={onClose} aria-label="关闭设置面板">
          <Icon name="close" />
        </button>
      </div>

      {page === "basic" ? (
        <>
          <div className="setting-block library-folder-setting">
            <span className="setting-title">文稿保存文件夹</span>
            <div className="library-folder-path" title={directory.path}>
              <Icon name="folder" size={17} />
              <span>{directory.path}</span>
            </div>
            <div className="library-folder-actions">
              <button className="quiet-button quiet-button-accent" type="button" disabled={directoryBusy} onClick={onChooseDirectory}>
                {directoryBusy ? "正在处理…" : "选择文件夹"}
              </button>
              {!directory.isDefault && (
                <button className="quiet-button" type="button" disabled={directoryBusy} onClick={onResetDirectory}>
                  恢复默认
                </button>
              )}
            </div>
            <p className="setting-hint">
              {isDemoLibrary
                ? "演示模式仅保存到浏览器本地，选中的文件夹只作界面预览；接入主进程后才会写入真实目录。"
                : "所有文稿以 TXT 保存，风格、大纲和锚点存在同名 .writer.json 中。切换目录时应先安全迁移现有文稿。"}
            </p>
          </div>
          <RangeSetting
            id="candidate-count"
            label="每页候选数"
            value={values.candidateCount}
            {...SETTING_LIMITS.candidateCount}
            unit="个"
            minLabel="3 个"
            maxLabel="10 个"
            hint="后端固定返回 100 个候选，用 PageUp / PageDown 翻页查看低频词。"
            onChange={(value) => onChange("candidateCount", value)}
          />
          <RangeSetting
            id="trigger-delay"
            label="停笔多久后出候选"
            value={values.triggerDelay}
            {...SETTING_LIMITS.triggerDelay}
            unit="秒"
            minLabel="0.2 秒"
            maxLabel="10 秒"
            format={formatSeconds}
            hint="快速模式开启时此项不生效：浮层常驻且零延迟。"
            onChange={(value) => onChange("triggerDelay", value)}
          />
          <RangeSetting
            id="auto-save-interval"
            label="自动保存周期"
            value={values.autoSaveInterval}
            {...SETTING_LIMITS.autoSaveInterval}
            unit="秒"
            minLabel="1 秒"
            maxLabel="30 秒"
            format={(value) => `${Math.round(value / 1000)} 秒`}
            hint="顶部开关控制是否启用自动保存；随时可按保存按钮或 Ctrl+S 手动保存。"
            onChange={(value) => onChange("autoSaveInterval", value)}
          />
          <RangeSetting
            id="font-size"
            label="正文字号"
            value={values.fontSize}
            {...SETTING_LIMITS.fontSize}
            unit="像素"
            minLabel="16 像素"
            maxLabel="22 像素"
            onChange={(value) => onChange("fontSize", value)}
          />

          <div className="setting-block theme-block">
            <span className="setting-title">阅读主题</span>
            <div className="theme-options" role="group" aria-label="阅读主题">
              <button
                className={`theme-option ${values.theme === "light" ? "is-selected" : ""}`}
                type="button"
                aria-pressed={values.theme === "light"}
                onClick={() => onChange("theme", "light")}
              >
                <Icon name="sun" size={16} />
                <span>浅色</span>
              </button>
              <button
                className={`theme-option ${values.theme === "dark" ? "is-selected" : ""}`}
                type="button"
                aria-pressed={values.theme === "dark"}
                onClick={() => onChange("theme", "dark")}
              >
                <Icon name="moon" size={16} />
                <span>深色</span>
              </button>
            </div>
          </div>

          <PresetSetting
            values={values}
            detectedSlots={detectedSlots ?? null}
            onChange={onChange}
            onOpenBackendSettings={onOpenBackendSettings}
          />

          <SwitchSetting
            title="快速模式"
            description="浮层常驻、零延迟刷新。长按隐藏键可暂时收起浮层，按住期间所有按键照常进正文。"
            checked={values.quickMode}
            onToggle={() => onChange("quickMode", !values.quickMode)}
          />
          <SwitchSetting
            title="浮窗常驻"
            description="用输入法打字（拼音组字）时浮窗不关闭，只会淡化；打完上屏后自动刷新。关闭则组字时立刻收起。"
            checked={values.keepPopover}
            onToggle={() => onChange("keepPopover", !values.keepPopover)}
          />
          <SwitchSetting
            title="短句展开"
            description="长按展开键，浮窗里的候选依次从词长成短句（流式）；数字键接受整句，流到一半按下就取已显示的部分。也可以停笔自动展开。"
            checked={values.expandEnabled}
            onToggle={() => onChange("expandEnabled", !values.expandEnabled)}
          />
          <SwitchSetting
            title="停笔后自动展开"
            description="候选出现后，停笔达到下面设定的秒数就自动开始展开，不必长按。期间任何按键都会重新计时。"
            checked={values.expandAuto}
            onToggle={() => onChange("expandAuto", !values.expandAuto)}
          />
          {values.expandAuto && (
            <RangeSetting
              id="expand-idle"
              label="停笔多久后开始展开"
              value={values.expandIdleMs}
              {...SETTING_LIMITS.expandIdleMs}
              unit="秒"
              minLabel="0.25 秒（候选一出就展开）"
              maxLabel="60 秒"
              format={formatSeconds}
              hint="调到最小就是「总是自动展开」；每轮展开约 5 次短解码，设得太短时连续写作显卡会一直有活干。"
              onChange={(value) => onChange("expandIdleMs", value)}
            />
          )}

          {onOpenBackendSettings && (
            <div className="setting-block reconfigure-block">
              <span className="setting-title">模型与推理引擎</span>
              <p className="setting-hint">更换模型文件、推理设备、线程数与上下文长度，或重新运行安装向导。</p>
              <button className="quiet-button quiet-button-accent" type="button" onClick={onOpenBackendSettings}>
                打开「模型与推理」
              </button>
              <p className="setting-hint reconfigure-warning">⚠ 应用新配置时模型会重新加载，候选功能会短暂中断。</p>
            </div>
          )}

          {onReplayOnboarding && (
            <div className="setting-block">
              <span className="setting-title">新手引导</span>
              <p className="setting-hint">忘了哪个功能在哪？两分钟重新过一遍。</p>
              <button className="quiet-button" type="button" onClick={onReplayOnboarding}>
                重看新手引导
              </button>
            </div>
          )}

          {onCheckUpdate && (
            <div className="setting-block">
              <span className="setting-title">关于与更新</span>
              <p className="setting-hint">
                当前版本 v{appVersion ?? "演示模式"}。覆盖安装新版本不会动你的设置、文库和已部署的模型。
              </p>
              <button className="quiet-button quiet-button-accent" type="button" disabled={updateBusy} onClick={onCheckUpdate}>
                {updateBusy ? "正在检查…" : "检查更新"}
              </button>
            </div>
          )}

          <button className="advanced-entry" type="button" onClick={() => setPage("advanced")}>
            <span>高级设置</span>
            <span className="advanced-entry-caption">模型上下文 · 窗口 · 概率软化 · 提醒阈值 · 浮窗淡化 · 键位</span>
            <Icon name="chevron" size={16} />
          </button>
        </>
      ) : (
        <>
          <button className="back-link" type="button" onClick={() => setPage("basic")}>
            ← 返回基本设置
          </button>

          <h3 className="settings-group-title">上下文</h3>
          <RangeSetting
            id="model-context-len"
            label="模型上下文长度"
            value={values.modelContextLen}
            {...SETTING_LIMITS.modelContextLen}
            unit="token"
            minLabel="4096"
            maxLabel="131072"
            format={(value) => `${value} token`}
            hint={
              detectedContextLen
                ? `当前模型实际上下文为 ${detectedContextLen} token（已从后端自动读取并采用）；此滑杆只在读不到时作为兜底。`
                : "请与 llama-server 的 -c 参数保持一致。按「1 字 = 1 token」最保守估算：锚点模式的正文 + 风格 + 大纲超过它时，会自动退出锚点模式。"
            }
            onChange={(value) => onChange("modelContextLen", value)}
          />
          <RangeSetting
            id="max-body-len"
            label="正文窗口上限"
            value={values.maxBodyLen}
            {...SETTING_LIMITS.maxBodyLen}
            unit="字"
            minLabel="4000 字"
            maxLabel="20000 字"
            hint="无锚点时滑动窗口自己的正文上限。锚点模式使用独立的上下文硬上限；两种范围互不混用。Qwen 小模型建议 10000~15000。"
            onChange={(value) => onChange("maxBodyLen", value)}
          />
          <RangeSetting
            id="window-advance"
            label="窗口推进步长"
            value={values.windowAdvanceMinChars}
            {...SETTING_LIMITS.windowAdvanceMinChars}
            unit="字"
            minLabel="100 字"
            maxLabel="1000 字"
            hint="超限后至少再写这么多字、并且换行，才丢弃最前面的段落。越大 KV 缓存越稳定。"
            onChange={(value) => onChange("windowAdvanceMinChars", value)}
          />
          <RangeSetting
            id="anchor-warn"
            label="锚点正文过长提醒"
            value={values.anchorWarnLen}
            {...SETTING_LIMITS.anchorWarnLen}
            unit="字"
            minLabel="2000 字"
            maxLabel="10000 字"
            hint="锚点模式不截断、不滑窗；超过这个长度只是提醒，超过硬上限才会退出锚点模式。"
            onChange={(value) => onChange("anchorWarnLen", value)}
          />

          <h3 className="settings-group-title">候选与提醒</h3>
          <RangeSetting
            id="soften-temperature"
            label="概率软化温度"
            value={values.softenTemperature}
            {...SETTING_LIMITS.softenTemperature}
            unit=""
            minLabel="1.0（原始）"
            maxLabel="4.0（最平）"
            format={(value) => value.toFixed(1)}
            hint="越大，低频词的百分比越「好看」。只影响浮窗里显示的百分比，不影响模型输出。"
            onChange={(value) => onChange("softenTemperature", value)}
          />
          <RangeSetting
            id="eos-scan"
            label="终止符扫描范围"
            value={values.eosScanTopN}
            {...SETTING_LIMITS.eosScanTopN}
            unit="个"
            minLabel="前 5 个"
            maxLabel="前 50 个"
            hint="在候选列表的前 N 个里寻找 <|im_end|> 之类的终止符。只在大纲模式下计数。"
            onChange={(value) => onChange("eosScanTopN", value)}
          />
          <RangeSetting
            id="eos-min-prob"
            label="终止符最低概率"
            value={Math.round(values.eosMinProb * 100)}
            {...percentLimits("eosMinProb")}
            unit="%"
            minLabel="0%（只看排名）"
            maxLabel="60%"
            format={(value) => `${value}%`}
            hint="终止符软化后的概率达到这个值才算一次命中。偏低会把模型的随口一提也当成收尾信号。"
            onChange={(value) => onChange("eosMinProb", value / 100)}
          />
          <RangeSetting
            id="eos-threshold"
            label="提醒触发次数"
            value={values.eosThreshold}
            {...SETTING_LIMITS.eosThreshold}
            unit="次"
            minLabel="1 次"
            maxLabel="10 次"
            hint="连续命中终止符达到该次数后，底部弹出一次轻提醒。"
            onChange={(value) => onChange("eosThreshold", value)}
          />
          <RangeSetting
            id="prefill-hint"
            label="重算上下文提示阈值"
            value={values.prefillHintSeconds}
            {...SETTING_LIMITS.prefillHintSeconds}
            unit="秒"
            minLabel="0 秒（总是提示）"
            maxLabel="60 秒"
            hint="大幅移动光标、切换风格或大纲后模型要重新读入上下文；预计耗时超过这个值才在状态栏提示。"
            onChange={(value) => onChange("prefillHintSeconds", value)}
          />

          <h3 className="settings-group-title">浮窗与键位</h3>
          <RangeSetting
            id="fade-opacity"
            label="浮窗淡化透明度"
            value={Math.round(values.fadeOpacity * 100)}
            {...percentLimits("fadeOpacity")}
            unit="%"
            minLabel="5%（几乎隐形）"
            maxLabel="60%"
            format={(value) => `${value}%`}
            hint="长按隐藏浮窗键、以及「浮窗常驻」时用输入法组字，浮窗都会淡化到这个不透明度。"
            onChange={(value) => onChange("fadeOpacity", value / 100)}
          />
          <SelectSetting<HoldKey>
            id="hide-key"
            label="隐藏浮窗键（长按生效）"
            value={values.hideKey}
            options={HOLD_KEY_LABEL}
            hint="按住它浮窗淡出（用下面「浮窗淡化透明度」的不透明度，并让出鼠标）、按键全部照常输入正文，松开就恢复。短按就是正常输入这个键（空格照打空格）。"
            onChange={(value) => {
              if (isHoldKey(value)) onChange("hideKey", value);
            }}
          />
          <SelectSetting<HoldKey>
            id="expand-key"
            label="展开短句键（长按生效）"
            value={values.expandKey}
            options={HOLD_KEY_LABEL}
            hint="按住它把当前页的候选逐行展开成短句；短按同样是正常输入这个键。"
            onChange={(value) => {
              if (isHoldKey(value)) onChange("expandKey", value);
            }}
          />
          {values.expandKey === values.hideKey && values.expandKey !== "Off" && (
            <p className="setting-hint is-warning">两个键绑成了同一个：长按只会隐藏浮窗，展开短句改用右键菜单或「停笔后自动展开」。</p>
          )}
          <SelectSetting<HoldKey>
            id="sample-key"
            label="随机取词键"
            value={values.sampleKey}
            options={SAMPLE_KEY_LABEL}
            hint="浮窗打开时按它，按概率从全部候选里随机抽一个插入。默认不绑定；绑到隐藏/展开键上时，长按仍是隐藏/展开，短按变成取词。"
            onChange={(value) => {
              if (isHoldKey(value)) onChange("sampleKey", value);
            }}
          />
          {values.sampleKey !== "Off" && (values.sampleKey === values.hideKey || values.sampleKey === values.expandKey) && (
            <p className="setting-hint is-warning">随机取词与长按键同键：短按=取词（不再输入这个键本身），长按=隐藏/展开。</p>
          )}
          <RangeSetting
            id="hold-ms"
            label="长按判定时长"
            value={values.holdMs}
            {...SETTING_LIMITS.holdMs}
            unit="毫秒"
            minLabel="150 毫秒"
            maxLabel="600 毫秒"
            hint="按住多久算「长按」，隐藏浮窗与展开短句共用。"
            onChange={(value) => onChange("holdMs", value)}
          />

          <button className="quiet-button reset-button" type="button" onClick={onResetAdvanced}>
            恢复高级设置默认值
          </button>
        </>
      )}

      <p className="settings-footnote">
        浮层打开时：1~9 插入 · ↑↓ 选择 · PageUp / PageDown 翻页 · Esc 收起 · 长按隐藏键暂时收起浮窗。Enter 与空格都照常输入，不再被浮层占用。
      </p>
    </aside>
  );
}
