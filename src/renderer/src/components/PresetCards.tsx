/**
 * 写作节奏预设卡片：设置「基本」页与新手引导第 7 页共用同一份组件。
 *
 * 预设 = 一组选好的默认值（WRITING_PRESETS），点卡片逐项写入 onChange；
 * 之后每一项仍可在下面单独调，调过任何一项 detectPreset 就返回「自定义」。
 * 机制与原「算力档位」一致：应用补丁 + 从当前值反推，不存预设名字。
 */
import { PRESET_LABEL, detectPreset, type PresetKey, type PresetName, type SettingsValues } from "../lib/settings";

/** 卡片上的功能陈述（冷静、直白；数值与 WRITING_PRESETS 保持一致）。 */
const PRESET_COPY: Record<PresetName, { rows: string[]; desc: string }> = {
  quiet: {
    rows: ["停笔 8 秒才出候选", "停笔 30 秒自动展开", "不自动纠错", "浮窗用完即走"],
    desc: "触发间隔长，多数时间不打扰写作，显卡负载低。",
  },
  engaged: {
    rows: ["停笔 0.2 秒就出候选", "候选一出就展开", "停笔自动纠错", "浮窗常驻"],
    desc: "停笔即出候选并自动展开，纠错常开，显卡持续有推理任务。",
  },
};

export function PresetCards({
  values,
  onApply,
}: {
  values: Pick<SettingsValues, PresetKey>;
  /** 点卡片：把这套预设的每一项写进设置（调用方逐项 onChange，保持既有落盘路径）。 */
  onApply: (name: PresetName) => void;
}) {
  const current = detectPreset(values);
  return (
    <div className="preset-cards" role="group" aria-label="写作节奏预设">
      {(["quiet", "engaged"] as const).map((name) => {
        const selected = current === name;
        return (
          <div
            key={name}
            className={`preset-card ${selected ? "is-selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            onClick={() => onApply(name)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onApply(name);
              }
            }}
          >
            <span className="preset-card-name">
              {PRESET_LABEL[name]}
              {selected && <em className="preset-card-current">已选</em>}
            </span>
            <ul className="preset-card-rows">
              {PRESET_COPY[name].rows.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ul>
            <p className="preset-card-desc">{PRESET_COPY[name].desc}</p>
            <span className="preset-card-action">{selected ? "当前设置" : "选这个"}</span>
          </div>
        );
      })}
    </div>
  );
}
