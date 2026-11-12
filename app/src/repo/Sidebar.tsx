import { useMemo, useState } from "react";
import { relTime, t, useT } from "../i18n";
import type { Branch, RepoStatus } from "../types";
import { Icon, Oct } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { showMenu } from "../ui/store";
import type { RepoActions } from "./actions";
import { useRefs } from "./hooks";

interface Props {
  repoId: string;
  status: RepoStatus | undefined;
  actions: RepoActions;
  onJump: (sha: string) => void;
}

export function Sidebar({ repoId, status, actions: a, onJump }: Props) {
  const tt = useT();
  const { data: refs } = useRefs(repoId);
  const [filter, setFilter] = useState("");
  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);

  const local = useMemo(() => refs?.branches.filter((b) => !b.remote && match(b.name)) ?? [], [refs, f]);
  const remotes = useMemo(() => {
    const m = new Map<string, Branch[]>();
    for (const r of refs?.remotes ?? []) m.set(r.name, []);
    for (const b of refs?.branches ?? []) {
      if (!b.remote || !match(b.name)) continue;
      const r = b.name.split("/")[0];
      m.set(r, [...(m.get(r) ?? []), b]);
    }
    return m;
  }, [refs, f]);
  const tags = refs?.tags.filter((x) => match(x.name)) ?? [];
  const stashes = refs?.stashes.filter((s) => match(s.message)) ?? [];
  const current = status?.branch ?? null;
  const remoteNames = refs?.remotes.map((r) => r.name) ?? [];

  const branchMenu = (e: React.MouseEvent, b: Branch) =>
    showMenu(e, [
      { label: t("sidebar.menu.checkout"), disabled: b.current, onClick: () => a.checkout(b) },
      { label: t("sidebar.menu.branchFrom"), onClick: () => a.createBranch(b.name, b.name) },
      { separator: true },
      { label: t("sidebar.menu.mergeInto", { branch: current ?? "HEAD" }), disabled: b.current || !current, onClick: () => a.merge(b.name, current) },
      { label: t("sidebar.menu.rebaseOnto", { branch: current ?? "HEAD" }), disabled: b.current || !current, onClick: () => a.rebase(b.name, current) },
      { separator: true },
      { label: t("sidebar.menu.rename"), disabled: b.remote, onClick: () => a.renameBranch(b) },
      { label: b.remote ? t("sidebar.menu.deleteRemote") : t("sidebar.menu.delete"), danger: true, disabled: b.current, onClick: () => a.deleteBranch(b) },
    ]);

  const branchMeta = (b: Branch): { text: string; color?: string } | null => {
    if (!refs?.remotes.length) return null;
    if (b.upstreamGone) return { text: tt("sidebar.upstreamGone"), color: "var(--danger)" };
    if (!b.upstream) return { text: tt("sidebar.notPublished"), color: "var(--amber)" };
    const parts = [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean);
    if (parts.length) return { text: parts.join(" "), color: b.behind ? "var(--amber)" : "var(--accent)" };
    return { text: tt("sidebar.synced", { upstream: b.upstream.split("/")[0] }) };
  };

  return (
    <aside className="sidebar" aria-label={tt("sidebar.label")}>
      <div className="sidebar-top">
        <label className="search-box">
          <span className="sr-only">{tt("sidebar.filter")}</span>
          <Icon name="search" size={14} />
          <input placeholder={tt("sidebar.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        </label>
      </div>
      <div className="sidebar-scroll">
        <Section title={tt("sidebar.local")} count={local.length} action={{ label: tt("sidebar.createBranch"), onClick: () => a.createBranch() }}>
          {local.map((b) => {
            const meta = branchMeta(b);
            return (
              <RefRow
                key={b.fullName}
                current={b.current}
                label={b.name}
                meta={meta?.text}
                metaColor={meta?.color}
                onClick={() => onJump(b.sha)}
                onActivate={() => !b.current && a.checkout(b)}
                onContextMenu={(e) => branchMenu(e, b)}
                title={b.upstream ? tt("sidebar.tracks", { name: b.name, upstream: b.upstream }) : tt("sidebar.noUpstream", { name: b.name })}
              />
            );
          })}
        </Section>

        {[...remotes.entries()].map(([name, list]) => (
          <Section key={name} title={tt("sidebar.remote", { name })} count={list.length} defaultOpen={false}>
            {list.map((b) => (
              <RefRow
                key={b.fullName}
                icon="cloud"
                muted
                label={b.name.slice(name.length + 1)}
                onClick={() => onJump(b.sha)}
                onActivate={() => a.checkout(b)}
                onContextMenu={(e) => branchMenu(e, b)}
                title={tt("sidebar.remoteTip", { name: b.name })}
              />
            ))}
          </Section>
        ))}
        {remotes.size === 0 && (
          <Section title={tt("sidebar.remoteNone")} count={0}>
            <button className="link-btn small" style={{ padding: "2px 12px 6px 36px", textAlign: "left" }} onClick={() => a.addRemote()}>
              {tt("sidebar.addRemote")}
            </button>
          </Section>
        )}

        <Section title={tt("sidebar.tags")} count={tags.length} defaultOpen={false}>
          {tags.map((x) => (
            <RefRow
              key={x.name}
              icon="tag"
              muted
              label={x.name}
              onClick={() => onJump(x.sha)}
              onContextMenu={(e) =>
                showMenu(e, [
                  { label: t("sidebar.menu.pushTag"), disabled: !remoteNames.length, onClick: () => a.pushTag(x.name, remoteNames) },
                  { label: t("sidebar.menu.deleteTag"), danger: true, onClick: () => a.deleteTag(x.name) },
                ])
              }
            />
          ))}
        </Section>

        <Section title={tt("sidebar.stashes")} count={stashes.length} action={{ label: tt("sidebar.stashChanges"), onClick: () => a.stash() }}>
          {stashes.length === 0 && <p className="sb-empty">{tt("sidebar.noStash")}</p>}
          {stashes.map((s) => (
            <RefRow
              key={s.sha}
              icon="stash"
              muted
              label={s.message.replace(/^On [^:]+: /, "").replace(/^WIP on [^:]+: /, "WIP: ")}
              meta={relTime(s.time)}
              title={`${s.name}\n${s.message}`}
              onActivate={() => a.stashApply(s.index, true)}
              onContextMenu={(e) =>
                showMenu(e, [
                  { label: t("sidebar.menu.pop"), onClick: () => a.stashApply(s.index, true) },
                  { label: t("sidebar.menu.apply"), onClick: () => a.stashApply(s.index, false) },
                  { separator: true },
                  { label: t("sidebar.menu.drop"), danger: true, onClick: () => a.stashDrop(s.index, s.message) },
                ])
              }
            />
          ))}
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  count,
  children,
  action,
  defaultOpen = true,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <div className="sb-head">
        <button className="sb-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevDown" size={13} />
          <h3>{title}</h3>
          <span className="sb-count">{count}</span>
        </button>
        {action && (
          <button className="icon-btn xs" title={action.label} aria-label={action.label} onClick={action.onClick}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {open && <div className="col">{children}</div>}
    </section>
  );
}

function RefRow({
  label,
  current,
  icon,
  muted,
  meta,
  metaColor,
  title,
  onClick,
  onActivate,
  onContextMenu,
}: {
  label: string;
  current?: boolean;
  icon?: IconName;
  muted?: boolean;
  meta?: string;
  metaColor?: string;
  title?: string;
  onClick?: () => void;
  onActivate?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      className={`ref-row${current ? " current" : ""}${muted ? " muted-row" : ""}`}
      title={title ?? label}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
      onDoubleClick={onActivate}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onActivate) onActivate();
        if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && onContextMenu) {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left + 24, clientY: r.bottom } as React.MouseEvent);
        }
      }}
    >
      {current ? (
        <Oct size={10} color="var(--brand)" />
      ) : (
        <span className="ref-icon">
          <Icon name={icon ?? "branch"} size={14} />
        </span>
      )}
      <span className="ref-label">{label}</span>
      {meta && (
        <span className="ref-meta" style={metaColor ? { color: metaColor } : undefined}>
          {meta}
        </span>
      )}
    </button>
  );
}
