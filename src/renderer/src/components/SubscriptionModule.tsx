import { useEffect, useState } from "react";

import paymentPlaceholder from "../../../../resources/sponsor-payment-placeholder.svg";
import { Icon } from "./Icon";

type SubscriptionPlan = "free" | "plus" | "pro" | "pro20x";
type ModalPage = "plans" | "payment";
type Variant = "library" | "editor";

const STORAGE_KEY = "pickword-subscription-plan-v1";
// 可选的私有付款码：放在项目根目录 resources/sponsor-payment-code.png；未提供时回退到通用 SVG 占位图。
const localPaymentImages = import.meta.glob("../../../../resources/sponsor-payment-code.png", {
  eager: true,
  import: "default",
  query: "?url",
});
const localPaymentImage = Object.values(localPaymentImages)[0] as string | undefined;

const PLANS: Array<{
  id: SubscriptionPlan;
  name: string;
  price: string;
  compute: string;
}> = [
  { id: "free", name: "Free", price: "¥0", compute: "无限制" },
  { id: "plus", name: "Plus", price: "¥20", compute: "无限制" },
  { id: "pro", name: "Pro", price: "¥100", compute: "无限制 × 5" },
  { id: "pro20x", name: "Pro 20x", price: "¥200", compute: "无限制 × 20" },
];

function readPlan(): SubscriptionPlan {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return PLANS.some((plan) => plan.id === stored) ? (stored as SubscriptionPlan) : "free";
  } catch {
    return "free";
  }
}

function savePlan(plan: SubscriptionPlan): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, plan);
  } catch {
    // 会员状态是装饰，不值得让存储权限错误打断付款页面。
  }
}

export function SubscriptionModule({ variant }: { variant: Variant }) {
  const [plan, setPlan] = useState<SubscriptionPlan>(readPlan);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ModalPage>("plans");
  const [pendingPlan, setPendingPlan] = useState<SubscriptionPlan | null>(null);
  const [paymentImage, setPaymentImage] = useState(localPaymentImage ?? paymentPlaceholder);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function showPlans() {
    setPage("plans");
    setPendingPlan(null);
    setOpen(true);
  }

  function choosePlan(nextPlan: SubscriptionPlan) {
    if (nextPlan === "free") {
      setPlan("free");
      savePlan("free");
      setOpen(false);
      return;
    }
    setPendingPlan(nextPlan);
    setPage("payment");
  }

  function confirmPayment() {
    if (!pendingPlan) return;
    // 没有支付验证，也没有网络请求：只记录用户在付款页选了什么。
    savePlan(pendingPlan);
    setPlan(pendingPlan);
    setPendingPlan(null);
    setOpen(false);
    setPage("plans");
  }

  const currentPlan = PLANS.find((item) => item.id === plan) ?? PLANS[0];
  const selectedPlan = PLANS.find((item) => item.id === pendingPlan);

  return (
    <>
      <button
        className={`subscription-entry subscription-entry-${variant} ${variant === "library" ? "library-top-action" : "icon-button tool-button"}`}
        type="button"
        title={`当前方案：${currentPlan.name}。点击查看订阅方案。`}
        aria-label={`当前方案 ${currentPlan.name}，打开订阅方案`}
        data-plan={plan}
        onClick={showPlans}
      >
        <Icon name="sparkle" size={16} />
        <span>订阅</span>
        <span className="subscription-entry-plan">{currentPlan.name}</span>
      </button>

      {open && (
        <div
          className="modal-backdrop subscription-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className="subscription-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="subscription-title"
          >
            <header className="subscription-dialog-head">
              <div>
                <span className="subscription-eyebrow">本地套餐</span>
                <h2 id="subscription-title">{page === "plans" ? "升级你的套餐" : "完成订阅"}</h2>
                {page === "payment" && <p>{selectedPlan?.name} · {selectedPlan?.price}</p>}
              </div>
              <button
                className="icon-button subscription-close"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭订阅窗口"
              >
                <Icon name="close" size={18} />
              </button>
            </header>

            {page === "plans" ? (
              <>
                <div className="subscription-plans">
                  {PLANS.map((item) => {
                    const isCurrent = item.id === plan;
                    return (
                      <article className={`subscription-plan-card ${isCurrent ? "is-current" : ""}`} data-plan={item.id} key={item.id}>
                        <div className="subscription-plan-title">
                          <h3>{item.name}</h3>
                          {isCurrent && <span>当前方案</span>}
                        </div>
                        <p className="subscription-price">{item.price}</p>
                        <ul>
                          <li><span>本地算力</span><strong>{item.compute}</strong></li>
                          <li><span>候选</span><strong>✓</strong></li>
                          <li><span>展开</span><strong>✓</strong></li>
                          <li><span>纠错</span><strong>✓</strong></li>
                          <li><span>文字离机</span><strong>从不</strong></li>
                          <li><span>更新速度</span><strong>同所有人</strong></li>
                        </ul>
                        {isCurrent ? (
                          <button className="subscription-plan-button is-current-button" type="button" disabled>
                            当前方案
                          </button>
                        ) : item.id === "free" ? (
                          <button className="subscription-plan-button" type="button" onClick={() => choosePlan("free")}>
                            切回 Free
                          </button>
                        ) : (
                          <button className="subscription-plan-button" type="button" onClick={() => choosePlan(item.id)}>
                            订阅
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
                <p className="subscription-plan-footnote">
                  * 所有方案都包含全部功能。订阅款会被用于专项辅助模型的训练。
                </p>
              </>
            ) : (
              <div className="subscription-payment-page">
                <div className="subscription-qr-frame">
                  <img
                    src={paymentImage}
                    alt="付款码"
                    onError={() => {
                      if (paymentImage !== paymentPlaceholder) setPaymentImage(paymentPlaceholder);
                    }}
                  />
                </div>
                <div className="subscription-payment-copy">
                  <p className="subscription-payment-dry">无限的任意倍仍然是无限。</p>
                  <p className="subscription-payment-warning">请在付款前确认这一数学事实。</p>
                </div>
                <div className="subscription-payment-actions">
                  <button className="setup-secondary-button" type="button" onClick={() => setPage("plans")}>
                    返回套餐
                  </button>
                  <button className="setup-primary-button" type="button" onClick={confirmPayment}>
                    确认付款
                  </button>
                </div>
                <p className="subscription-payment-footnote">单击确认便可获得会员标识</p>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
