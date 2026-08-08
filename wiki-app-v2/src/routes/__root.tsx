import { createRootRoute, Outlet } from "@tanstack/react-router";

// Root of the entire app. App-wide providers mount here; the two child layouts
// (_public / _authenticated) own the actual chrome. Keeping the root this thin
// means a provider added later touches exactly one file.
export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return <Outlet />;
}
