import { lazy, Suspense, useState, useEffect } from "react";
import { Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
import { useSession, signOut } from "../api/authClient.js";
import { Login } from "./auth/Login.js";
import { Tree } from "./tree/Tree.js";
import { useTheme, type Theme } from "./theme/ThemeContext.js";
import { CommandPalette } from "./search/CommandPalette.js";
import { SearchBox } from "./search/SearchBox.js";
import { Toaster } from "../components/ui/sonner.js";
import { cn } from "../lib/utils.js";
import { BookMarked, Contrast, LogOut, Moon, Monitor, Settings as SettingsIcon, Sun } from "lucide-react";

// UI overhaul B2: heavy feature routes are code-split so the initial bundle
// doesn't drag in Tiptap/Hocuspocus/better-auth admin UI for the login shell.
const Editor = lazy(() => import("./editor/Editor.js").then((m) => ({ default: m.Editor })));
const Settings = lazy(() => import("./settings/Settings.js").then((m) => ({ default: m.Settings })));
const PublicView = lazy(() => import("./public/PublicView.js").then((m) => ({ default: m.PublicView })));

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "contrast", label: "Contrast", icon: Contrast },
  { value: "system", label: "System", icon: Monitor },
];

function Sidebar() {
  const navigate = useNavigate();
  const { branchId } = useParams();
  const location = useLocation();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const isSettings = location.pathname.startsWith("/settings");

  return (
    <div
      className="flex min-w-0 flex-col"
      style={{
        width: "var(--sidebar-width)",
        minWidth: "var(--sidebar-width)",
        borderRight: "1px solid var(--color-border)",
        background: "var(--color-bg-secondary)",
      }}
    >
      <Tree selectedBranchId={branchId ?? null} onSelectBranch={(id) => navigate(`/pages/${id}`)} />
      <div className="wiki-sidebar-footer">
        <div className="user-chip">
          <span className="avatar">{(session?.user.name ?? "?").slice(0, 1)}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session?.user.name}{session?.user.isAdmin ? " (admin)" : ""}
          </span>
        </div>
        <div className="footer-actions">
          <button className="wiki-icon-btn" style={{ flex: 1, padding: "4px 10px" }} onClick={() => navigate(isSettings ? "/" : "/settings")}>
            <SettingsIcon className="h-4 w-4" aria-hidden />
            {isSettings ? "Pages" : "Settings"}
          </button>
          <button className="wiki-icon-btn" style={{ flex: 1, padding: "4px 10px" }} onClick={() => signOut()}>
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </button>
        </div>
        <div className="wiki-theme-switcher">
          <span className="theme-label">
            <span className="theme-dot" aria-hidden />
            Theme
          </span>
          {THEME_OPTIONS.map((t) => {
            const Icon = t.icon;
            const active = theme === t.value;
            return (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                title={`${t.label} theme`}
                aria-pressed={active}
                className={cn("wiki-icon-btn", active && "theme-active")}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EditorRoute() {
  const { branchId } = useParams<{ branchId: string }>();
  return <Editor branchId={branchId!} />;
}

function LoadingFallback() {
  return <div className="loading-page">Loading…</div>;
}

export default function App() {
  const { data: session, isPending, refetch } = useSession();
  const [publicMode, setPublicMode] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/public/config")
      .then((r) => r.json())
      .then((c) => setPublicMode(c.publicMode))
      .catch(() => setPublicMode(false));
  }, []);

  if (isPending || publicMode === null) return null;

  // Public mode: unauthenticated visitors see the public-facing site
  if (!session) {
    if (publicMode) {
      return (
        <>
          <Routes>
            <Route path="/login" element={<Login onAuthed={() => refetch()} />} />
            <Route path="*" element={<Suspense fallback={<LoadingFallback />}><PublicView /></Suspense>} />
          </Routes>
          <Toaster />
        </>
      );
    }
    return (
      <>
        <Login onAuthed={() => refetch()} />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <div style={{ display: "flex", height: "100vh" }}>
        <Sidebar />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <SearchBox />
          <div style={{ flex: 1, overflow: "auto" }}>
            <Suspense fallback={<LoadingFallback />}>
              <Routes>
                <Route path="/pages/:branchId" element={<EditorRoute />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/" element={
                  <div style={{ padding: "var(--space-6)", color: "var(--color-text-muted)" }}>
                    <BookMarked className="h-5 w-5" aria-hidden />
                    <span className="align-middle">Select or create a page</span>
                  </div>
                } />
              </Routes>
            </Suspense>
          </div>
        </div>
        <CommandPalette />
      </div>
      <Toaster />
    </>
  );
}
