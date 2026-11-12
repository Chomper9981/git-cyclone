import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../api";
import { toast, toastError } from "../ui/store";

export const qk = {
  status: (id: string) => ["status", id] as const,
  graph: (id: string, limit: number) => ["graph", id, limit] as const,
  refs: (id: string) => ["refs", id] as const,
  commit: (id: string, sha: string) => ["commit", id, sha] as const,
  cdiff: (id: string, sha: string, path: string) => ["cdiff", id, sha, path] as const,
  wtdiff: (id: string, path: string, staged: boolean) => ["wtdiff", id, path, staged] as const,
  conflict: (id: string, path: string) => ["conflict", id, path] as const,
};

/** Làm mới dữ liệu của repo. scope "status" chỉ làm mới phần worktree. */
export function invalidateRepo(qc: QueryClient, repoId: string, scope: "status" | "all" = "all") {
  const statusKeys = new Set(["status", "wtdiff", "conflict"]);
  return qc.invalidateQueries({
    predicate: (q) => q.queryKey[1] === repoId && (scope === "all" || statusKeys.has(String(q.queryKey[0]))),
  });
}

export function useStatus(repoId: string) {
  return useQuery({ queryKey: qk.status(repoId), queryFn: () => api.status(repoId) });
}

export function useRefs(repoId: string) {
  return useQuery({ queryKey: qk.refs(repoId), queryFn: () => api.refs(repoId) });
}

export function useGraph(repoId: string, limit: number) {
  return useQuery({
    queryKey: qk.graph(repoId, limit),
    queryFn: () => api.graph(repoId, limit),
    placeholderData: keepPreviousData,
  });
}

/**
 * Trả hàm chạy một thao tác ghi: báo lỗi bằng toast, luôn làm mới dữ liệu repo sau khi xong.
 * Trả `true` nếu thành công.
 */
export function useRepoAction(repoId: string) {
  const qc = useQueryClient();
  return useCallback(
    async (fn: () => Promise<unknown>, success?: string, errorTitle?: string): Promise<boolean> => {
      try {
        await fn();
        if (success) toast("success", success);
        return true;
      } catch (e) {
        toastError(e, errorTitle);
        return false;
      } finally {
        await invalidateRepo(qc, repoId);
      }
    },
    [qc, repoId],
  );
}
