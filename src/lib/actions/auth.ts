"use server";

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionToken, SESSION_COOKIE, SESSION_DAYS } from "@/lib/session";

export type LoginState = { error?: string };

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const passcode = String(formData.get("passcode") ?? "");
  const expected = process.env.APP_PASSCODE ?? "";

  const a = createHash("sha256").update(passcode).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!expected || !timingSafeEqual(a, b)) {
    return { error: "Wrong passcode. Try again." };
  }

  const token = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * SESSION_DAYS,
    path: "/",
  });

  redirect(safeNext(formData.get("next")));
}

/**
 * Where to go after signing in. Only a path on this site — "//evil.com" and
 * "/\\evil.com" are protocol-relative to a browser, and an absolute URL
 * would make the login page an open redirect.
 */
function safeNext(v: FormDataEntryValue | null): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) {
    return "/";
  }
  return v;
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/login");
}
