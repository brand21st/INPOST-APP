import { useEffect, useRef } from "react";
import type { AnalyticsSnapshot } from "./types";

async function authHeaders(): Promise<HeadersInit> {
  const shopify = (window as unknown as { shopify?: { idToken?: () => Promise<string> } }).shopify;
  const token = shopify?.idToken ? await shopify.idToken() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useAnalyticsPoll(
  search: string,
  onData: (snapshot: AnalyticsSnapshot) => void,
  onError: () => void,
  enabled: boolean,
) {
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  onDataRef.current = onData;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const headers = await authHeaders();
        const response = await fetch(`/app/analytics/data${search}`, { headers });
        if (cancelled) return;
        if (!response.ok) {
          onErrorRef.current();
          return;
        }
        const body = (await response.json()) as AnalyticsSnapshot | { error?: string };
        if ("error" in body && body.error) {
          onErrorRef.current();
          return;
        }
        onDataRef.current(body as AnalyticsSnapshot);
      } catch {
        if (!cancelled) onErrorRef.current();
      }
    };
    timer = setInterval(tick, 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [search, enabled]);
}
