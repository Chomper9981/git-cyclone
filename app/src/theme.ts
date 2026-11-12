import type { Settings } from "./types";

/** Áp dụng theme ngay (đặt data-theme trên <html>) và nhớ cho lần mở sau (index.html đọc gc-theme). */
export function applyTheme(theme: Settings["theme"]) {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem("gc-theme", theme);
  } catch {
    /* bỏ qua */
  }
}
