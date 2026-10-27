import { TablesSetup } from "@/components/admin/tables/tables-setup";

export const metadata = { title: "Tables setup" };

/** Owner only (the component explains to staff; saveCafeTables / setTableOrdering enforce it on the server). */
export default function AdminTablesSetupPage() {
  return <TablesSetup />;
}
