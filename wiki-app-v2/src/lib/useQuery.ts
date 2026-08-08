import { useState, useEffect, useRef } from "react";

/**
 * Minimal fetch-with-cache hook. Calls `fn` whenever `deps` change; exposes
 * { data, loading, error, reload }. No stale-while-revalidate — simple and
 * predictable for navigation-driven page loads.
 */
export function useQuery<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[]
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const key = useRef(0);

  const load = () => {
    const run = ++key.current;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => { if (run === key.current) { setData(d); setLoading(false); } })
      .catch((e) => { if (run === key.current) { setError(e instanceof Error ? e : new Error(String(e))); setLoading(false); } });
  };

  useEffect(() => { load(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, reload: load };
}
