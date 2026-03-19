export default function DesignSystemLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="bg-bg text-fg min-h-screen">
      <header className="bg-bg-subtle px-8 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Drafto Design System</h1>
        <p className="text-fg-muted text-sm">Tokens, typography, and component gallery</p>
      </header>
      <main className="mx-auto max-w-6xl px-8 py-10">{children}</main>
    </div>
  );
}
