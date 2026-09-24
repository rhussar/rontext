"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Download, ExternalLink, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { getMeeting, type MeetingFull } from "@/lib/actions/meetings";
import { displayName } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * A recorded meeting, read in place: the notetaker's summary and notes
 * rendered as markdown, the transcript folded away underneath, plus the way
 * out to Wispr Flow and the .md download. Loads its body on open — the
 * timeline only ever carries titles and times.
 */
export function MeetingDialog({
  meetingId,
  open,
  onOpenChange,
}: {
  meetingId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [meeting, setMeeting] = useState<MeetingFull | null | undefined>(undefined);
  const [showTranscript, setShowTranscript] = useState(false);

  useEffect(() => {
    if (!open || meeting !== undefined) return;
    getMeeting(meetingId).then(setMeeting);
  }, [open, meeting, meetingId]);

  const tz =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
  const mins =
    meeting?.endedAt
      ? Math.round((meeting.endedAt.getTime() - meeting.startedAt.getTime()) / 60_000)
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 pb-3 pt-5">
          <DialogTitle className="pr-8 text-[16px]">
            {meeting?.title ?? "Meeting"}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {meeting ? (
              <>
                {format(meeting.startedAt, "EEE, MMM d, yyyy · h:mm a")}
                {mins ? ` · ${mins} min` : ""}
                {meeting.people.length ? (
                  <>
                    {" · with "}
                    {meeting.people.map((p, i) => (
                      <span key={p.id}>
                        {i ? ", " : ""}
                        <Link
                          href={`/people?person=${p.id}`}
                          onClick={() => onOpenChange(false)}
                          className="text-foreground hover:underline"
                        >
                          {displayName(p.fullName)}
                        </Link>
                      </span>
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              "Loading…"
            )}
          </DialogDescription>
          {meeting ? (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {meeting.shareLink ? (
                <a
                  href={meeting.shareLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-foreground hover:bg-muted"
                >
                  <ExternalLink className="size-3.5" /> Open in Wispr Flow
                </a>
              ) : null}
              <a
                href={`/api/meetings/${meeting.id}/md?tz=${encodeURIComponent(tz)}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-foreground hover:bg-muted"
              >
                <Download className="size-3.5" /> Download .md
              </a>
            </div>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {meeting === undefined ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : meeting === null ? (
            <p className="py-10 text-center text-[13px] text-muted-foreground">
              This meeting no longer exists.
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {meeting.summary ? <Section title="Summary" md={meeting.summary} /> : null}
              {meeting.notes ? <Section title="Notes" md={meeting.notes} /> : null}
              {!meeting.summary && !meeting.notes ? (
                <p className="text-[13px] text-muted-foreground">
                  The notetaker didn&apos;t produce a summary for this one.
                </p>
              ) : null}
              {meeting.transcript ? (
                <div>
                  <button
                    onClick={() => setShowTranscript((s) => !s)}
                    className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  >
                    Transcript
                    <ChevronDown
                      className={cn("size-3.5 transition-transform", showTranscript && "rotate-180")}
                    />
                  </button>
                  {showTranscript ? (
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-foreground/90">
                      {meeting.transcript}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, md }: { title: string; md: string }) {
  return (
    <section>
      <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <Markdown md={md} />
    </section>
  );
}

/**
 * Notetaker markdown. react-markdown never renders raw HTML, so the summary
 * can't inject markup; links open in a new tab and are marked nofollow.
 */
function Markdown({ md }: { md: string }) {
  return (
    <div
      className={cn(
        "text-[13.5px] leading-relaxed text-foreground",
        "[&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-[15px] [&_h1]:font-semibold",
        "[&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[14.5px] [&_h2]:font-semibold",
        "[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-[14px] [&_h3]:font-semibold",
        "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5 [&_a]:text-blue-600 [&_a]:underline dark:[&_a]:text-blue-400",
        "[&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[12.5px]",
        "[&>*:first-child]:mt-0",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}
