import { useState, type CSSProperties } from "react";
import { ICONS, type IconName } from "./icons";

export function Icon({ name, size = 16, stroke = 1.8, label, style }: { name: IconName; size?: number; stroke?: number; label?: string; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon"
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

/** Đỉnh bát giác đều (góc bắt đầu 22.5°) — dùng chung cho Oct và graph. */
export function octPoints(cx: number, cy: number, r: number) {
  const pts: string[] = [];
  for (let k = 0; k < 8; k++) {
    const a = ((22.5 + 45 * k) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/**
 * Bát giác đều vẽ bằng SVG có kích thước cố định — không bao giờ bị flex kéo méo
 * (khác với clip-path trên phần tử co giãn).
 */
export function Oct({ size, color, children, className, label }: { size: number; color: string; children?: React.ReactNode; className?: string; label?: string }) {
  const r = size / 2 / Math.cos(Math.PI / 8); // bán kính đỉnh để cạnh phẳng chạm khung
  return (
    <span
      className={className ? `oct ${className}` : "oct"}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <polygon points={octPoints(size / 2, size / 2, Math.min(r, size / 2 / Math.cos(Math.PI / 8)))} fill={color} transform={`rotate(0 ${size / 2} ${size / 2})`} />
      </svg>
      {children !== undefined && <span className="oct-content">{children}</span>}
    </span>
  );
}

const AVATAR_COLORS = ["#0284C7", "#7C3AED", "#B45309", "#047857", "#BE185D", "#0E7490"];

export function Avatar({ login, url, size = 22 }: { login: string; url?: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const color = AVATAR_COLORS[[...login].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % AVATAR_COLORS.length];
  // Ảnh thật: không tô nền — ảnh hiếm khi là bát giác nên nền màu lộ ra quanh ảnh trong suốt sẽ rất chướng.
  const showImg = !!url && failed !== url;
  return (
    <Oct size={size} color={showImg ? "transparent" : color}>
      {showImg ? (
        <img
          src={`${url}${url.includes("?") ? "&" : "?"}s=${size * 2}`}
          width={size}
          height={size}
          alt=""
          className="oct-img"
          draggable={false}
          onError={() => setFailed(url)}
        />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.48), fontWeight: 700, color: "#fff" }}>{login.slice(0, 1).toUpperCase()}</span>
      )}
    </Oct>
  );
}
