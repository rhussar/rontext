"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

const REASONS: Record<string, string> = {
  state: "the sign-in didn't start from this app (state mismatch) — try again",
  access_denied: "you cancelled on Google's screen",
  no_refresh_token: "Google didn't return a refresh token — remove the app at myaccount.google.com/permissions and connect again",
  no_client: "GOOGLE_CLIENT_ID / SECRET aren't set in Setup",
  exchange_failed: "couldn't reach Google to finish",
  redirect_uri_mismatch: "the redirect URI isn't registered on the OAuth client — add this app's /api/oauth/google/callback",
};

/**
 * The OAuth callback lands on "/" with ?google=connected|error&reason=…;
 * this reads it once, says so, and cleans the URL so a refresh doesn't repeat
 * the toast. Mounted in the (app) layout so it works from any page.
 */
export function OAuthResultToast() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const google = params.get("google");
  const reason = params.get("reason");
  useEffect(() => {
    if (!google) return;
    if (google === "connected") toast.success("Google connected — Gmail, Calendar and Contacts will sync daily.");
    else toast.error(`Google connect failed: ${REASONS[reason ?? ""] ?? reason ?? "unknown error"}.`);
    const next = new URLSearchParams(params);
    next.delete("google");
    next.delete("reason");
    router.replace(next.size ? `${pathname}?${next}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [google, reason]);
  return null;
}
