// src/pages/SsoComplete.tsx
//
// Where the IdP's browser redirect lands after auth.ts's GET
// /auth/sso/callback finishes. Two possible query params, never both:
//   ?handoff=<token>  — success; trade it for a real session immediately
//   ?error=<message>  — the API already decided this attempt failed and
//                        says why, in terms safe to put in a URL
//
// The handoff is single-purpose and expires in 2 minutes specifically so
// it is never treated as a session itself — this page's only job is to
// exchange it and then get off this URL.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "../auth/SessionContext";
import { ApiError } from "../api/client";

export function SsoCompletePage() {
  const { completeSso } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(params.get("error"));
  // StrictMode/effect re-run guard — a handoff token is single-use, so a
  // second exchange attempt would fail with a confusing error even
  // though the first one already succeeded.
  const attempted = useRef(false);

  useEffect(() => {
    const handoff = params.get("handoff");
    if (!handoff || attempted.current) return;
    attempted.current = true;

    completeSso(handoff)
      .then((role) => navigate(role === "master_admin" ? "/master" : "/dashboard", { replace: true }))
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not complete SSO sign-in.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Signing in…</h1>
        {error ? (
          <>
            <div className="error-box">{error}</div>
            <button className="btn" style={{ width: "100%", marginTop: 10 }} onClick={() => navigate("/login", { replace: true })}>
              Back to sign-in
            </button>
          </>
        ) : (
          <p className="page-sub">Completing sign-in with your identity provider…</p>
        )}
      </div>
    </div>
  );
}
