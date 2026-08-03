// src/components/common.tsx
//
// Small shared pieces. useApi in particular exists so that every page
// handles loading and failure the same way — a page that silently
// renders an empty table when a fetch failed looks identical to a tenant
// with no data, and in a multi-tenant system "you have no reports" is a
// dangerous thing to say by accident.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";

export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetcher());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong loading this page.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, loading, error, reload: run };
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
