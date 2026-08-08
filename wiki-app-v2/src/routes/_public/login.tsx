import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Login } from "@/features/auth/Login";

// Real better-auth sign-in surface (slice 2 backend, slice 4 UI): sign in or
// sign up, then the authenticated layout's session gate takes over.
export const Route = createFileRoute("/_public/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  return <Login onAuthed={() => void navigate({ to: "/" })} />;
}
