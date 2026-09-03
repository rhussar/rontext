/**
 * What a demo deployment renders when its database lacks the seed marker.
 * Deliberately shows nothing from the database: the point is that a wrong
 * DATABASE_URL on the demo project surfaces as this page, never as data.
 */
export function DemoNotSeeded() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold text-foreground">
          Demo not seeded
        </h1>
        <p className="pt-2 text-[13.5px] leading-relaxed text-muted-foreground">
          This deployment runs in demo mode, but the connected database has no
          demo data. Run the seed script against the demo database and reload.
        </p>
        <pre className="mt-4 rounded-lg bg-background px-3 py-2 text-left text-[12px] text-foreground">
          npm run seed:demo
        </pre>
      </div>
    </main>
  );
}
