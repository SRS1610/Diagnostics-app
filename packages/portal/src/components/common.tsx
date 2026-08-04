// src/components/common.tsx
//
// Small shared pieces. useApi in particular exists so that every page
// handles loading and failure the same way — a page that silently
// renders an empty table when a fetch failed looks identical to a tenant
// with no data, and in a multi-tenant system "you have no reports" is a
// dangerous thing to say by accident.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every call gets a sequence number and only the newest one is allowed
  // to write state. Without this, two fetches in flight resolve in
  // whatever order the network returns them, and a slow EARLIER response
  // can land after a fast later one — so clicking two filters in quick
  // succession leaves the first filter's rows under the second filter's
  // label. Not hypothetical on the Activity Log, where the filter
  // buttons sit next to each other.
  const latest = useRef(0);
  // Also guards against setting state on an unmounted component after a
  // navigation.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const call = ++latest.current;
    const isStale = () => call !== latest.current || !mounted.current;

    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (isStale()) return;
      setData(result);
    } catch (e) {
      if (isStale()) return;
      setError(e instanceof ApiError ? e.message : "Something went wrong loading this page.");
      // Drop whatever was on screen. Leaving the previous tenant's or
      // the previous filter's rows visible under a fresh heading is
      // worse than showing nothing: it reads as current data.
      setData(null);
    } finally {
      if (!isStale()) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, loading, error, reload: run };
}

/**
 * A headline number.
 *
 * It takes the fetch's loading/error state rather than just a value,
 * because the alternative — rendering `data?.length ?? 0` — turns a
 * FAILED request into the confident statement "0". On this portal that
 * statement is "0 disputes awaiting review", which tells an admin there
 * is nothing to action when there may be a queue. A number nobody can
 * stand behind is shown as "—".
 */
export function StatCard({
  value,
  label,
  loading,
  error,
  color,
}: {
  value: number | string;
  label: string;
  loading?: boolean;
  error?: string | null;
  color?: string;
}) {
  const unavailable = Boolean(error) || loading;
  return (
    <div className="card">
      <div className="stat-num" style={{ color: unavailable ? "var(--text-faint)" : color }}>
        {error ? "—" : loading ? "…" : value}
      </div>
      <div className="stat-label">
        {label}
        {error && <span className="muted"> · unavailable</span>}
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "pass" || status === "active" || status === "completed" || status === "resolved_upheld"
      ? "badge-pass"
      : status === "fail" || status === "suspended" || status === "failed"
        ? "badge-fail"
        : status === "pass_with_warnings" || status === "warning" || status === "awaiting_review"
          ? "badge-warn"
          : "badge-neutral";
  return <span className={`badge ${cls}`}>{status.replace(/_/g, " ")}</span>;
}

export function AsyncBoundary({
  loading,
  error,
  isEmpty,
  emptyMessage,
  children,
}: {
  loading: boolean;
  error: string | null;
  isEmpty?: boolean;
  emptyMessage?: string;
  children: React.ReactNode;
}) {
  if (loading) return <div className="empty">Loading…</div>;
  // An error must never fall through to the empty state: "nothing here"
  // and "we could not load this" have to look different.
  if (error) return <div className="error-box">{error}</div>;
  if (isEmpty) return <div className="empty">{emptyMessage ?? "Nothing to show yet."}</div>;
  return <>{children}</>;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
