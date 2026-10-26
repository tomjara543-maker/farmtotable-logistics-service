import { setStatus } from "./deliveries";
import { idempotent, prisma } from "./db";
import { publish, subscribe } from "./events";

export async function registerConsumers() {
  await subscribe(
    "logistics-service",
    ["payment.authorized", "order.cancelled"],
    idempotent(async ({ eventType, data }) => {
      if (eventType === "payment.authorized") {
        if (await prisma.delivery.findUnique({ where: { orderId: data.orderId } })) return;
        const d = await prisma.delivery.create({
          data: {
            orderId: data.orderId,
            buyerId: data.buyerId,
            zone: data.deliveryZone,
            address: data.deliveryAddress,
            totalKg: data.totalKg,
            requiresColdChain: data.requiresColdChain,
            history: { create: { status: "PENDING" } },
          },
        });
        publish("delivery.created", { deliveryId: d.id, orderId: d.orderId, buyerId: d.buyerId, zone: d.zone });
      }

      if (eventType === "order.cancelled") {
        const open = await prisma.delivery.findMany({ where: { orderId: data.orderId, status: { notIn: ["DELIVERED", "CANCELLED"] } } });
        for (const d of open) {
          await setStatus(d.id, "CANCELLED");
          publish("delivery.cancelled", { deliveryId: d.id, orderId: d.orderId });
        }
      }
    }),
  );
}
