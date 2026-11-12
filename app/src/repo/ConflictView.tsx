import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";
import { basename, dirname, joinPath } from "../ui/format";
import { Icon } from "../ui/Icon";
import { confirmDialog } from "../ui/store";
import { qk } from "./hooks";

type Seg = { kind: "text"; lines: string[] } | { kind: "conflict"; ours: string[]; base: string[] | null; theirs: string[]; oursLabel: string; theirsLabel: string };
type Choice = "ours" | "theirs" | "both" | "both-rev" | "base";

/** Tách nội dung có conflict marker thành các đoạn. */
export function parseConflict(text: string): Seg[] {
  const lines = text.split("\n");
  const segs: Seg[] = [];
  let buf: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("<<<<<<<")) {
      if (buf.length) segs.push({ kind: "text", lines: buf });
      buf = [];
      const oursLabel = l.slice(7).trim();
      const ours: string[] = [];
      let base: string[] | null = null;
      const theirs: string[] = [];
      let part: "ours" | "base" | "theirs" = "ours";
      let theirsLabel = "";
      i++;
      while (i < lines.length) {
        const m = lines[i];
        if (m.startsWith("|||||||") && part === "ours") {
          part = "base";
          base = [];
        } else if (/^=======\r?$/.test(m) && part !== "theirs") {
          part = "theirs";
        } else if (m.startsWith(">>>>>>>") && part === "theirs") {
          theirsLabel = m.slice(7).trim();
          break;
        } else (part === "ours" ? ours : part === "base" ? base! : theirs).push(m);
        i++;
      }
      segs.push({ kind: "conflict", ours, base, theirs, oursLabel, theirsLabel });
      i++;
      continue;
    }
    buf.push(l);
    i++;
  }
  if (buf.length) segs.push({ kind: "text", lines: buf });
  return segs;
}

function build(segs: Seg[], choices: Record<number, Choice>): string {
  const out: string[] = [];
  let ci = 0;
  for (const s of segs) {
    if (s.kind === "text") out.push(...s.lines);
    else {
      const c = choices[ci++];
      if (c === "ours") out.push(...s.ours);
      else if (c === "theirs") out.push(...s.theirs);
      else if (c === "both") out.push(...s.ours, ...s.theirs);
      else if (c === "both-rev") out.push(...s.theirs, ...s.ours);
      else if (c === "base") out.push(...(s.base ?? []));
      else out.push("<<<<<<< ours", ...s.ours, "=======", ...s.theirs, ">>>>>>> theirs");
    }
  }
  return out.join("\n");
}

interface Props {
  repoId: string;
  repoPath: string;
  path: string;
  run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
  headerExtra?: React.ReactNode;
}

