import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Tracker } from "./Tracker";
import "./index.css";

/**
 * One route that matters. There is no login, no home page and no way to
 * reach a device without its link — a landing page listing anything
 * would be a way in that the token model deliberately doesn't have.
 */
function NoToken() {
  return (
    <div className="page">
      <div className="top-brand">
        <div className="brand-mark">✓</div>
        <div className="brand-name">Trade-In Tracker</div>
      </div>
      <div className="card">
        <h2>You'll need your tracking link</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Open the link from your inspection report, or scan the code printed on it. There's no sign-in — the link is
          how we know it's your device.
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/track/:token" element={<Tracker />} />
        <Route path="/" element={<NoToken />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
