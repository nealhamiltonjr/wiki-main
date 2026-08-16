import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Component, type ErrorInfo, type ReactNode } from "react";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ErrorBoundary fallback={<RouteErrorFallback />}>
      <Outlet />
    </ErrorBoundary>
  );
}

interface Props { children: ReactNode; fallback: ReactNode; }
interface State { error: Error | null; }

class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] render throw:", error, info.componentStack);
  }
  override render(): ReactNode {
    if (this.state.error) return <RouteErrorFallback error={this.state.error} />;
    return this.props.children;
  }
}

function RouteErrorFallback({ error }: { error?: unknown }): ReactNode {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return (
    <div role="alert" className="wiki-error-boundary">
      <h1>Something went wrong</h1>
      <p>The page hit an unexpected error while rendering. Your data is safe — reloading usually clears it.</p>
      <pre>{message}</pre>
      <button type="button" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
