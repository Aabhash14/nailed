import { AdminShell } from "@/components/admin/admin-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: { default: "Admin", template: "%s | Admin" },
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-surface min-h-dvh">
      <AdminShell>{children}</AdminShell>
    </div>
  );
}
