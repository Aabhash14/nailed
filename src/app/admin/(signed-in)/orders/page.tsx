import { redirect } from "next/navigation";

/** Orders live on Today's orders (/admin); only single orders have their own page. */
export default function AdminOrdersIndex() {
  redirect("/admin");
}
