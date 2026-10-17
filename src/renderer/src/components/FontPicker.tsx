/**
 * 顶栏的两个排版控件：「字体」与「字号」。
 *
 * 三点约定：
 *   · 字号就是设置页里那个「正文字号」，这里是同一个值的第二个入口，不另开一份；
 *   · 字号的可选值由 `SETTING_LIMITS.fontSize` 现算（min → max，步长 step），
 *     以后调整范围／步长只改 lib/settings.ts，这里会自动跟上；
 *   · 字体只改编辑器的正文显示（lib/fonts.ts 只读本机字体，不打包字体文件），
 *     界面上其他文字的字体写死，不做联动。
 */

import { useEffect, useState } from "react";

import { Icon } from "./Icon";
import { listLocalCjkFonts } from "../lib/fonts";
import { DEFAULT_SETTINGS, numericOptions } from "../lib/settings";

/** 浮层共用的「点外面收起」；点两个按钮本身由按钮的 onClick 处理，不要在这里抢。 */
function useDismiss(open: boolean, setOpen: (next: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".type-anchor")) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen]);
}

/** 「字体」：默认（衬线栈）+ 本机已安装的中文字体。 */
export function FontPicker({ family, onFamilyChange }: { family: string; onFamilyChange: (family: string) => void }) {
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[] | null>(null);
  useDismiss(open, setOpen);

  /**
   * 检测本机字体。必须在用户手势里调用（onClick 里直接调）：
   * navigator.queryLocalFonts() 要求文档处于「短暂激活」状态，放在 effect 里会晚一拍。
   * 第一次会量上百个候选名字，之后走缓存。
   */
  function detect(force = false) {
    void listLocalCjkFonts(force).then(setFonts);
  }

  const current = family || "默认（宋体）";

  return (
    <div className="type-anchor">
      <button
        className={`icon-button tool-button ${open ? "is-active" : ""}`}
        type="button"
        title={`正文字体：${current}`}
        aria-label="正文字体"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && fonts === null) detect();
        }}
      >
        <Icon name="text" />
        <span>字体</span>
      </button>

      {open && (
        <div className="type-popover" role="dialog" aria-label="正文字体">
          <div className="font-list" role="listbox" aria-label="正文字体">
            <button
              className={`font-option ${family ? "" : "is-selected"}`}
              type="button"
              role="option"
              aria-selected={!family}
              onClick={() => onFamilyChange("")}
            >
              <span className="font-option-name">默认（宋体）</span>
              {!family && <Icon name="check" size={13} />}
            </button>
            {fonts === null && <p className="font-empty">正在读取本机字体……</p>}
            {fonts?.length === 0 && <p className="font-empty">没有检测到其它中文字体，将使用默认字体。</p>}
            {fonts?.map((name) => (
              <button
                key={name}
                className={`font-option ${family === name ? "is-selected" : ""}`}
                type="button"
                role="option"
                aria-selected={family === name}
                title={name}
                onClick={() => onFamilyChange(name)}
              >
                <span className="font-option-name" style={{ fontFamily: `"${name}", serif` }}>
                  {name}
                </span>
                {family === name && <Icon name="check" size={13} />}
              </button>
            ))}
          </div>
          <p className="font-hint">
            <span className="font-count">{fonts === null ? "正在检测……" : `检测到 ${fonts.length} 款中文字体`}</span>
            <button
              className="link-button"
              type="button"
              onClick={() => {
                setFonts(null);
                detect(true);
              }}
            >
              重新检测
            </button>
          </p>
          <p className="font-hint is-plain">只读本机字体；不影响导出的文本，也不会写进文稿。</p>
        </div>
      )}
    </div>
  );
}

/** 「字号」：与设置页「正文字号」同一个值，选项按 SETTING_LIMITS 现算。 */
export function FontSizePicker({ fontSize, onFontSizeChange }: { fontSize: number; onFontSizeChange: (size: number) => void }) {
  const [open, setOpen] = useState(false);
  useDismiss(open, setOpen);

  const options = numericOptions("fontSize", fontSize);

  return (
    <div className="type-anchor">
      <button
        className={`icon-button tool-button ${open ? "is-active" : ""}`}
        type="button"
        title={`正文字号：${fontSize} 像素（与设置页的「正文字号」是同一个值）`}
        aria-label="正文字号"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="textSize" />
        <span>字号 {fontSize}</span>
      </button>

      {open && (
        <div className="type-popover is-narrow" role="dialog" aria-label="正文字号">
          <div className="font-list" role="listbox" aria-label="正文字号">
            {options.map((value) => (
              <button
                key={value}
                className={`font-option ${value === fontSize ? "is-selected" : ""}`}
                type="button"
                role="option"
                aria-selected={value === fontSize}
                onClick={() => onFontSizeChange(value)}
              >
                <span className="font-option-name">
                  {value} 像素
                  {value === DEFAULT_SETTINGS.fontSize && <span className="font-option-tag">默认</span>}
                </span>
                {value === fontSize && <Icon name="check" size={13} />}
              </button>
            ))}
          </div>
          <p className="font-hint">与「设置 → 正文字号」同一个值；只影响正文显示。</p>
        </div>
      )}
    </div>
  );
}
