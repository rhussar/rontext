"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Input
        type="password"
        name="passcode"
        placeholder="Passcode"
        autoFocus
        required
        autoComplete="current-password"
        className="h-11 bg-background text-base"
      />
      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
      <Button type="submit" disabled={pending} className="h-11">
        {pending ? "Signing in…" : "Continue"}
      </Button>
    </form>
  );
}
