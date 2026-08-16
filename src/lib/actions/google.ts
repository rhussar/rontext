"use server";

import { revalidatePath } from "next/cache";
import {
  clearGoogleGrant,
  getGoogleConnection,
  type GoogleScopeKey,
} from "@/lib/google-auth";

/** Presence and provenance only — the refresh token never leaves the server. */
export type GoogleStatus = {
  connected: boolean;
  /** "Connect" would work: a Web client is in Setup (see getGoogleConnection). */
  canConnect: boolean;
  /** Client id/secret present in Setup at all. */
  clientConfigured: boolean;
  clientType: "desktop" | "web" | null;
  email: string | null;
  scopes: GoogleScopeKey[];
  connectedAt: string | null;
};

export async function getGoogleStatus(): Promise<GoogleStatus> {
  return getGoogleConnection();
}

export async function disconnectGoogle(): Promise<GoogleStatus> {
  await clearGoogleGrant();
  revalidatePath("/", "layout");
  return getGoogleConnection();
}
