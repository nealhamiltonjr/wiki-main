import { useCallback, useEffect, useRef, useState } from "react";

export function useQuery<T>(fn: () => Promise<T>, deps: readonly unknown[]): {
  data: T | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const currentRef = useRef(0);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(async () => {
    const counter = ++currentRef.current;
    setLoading(true);
    try {
      const result = await fnRef.current();
      if (counter === currentRef.current) {
        setData(result);
        setError("");
      }
    } catch (err) {
      if (counter === currentRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load");
      }
    } finally {
      if (counter === currentRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, reload: load };
}
