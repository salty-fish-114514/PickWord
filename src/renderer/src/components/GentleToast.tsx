interface GentleToastProps {
  message: string;
  onPrimary: () => void;
  onDismiss: () => void;
}

/**
 * 底部居中的轻量提示条（Toast）。
 *
 * 关键点：它**不是** modal。
 *   - 不覆盖编辑区、不抢焦点（按钮都 preventDefault 了 mousedown）；
 *   - 作者可以完全无视它继续打字；
 *   - 只在 EOS 连续命中达到阈值时出现一次。
 */
export function GentleToast({ message, onPrimary, onDismiss }: GentleToastProps) {
  return (
    <div className="gentle-toast" role="status" aria-live="polite">
      <span className="toast-text">{message}</span>
      <div className="toast-actions">
        <button
          className="toast-button toast-primary"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onPrimary}
        >
          更新大纲
        </button>
        <button
          className="toast-button"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onDismiss}
        >
          忽略
        </button>
      </div>
    </div>
  );
}
