import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { router } from "./router";
import "./styles/app.css";
import { registerOfflineServiceWorker } from "./features/offline/register-sw";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);

// Brief §12.5 — register the offline service worker. The function is
// best-effort: a registration failure (e.g. served over plain HTTP from
// a LAN address, browser without SW support) must NOT prevent the app
// from rendering. The console gets a warning; the rest of the app is
// unaffected.
registerOfflineServiceWorker();