export function ConflictView({ repoId, repoPath, path, run, headerExtra }: Props) {
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: qk.conflict(repoId, path), queryFn: () => api.conflict(repoId, path) });
  const segs = useMemo(() => parseConflict(data?.merged ?? ""), [data?.merged]);
  const blocks = segs.filter((s) => s.kind === "conflict").length;
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [manual, setManual] = useState<string | null>(null);
  useEffect(() => {
    setChoices({});
    setManual(null);
  }, [data?.merged]);

  if (isLoading || !data)
    return (
      <div className="conflict diff">
        <div className="diff-empty">{t("conflict.loading")}</div>
      </div>
    );

  const result = manual ?? build(segs, choices);
  const unresolved = manual === null ? blocks - Object.keys(choices).length : /^(<<<<<<<|>>>>>>>)/m.test(manual) ? 1 : 0;

  const save = async () => {
    if (unresolved > 0) {
      const ok = await confirmDialog(t("conflict.leftTitle"), t("conflict.leftBody", { count: unresolved }), {
        confirmLabel: t("conflict.saveAnyway"),
      });
      if (!ok) return;
    }
    await run(() => api.conflictResolve(repoId, path, result), t("conflict.resolvedToast", { path }));
  };

  const dir = dirname(path);
  const header = (
    <div className="diff-head">
      <span className="st st-U">U</span>
      <span className="diff-path" title={path}>
        {dir && <span className="dim">{dir}/</span>}
        {basename(path)}
      </span>
      <span className="spacer" />
      <button type="button" className="btn btn-sm" onClick={() => run(() => api.conflictTake(repoId, path, "ours"), t("conflict.tookOurs"))}>
        {t("conflict.takeOurs")}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => run(() => api.conflictTake(repoId, path, "theirs"), t("conflict.tookTheirs"))}>
        {t("conflict.takeTheirs")}
      </button>
      <button
        type="button"
        className="icon-btn sm"
        title={t("conflict.openVscode")}
        aria-label={t("conflict.openVscode")}
        onClick={() => api.revealPath(joinPath(repoPath, path), "vscode").catch(() => {})}
      >
        <Icon name="code" />
      </button>
      {headerExtra}
    </div>
  );

  if (data.binary || data.merged === null || blocks === 0) {
    return (
      <div className="conflict diff">
        {header}
        <div className="diff-body">
          <div className="diff-empty">{data.binary ? t("conflict.binary") : data.merged === null ? t("conflict.deleted") : t("conflict.noMarkers")}</div>
        </div>
        {!data.binary && data.merged !== null && (
          <div className="conflict-foot">
            <span className="spacer" />
            <button type="button" className="btn btn-primary" onClick={save}>
              <Icon name="check" size={14} />
              {t("conflict.markResolved")}
            </button>
          </div>
        )}
      </div>
    );
  }

  let ci = -1;
  return (
    <div className="conflict diff">
      {header}
      <div className="conflict-body">
        {manual === null ? (
          segs.map((s, i) => {
            if (s.kind === "text") {
              const ls = s.lines;
              const show = ls.length > 8 ? [...ls.slice(0, 3), "…", ...ls.slice(-3)] : ls;
              return (
                <pre key={i} className="cf-text">
                  {show.join("\n")}
                </pre>
              );
            }
            const idx = ++ci;
            const c = choices[idx];
            const pick = (v: Choice) => setChoices({ ...choices, [idx]: v });
            const choiceBtn = (v: Choice, label: string, title?: string) => (
              <button type="button" className={c === v ? "btn btn-sm on" : "btn btn-sm"} aria-pressed={c === v} onClick={() => pick(v)} title={title}>
                {c === v && <Icon name="check" size={13} />}
                {label}
              </button>
            );
            return (
              <div key={i} className={c ? "cf-block done" : "cf-block"}>
                <div className="cf-side cf-ours">
                  <div className="cf-label">
                    {t("conflict.ours")} <span className="dim mono small">{s.oursLabel || "ours"}</span>
                    {choiceBtn("ours", t("conflict.pick"))}
                  </div>
                  <pre>{s.ours.join("\n") || " "}</pre>
                </div>
                <div className="cf-side cf-theirs">
                  <div className="cf-label">
                    {t("conflict.theirs")} <span className="dim mono small">{s.theirsLabel || "theirs"}</span>
                    {choiceBtn("theirs", t("conflict.pick"))}
                  </div>
                  <pre>{s.theirs.join("\n") || " "}</pre>
                </div>
                <div className="cf-more">
                  {choiceBtn("both", t("conflict.both"))}
                  {choiceBtn("both-rev", t("conflict.bothRev"))}
                  {s.base && choiceBtn("base", t("conflict.base"), s.base.join("\n"))}
                </div>
              </div>
            );
          })
        ) : (
          <textarea className="cf-editor" value={manual} spellCheck={false} onChange={(e) => setManual(e.target.value)} aria-label={t("conflict.manual")} />
        )}
      </div>
      <div className="conflict-foot">
        <span className="dim small">{manual === null ? t("conflict.progress", { done: blocks - unresolved, total: blocks }) : t("conflict.manual")}</span>
        <span className="spacer" />
        {manual === null ? (
          <button type="button" className="btn btn-ghost" onClick={() => setManual(result)}>
            {t("conflict.editManual")}
          </button>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setManual(null)}>
            {t("conflict.backToBlocks")}
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={save}>
          <Icon name="check" size={14} />
          {t("conflict.save")}
        </button>
      </div>
    </div>
  );
}
