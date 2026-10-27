import { AlertsView } from "@/components/admin/alerts/alerts-view";

export const metadata = { title: "Alerts" };

/** Owner only (api-contract 2.2.0 section 9.10); listAlerts / markAlertsRead enforce it on the server. */
export default function AdminAlertsPage() {
  return <AlertsView />;
}
