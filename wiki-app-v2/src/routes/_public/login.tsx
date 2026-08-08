import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

// Placeholder login surface for slice 1. Slice 2 replaces the button with the
// real better-auth sign-in flow.
export const Route = createFileRoute("/_public/login")({
  component: LoginPage,
});

function LoginPage() {
  return (
    <div className="w-full max-w-sm space-y-4 rounded-lg border p-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="text-sm text-muted-foreground">
        Authentication is wired in slice 2 (better-auth).
      </p>
      <Button disabled className="w-full">
        Continue
      </Button>
    </div>
  );
}
