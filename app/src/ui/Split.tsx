import { useRef, useState } from "react";

/** Chia 2 vùng có thanh kéo. Kích thước vùng đầu được nhớ theo `id`. */
export function Split({
  id,
  dir,
  initial,
  min = 120,
  children,
}: {
  id: string;
  dir: "row" | "col";
  initial: number;
  min?: number;
  children: [React.ReactNode, React.ReactNode];
}) {
  const key = `split:${id}`;
  const [size, setSize] = useState<number>(() => Number(localStorage.getItem(key)) || initial);
  const box = useRef<HTMLDivElement>(null);

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const total = dir === "row" ? rect.width : rect.height;
      const pos = dir === "row" ? ev.clientX - rect.left : ev.clientY - rect.top;
      const next = Math.max(min, Math.min(total - min, pos));
      setSize(next);
      localStorage.setItem(key, String(Math.round(next)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
    };
    document.body.classList.add("dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const back = dir === "row" ? "ArrowLeft" : "ArrowUp";
    const fwd = dir === "row" ? "ArrowRight" : "ArrowDown";
    if (e.key === back || e.key === fwd) {
      e.preventDefault();
      const next = Math.max(min, size + (e.key === fwd ? step : -step));
      setSize(next);
      localStorage.setItem(key, String(next));
    }
  };

  return (
    <div ref={box} className={`split split-${dir}`}>
      <div className="split-a" style={dir === "row" ? { width: size } : { height: size }}>
        {children[0]}
      </div>
      <div
        className="split-bar"
        role="separator"
        aria-orientation={dir === "row" ? "vertical" : "horizontal"}
        tabIndex={0}
        onPointerDown={onDown}
        onKeyDown={onKey}
      />
      <div className="split-b">{children[1]}</div>
    </div>
  );
}
