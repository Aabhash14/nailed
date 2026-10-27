import { OrderDetail } from "@/components/admin/order-detail";

export const metadata = { title: "Order" };

/** Target of the Telegram new-order link (`/admin/orders/<id>`, src/lib/notify/telegram.ts). */
export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetail orderId={id} />;
}
