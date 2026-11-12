import { useSyncExternalStore } from "react";

/** Store tối giản dùng useSyncExternalStore (không cần thư viện ngoài). */
export function createStore<S>(initial: S) {
  let state = initial;
  const subs = new Set<() => void>();
  const get = () => state;
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => void subs.delete(f);
  };
  return {
    get,
    subscribe,
    set(next: S | ((s: S) => S)) {
      state = typeof next === "function" ? (next as (s: S) => S)(state) : next;
      subs.forEach((f) => f());
    },
    /** Snapshot là chính state (ổn định); selector áp dụng sau nên có thể trả object mới. */
    use<R>(sel: (s: S) => R): R {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const s = useSyncExternalStore(subscribe, get);
      return sel(s);
    },
  };
}

