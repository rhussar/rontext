import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Rontext" };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-stone-100 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 pb-8">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-300 via-sky-300 to-violet-300 shadow-sm">
            <span className="text-xl font-semibold text-white">M</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-stone-800">
            My Workspace
          </h1>
          <p className="text-sm text-stone-500">
            Enter your passcode to continue
          </p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
