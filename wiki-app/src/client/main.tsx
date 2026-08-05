import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./features/App.js";
import { ShareView } from "./features/share/ShareView.js";
import { ThemeProvider } from "./features/theme/ThemeContext.js";
// Tailwind utilities first (no preflight), then the app's own token/component
// styles, so theme.css rules keep overriding Tailwind's base layer.
import "./index.css";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/share/:token" element={<ShareView />} />
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>
);
