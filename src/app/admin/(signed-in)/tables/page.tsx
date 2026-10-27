import { TablesBoard } from "@/components/admin/tables/tables-board";

export const metadata = { title: "Tables" };

/** Thin shell: the board is a client component fed by the change-only feed (ADR 0002 free-tier rule 1). */
export default function AdminTablesPage() {
  return <TablesBoard />;
}
