/**
 * GET /api/export?format=csv|json — download your data.
 *
 * Behind the passcode like every page (src/proxy.ts redirects unauthenticated
 * requests, and the browser sends the session cookie on a plain link click),
 * so this needs no auth of its own. `Content-Disposition: attachment` makes
 * the link a download rather than a page of CSV.
 */
import { NextResponse, type NextRequest } from "next/server";
import { contactsCsv, exportFilename, snapshotJson } from "@/lib/export";

export const dynamic = "force-dynamic";
/** The JSON snapshot reads ~10 tables; give it room on a cold Neon. */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const format = req.nextUrl.searchParams.get("format") ?? "csv";
  if (format === "json") {
    const snapshot = await snapshotJson();
    return new NextResponse(JSON.stringify(snapshot), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename("json")}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (format === "csv") {
    const csv = await contactsCsv();
    // BOM so Excel/Numbers open non-ASCII names correctly without an import wizard.
    return new NextResponse("\ufeff" + csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename("csv")}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ error: "format must be csv or json" }, { status: 400 });
}
