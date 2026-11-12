import { createStore } from "../ui/createStore";
import en, { type Dict } from "./en";
import vi from "./vi";

export type Lang = "en" | "vi";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "vi", label: "Tiếng Việt" },
];

const dicts: Record<Lang, Dict> = { en, vi };

function initial(): Lang {
  try {
    const v = localStorage.getItem("gc-lang");
    if (v === "en" || v === "vi") return v;
  } catch {
    /* localStorage không khả dụng */
  }
  return "en";
}

export const langStore = createStore<Lang>(initial());

export function setLang(l: Lang) {
  langStore.set(l);
  document.documentElement.lang = l;
  try {
    localStorage.setItem("gc-lang", l);
  } catch {
    /* bỏ qua */
  }
}

type Vars = Record<string, string | number | undefined | null>;

function lookup(d: unknown, key: string): string | undefined {
  let cur: unknown = d;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Dịch `key` theo ngôn ngữ hiện tại. Với biến `count`, ưu tiên `key_one` / `key_other`.
 * Thiếu bản dịch → rơi về tiếng Anh → rơi về chính key.
 */
export function t(key: string, vars?: Vars): string {
  const lang = langStore.get();
  let k = key;
  if (vars && typeof vars.count === "number") {
    const form = new Intl.PluralRules(lang).select(vars.count) === "one" ? "one" : "other";
    if (lookup(dicts[lang], `${key}_${form}`) ?? lookup(en, `${key}_${form}`)) k = `${key}_${form}`;
  }
  let s = lookup(dicts[lang], k) ?? lookup(en, k) ?? key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => {
      const v = vars[name];
      if (v === undefined || v === null) return m;
      return typeof v === "number" ? v.toLocaleString(lang === "vi" ? "vi-VN" : "en-US") : String(v);
    });
  }
  return s;
}

/** Hook để component render lại khi đổi ngôn ngữ. */
export function useT() {
  langStore.use((l) => l);
  return t;
}

export function currentLang(): Lang {
  return langStore.get();
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export function relTime(unix: number | null | undefined): string {
  if (!unix) return "—";
  const diff = unix - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return t("time.justNow");
  const rtf = new Intl.RelativeTimeFormat(langStore.get(), { numeric: "auto" });
  for (const [unit, sec] of UNITS) {
    if (abs >= sec) return rtf.format(Math.round(diff / sec), unit);
  }
  return t("time.justNow");
}

export function fullTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(langStore.get() === "vi" ? "vi-VN" : "en-US");
}
