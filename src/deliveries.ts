import { prisma } from "./db";
import { Delivery, DeliveryStatus, DeliveryStatusHistory, TemperatureReading } from "./generated/prisma/client";

export const include = {
  history: { orderBy: { at: "asc" } },
  temperatureLog: { orderBy: { at: "asc" } },
} as const;

export const COLD_CHAIN_RANGE = { min: 0, max: 8 };

const TRANSITIONS: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  ASSIGNED: ["IN_TRANSIT"],
  IN_TRANSIT: ["DELIVERED", "FAILED"],
  FAILED: ["IN_TRANSIT"],
};

export const canTransition = (from: DeliveryStatus, to: DeliveryStatus) => TRANSITIONS[from]?.includes(to) ?? false;

export const isColdChainBreach = (celsius: number) => celsius < COLD_CHAIN_RANGE.min || celsius > COLD_CHAIN_RANGE.max;

export const toJson = (d: Delivery & { history: DeliveryStatusHistory[]; temperatureLog: TemperatureReading[] }) => ({
  id: d.id,
  orderId: d.orderId,
  buyerId: d.buyerId,
  zone: d.zone,
  address: d.address,
  totalKg: d.totalKg,
  status: d.status,
  requiresColdChain: d.requiresColdChain,
  routeId: d.routeId ?? undefined,
  sequence: d.sequence ?? undefined,
  temperatureLog: d.temperatureLog.map(({ celsius, at }) => ({ celsius, at })),
  coldChainBreach: d.coldChainBreach,
  history: d.history.map(({ status, at }) => ({ status, at })),
  createdAt: d.createdAt,
});

export function setStatus(deliveryId: string, status: DeliveryStatus, extra: { routeId?: string; sequence?: number } = {}) {
  return prisma.delivery.update({
    where: { id: deliveryId },
    data: { status, ...extra, history: { create: { status } } },
    include,
  });
}
