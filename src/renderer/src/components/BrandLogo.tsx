/**
 * PickWord 的品牌标志。
 *
 * ★ 换成你自己的标志：把图片放到 public/brand/pickword-logo.png（或改下面的 LOGO_SRC），
 *   建议正方形、至少 128×128、透明背景的 PNG / SVG。首页与编辑器顶栏都用这一个组件，
 *   所以只需替换一处。目前 public/brand/pickword-logo.png 是一张空白占位图。
 *
 * 图片加载失败（文件还没放进去 / 路径写错）时自动退回文字标志，不会出现破图图标。
 */

import { useState } from "react";

export const LOGO_SRC = "/brand/pickword-logo.png";

interface BrandLogoProps {
  /** 像素尺寸（正方形）。 */
  size?: number;
}

export function BrandLogo({ size = 34 }: BrandLogoProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className="brand-logo brand-logo-fallback" style={{ width: size, height: size }} aria-hidden="true">
        P
      </span>
    );
  }

  return (
    <img
      className="brand-logo"
      src={LOGO_SRC}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
