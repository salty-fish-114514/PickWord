import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "./Icon";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** true = 在此项之前画一条分隔线。 */
  separator?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * 编辑器右键菜单（自绘，替代 Electron 默认的空白菜单）。
 * 定位在鼠标处，越界时向左 / 向上翻转；点击外部、Esc、滚动、窗口失焦都会关闭。
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    let left = x;
    let top = y;
    if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, x - rect.width);
    if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, y - rect.height);
    setPosition({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // 用 portal 挂到 .app-root 下（而不是触发它的侧栏里）：侧栏入场动画 fill-mode both 会留下 transform，
  // 让 fixed 定位的菜单以侧栏为包含块、被 overflow 裁掉。挂在 .app-root 而非 body 是为了保住主题令牌与 --ui-scale。
  const host = document.querySelector<HTMLElement>(".app-root") ?? document.body;
  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id} className={item.separator ? "context-menu-group" : undefined}>
          <button
            className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onPointerDown={(event) => event.preventDefault()} // 不让 textarea 失焦
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="context-menu-icon">{item.icon ? <Icon name={item.icon} size={15} /> : null}</span>
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>,
    host,
  );
}
