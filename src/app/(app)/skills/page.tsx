import { ChevronRight } from "lucide-react";
import { listSkills, type Skill } from "@/lib/skills";
import { SkillsHashOpener } from "@/components/skills-hash-opener";

/**
 * The full text of every Claude Code skill, at a stable URL.
 *
 * This page exists to be *read by an agent*, not just by a person. Settings is
 * client state with no URL, so nothing can link an agent at it; this can be
 * fetched directly. It sits behind the passcode like every other route.
 *
 * Each skill renders as a collapsed <details> row — collapsed only visually:
 * the full body is always in the HTML, so agents fetching this page get
 * everything regardless of the disclosure state. Bodies stay preformatted
 * markdown; the source text is what an agent needs, and rendering it would
 * only lose fidelity.
 */
export const metadata = {
  title: "Skills · Rontext",
  description:
    "Claude Code skills for running this app's connectors and maintenance scripts.",
};

/** Enough of the description to identify the skill; the rest is inside. */
function firstSentence(text: string): string {
  return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
}

function SkillRow({ skill }: { skill: Skill }) {
  return (
    <details
      id={skill.name}
      className="group scroll-mt-4 border-b border-border last:border-b-0"
    >
      <summary className="flex cursor-pointer items-baseline gap-2.5 px-5 py-3 transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 translate-y-[2px] text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="shrink-0 font-mono text-[13.5px] font-semibold text-foreground">
          /{skill.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
          {firstSentence(skill.description)}
        </span>
      </summary>
      <div className="px-5 pb-6 pl-11">
        {skill.description ? (
          <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
            {skill.description}
          </p>
        ) : null}
        <pre className="mt-3 max-w-3xl overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-4 font-mono text-[12px] leading-relaxed text-foreground">
          {skill.body}
        </pre>
      </div>
    </details>
  );
}

export default async function SkillsPage() {
  const skills = listSkills();
  const workflow = skills.filter((s) => s.group === "workflow");
  const reference = skills.filter((s) => s.group === "reference");

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-foreground">Skills</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        {skills.length === 0 ? (
          <div className="px-6 pt-16 text-center text-[13.5px] text-muted-foreground">
            No skills found on disk — see{" "}
            <code className="font-mono">web/.claude/skills</code> and{" "}
            <code className="font-mono">outputFileTracingIncludes</code> in
            next.config.ts.
          </div>
        ) : (
          <>
            <p className="px-5 pt-4 pb-2 text-[12.5px] text-muted-foreground">
              Claude Code skills, read straight off disk from{" "}
              <code className="font-mono">web/.claude/skills</code>.
            </p>

            <SectionHeading label="Workflow" />
            {workflow.map((s) => (
              <SkillRow key={s.name} skill={s} />
            ))}

            {reference.length ? (
              <>
                <SectionHeading label="Reference · from a plugin" />
                {reference.map((s) => (
                  <SkillRow key={s.name} skill={s} />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
      <SkillsHashOpener />
    </div>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <div className="border-b border-border bg-muted/50 px-5 py-1.5">
      <h2 className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h2>
    </div>
  );
}
