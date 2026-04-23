import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold tracking-tight">
        Universal MCP Orchestration Hub
      </h1>
      <p className="mt-4 text-lg text-muted-foreground">
        A universal, intelligent, self-provisioning MCP orchestration platform.
      </p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/dashboard"
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
        >
          Dashboard
        </Link>
        <Link
          href="/login"
          className="rounded-md border px-4 py-2 hover:bg-accent"
        >
          Sign In
        </Link>
      </div>
    </main>
  );
}
