import { useState } from "react";

import { Icon } from "./Icon";
import type { LibraryDirectory } from "../lib/types";
import {
  isPeekKey,
  isSampleKey,
  PEEK_KEY_LABEL,
  SAMPLE_KEY_LABEL,
  type PeekKey,
  type SampleKey,
  type SettingsValues,
} from "../lib/settings";

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
  /** 引导用户回到配置页重新设置模型和推理引擎 */
  onReconfigureModel?: () => void;
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
  onReconfigureModel,
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
            min={3}
            max={10}
            step={1}
            unit="个"
            minLabel="3 个"
            maxLabel="10 个"
            hint="后端固定返回 100 个候选，用 PageUp / PageDown 翻页查看低频词。"
            onChange={(value) => onChange("candidateCount", value)}
          />
          <RangeSetting
            id="trigger-delay"
            label="触发延迟"
            value={values.triggerDelay}
            min={200}
            max={1000}
            step={50}
            unit="毫秒"
            minLabel="200 毫秒"
            maxLabel="1000 毫秒"
            hint="快速模式开启时此项不生效：浮层常驻且零延迟。"
            onChange={(value) => onChange("triggerDelay", value)}
          />
          <RangeSetting
            id="auto-save-interval"
            label="自动保存周期"
            value={values.autoSaveInterval}
            min={1000}
            max={30000}
            step={1000}
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
            min={16}
            max={22}
            step={1}
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

          <SwitchSetting
            title="快速模式"
            description="浮层常驻、零延迟刷新。长按穿透键可暂时淡出浮层并正常输入数字、回车、空格。"
            checked={values.quickMode}
            onToggle={() => onChange("quickMode", !values.quickMode)}
          />
          <SwitchSetting
            title="浮窗常驻"
            description="用输入法打字（拼音组字）时浮窗不关闭，只会淡化；打完上屏后自动刷新。关闭则组字时立刻收起。"
            checked={values.keepPopover}
            onToggle={() => onChange("keepPopover", !values.keepPopover)}
          />

          {/* 模型配置区：放在高级设置上方，因为这是常用操作 */}
          {onReconfigureModel && (
            <div className="setting-block reconfigure-block">
              <span className="setting-title">模型与推理引擎</span>
              <p className="setting-hint">
                更换模型文件、切换 GPU 后端（CUDA / ROCm / Vulkan）或调整推理参数。
              </p>
              <button
                className="quiet-button quiet-button-accent"
                type="button"
                onClick={onReconfigureModel}
              >
                重新配置模型
              </button>
              <p className="setting-hint reconfigure-warning">
                ⚠ 修改配置后模型会自动重新加载，写作中的候选功能会短暂中断。
              </p>
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
            min={4096}
            max={131072}
            step={2048}
            unit="token"
            minLabel="4096"
            maxLabel="131072"
            format={(value) => `${value} token`}
            hint="请与 llama-server 的 -c 参数保持一致。按「1 字 = 1 token」最保守估算：锚点模式的正文 + 风格 + 大纲超过它时，会自动退出锚点模式。"
            onChange={(value) => onChange("modelContextLen", value)}
          />
          <RangeSetting
            id="max-body-len"
            label="正文窗口上限"
            value={values.maxBodyLen}
            min={4000}
            max={20000}
            step={1000}
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
            min={100}
            max={1000}
            step={50}
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
            min={2000}
            max={10000}
            step={500}
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
            min={1}
            max={4}
            step={0.1}
            unit=""
            minLabel="1.0（原始）"
            maxLabel="4.0（最平）"
            format={(value) => value.toFixed(1)}
            hint="越大，低频词的百分比越「好看」。只影响展示与随机取词，不影响模型。"
            onChange={(value) => onChange("softenTemperature", value)}
          />
          <RangeSetting
            id="eos-scan"
            label="终止符扫描范围"
            value={values.eosScanTopN}
            min={5}
            max={50}
            step={5}
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
            min={0}
            max={60}
            step={1}
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
            min={1}
            max={10}
            step={1}
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
            min={0}
            max={60}
            step={1}
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
            min={5}
            max={60}
            step={1}
            unit="%"
            minLabel="5%（几乎隐形）"
            maxLabel="60%"
            format={(value) => `${value}%`}
            hint="长按穿透键、以及「浮窗常驻」时输入法组字，浮窗会淡化到这个不透明度。"
            onChange={(value) => onChange("fadeOpacity", value / 100)}
          />
          <SelectSetting<PeekKey>
            id="peek-key"
            label="穿透键（长按淡出浮层）"
            value={values.peekKey}
            options={PEEK_KEY_LABEL}
            hint="长按它时浮层淡化，数字、回车、空格原样输入。选 Tab 时，短按 Tab 仍是普通的制表符输入。"
            onChange={(value) => {
              if (isPeekKey(value)) onChange("peekKey", value);
            }}
          />
          <RangeSetting
            id="peek-hold"
            label="长按判定时长"
            value={values.peekHoldMs}
            min={150}
            max={600}
            step={10}
            unit="毫秒"
            minLabel="150 毫秒"
            maxLabel="600 毫秒"
            onChange={(value) => onChange("peekHoldMs", value)}
          />
          <SelectSetting<SampleKey>
            id="sample-key"
            label="随机取词键"
            value={values.sampleKey}
            options={SAMPLE_KEY_LABEL}
            hint="浮层打开时按它，按概率随机抽一个候选插入。设为「关闭」即可把空格让出来。"
            onChange={(value) => {
              if (isSampleKey(value)) onChange("sampleKey", value);
            }}
          />

          <button className="quiet-button reset-button" type="button" onClick={onResetAdvanced}>
            恢复高级设置默认值
          </button>
        </>
      )}

      <p className="settings-footnote">
        浮层打开时：↑↓ 选择 · Enter 插入 · 1~9 直接插入 · PageUp / PageDown 翻页 · Esc 收起。
      </p>
    </aside>
  );
}
