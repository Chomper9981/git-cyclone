export { fullTime, relTime } from "../i18n";

export const shortSha = (sha: string) => sha.slice(0, 7);

export function basename(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

/** Ghép đường dẫn theo dấu phân cách mà `root` đang dùng (`\\` trên Windows, `/` trên Linux/macOS). */
export function joinPath(root: string, rel: string) {
  if (!rel) return root;
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${base}${sep}${rel.split(/[\\/]/).filter(Boolean).join(sep)}`;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
