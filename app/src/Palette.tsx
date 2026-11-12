import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { t, useT } from "./i18n";
import type { RepoActions } from "./repo/actions";
import { createStore } from "./ui/createStore";
import { openDialog, paletteOpen } from "./ui/store";

export interface Command {
  id: string;
  /** Khoá nhóm: palette.groups.* */
  group: "goto" | "repo" | "view" | "app";
  /** Hàm trả nhãn — dịch lúc hiển thị để đổi ngôn ngữ có hiệu lực ngay. */
  label: () => string;
  hint?: string;
  run: () => void;
}

const registry = createStore<Record<string, Command[]>>({});

export function registerCommands(source: string, cmds: Command[]) {
  registry.set((r) => ({ ...r, [source]: cmds }));
  return () =>
    registry.set((r) => {
      const n = { ...r };
      delete n[source];
      return n;
    });
}

export function registerRepoCommands(repoId: string, a: RepoActions, nav: { showHistory: () => void; showChanges: () => void }) {
  return registerCommands("repo", [
    { id: "fetch", group: "repo", label: () => t("palette.fetch"), hint: "Ctrl+Shift+F", run: () => a.fetch() },
    { id: "pull", group: "repo", label: () => t("palette.pull"), hint: "Ctrl+Shift+L", run: () => a.pull() },
    { id: "push", group: "repo", label: () => t("palette.push"), hint: "Ctrl+Shift+P", run: () => a.push() },
    { id: "force-push", group: "repo", label: () => t("palette.forcePush"), run: () => a.push(true) },
    { id: "branch", group: "repo", label: () => t("palette.newBranch"), run: () => a.createBranch() },
    {
      id: "checkout",
      group: "repo",
      label: () => t("palette.checkout"),
      run: async () => {
        const refs = await api.refs(repoId);
        const options = refs.branches
          .filter((b) => !b.current)
          .map((b) => ({ value: b.fullName, label: b.remote ? t("palette.remoteSuffix", { name: b.name }) : b.name }));
        if (!options.length) return;
        const r = await openDialog({
          title: t("palette.checkoutTitle"),
          fields: [{ name: "b", label: t("palette.branch"), type: "select", value: options[0].value, options }],
          confirmLabel: t("actions.checkout"),
        });
        const b = r && refs.branches.find((x) => x.fullName === r.b);
        if (b) a.checkout(b);
      },
    },
    { id: "stash", group: "repo", label: () => t("palette.stash"), run: () => a.stash() },
    { id: "undo", group: "repo", label: () => t("palette.undo"), run: () => a.undoLastCommit() },
    { id: "remote", group: "repo", label: () => t("palette.addRemote"), run: () => a.addRemote() },
    { id: "history", group: "view", label: () => t("palette.history"), hint: "Ctrl+1", run: nav.showHistory },
    { id: "changes", group: "view", label: () => t("palette.changes"), hint: "Ctrl+2", run: nav.showChanges },
  ]);
}

export function Palette() {
  const open = paletteOpen.use((o) => o);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        paletteOpen.set(!paletteOpen.get());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!open) return null;
  return <PaletteBox onClose={() => paletteOpen.set(false)} />;
}

function PaletteBox({ onClose }: { onClose: () => void }) {
  const tt = useT();
  const reg = registry.use((r) => r);
  const all = useMemo(() => Object.values(reg).flat(), [reg]);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter((c) => terms.every((x) => `${tt(`palette.groups.${c.group}`)} ${c.label()}`.toLowerCase().includes(x)));
  const exec = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    setTimeout(c.run, 0);
  };
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label={tt("palette.label")}>
        <input
          ref={input}
          value={q}
          placeholder={tt("palette.placeholder")}
          onChange={(e) => (setQ(e.target.value), setI(0))}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(list.length - 1, x + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
            if (e.key === "Enter") exec(list[i]);
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-label={tt("palette.label")}
        />
        <div className="palette-list" id="palette-list" role="listbox">
          {list.map((c, idx) => (
            <button
              key={c.group + c.id}
              role="option"
              aria-selected={idx === i}
              className={idx === i ? "pal-item on" : "pal-item"}
              onMouseEnter={() => setI(idx)}
              onClick={() => exec(c)}
            >
              <span className="dim small">{tt(`palette.groups.${c.group}`)}</span>
              <span>{c.label()}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
          {list.length === 0 && <div className="fl-empty">{tt("palette.none")}</div>}
        </div>
      </div>
    </div>
  );
}
