import { AdminStatusProvider, PausedBanner } from "@/components/admin/admin-status";
import { getPublicSettingsSafe } from "@/data-access/public-server";

/**
 * Every signed-in admin page (not /admin/login, so an anonymous visitor never causes this read). Reads the public
 * settings once per full page load for the "orders paused" banner and the staff notice field; client code calls
 * router.refresh() to read them again (see AdminStatusProvider).
 */
export default async function SignedInAdminLayout({ children }: { children: React.ReactNode }) {
  const s = await getPublicSettingsSafe();
  return (
    <AdminStatusProvider initial={{ ordersPaused: s?.ordersPaused === true, announcement: s?.announcement ?? null, known: s !== null }}>
      <PausedBanner />
      {children}
    </AdminStatusProvider>
  );
}
