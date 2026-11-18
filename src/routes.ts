import { Router } from "express";
import { z } from "zod";
import { requireUser, userOf } from "./auth";
import { canTransition, COLD_CHAIN_RANGE, include, isColdChainBreach, setStatus, toJson } from "./deliveries";
import { prisma } from "./db";
import { publish } from "./events";
import { DeliveryStatus } from "./generated/prisma/client";
import { HttpError, notFound, round2 } from "./http";

const STATUSES = Object.values(DeliveryStatus) as string[];

const statusEvents: Partial<Record<DeliveryStatus, string>> = {
  IN_TRANSIT: "delivery.in_transit",
  DELIVERED: "delivery.completed",
  FAILED: "delivery.failed",
};

const zoneSchema = z.object({ zone: z.string().trim().min(1, "El campo zone es obligatorio") });
const statusSchema = z.object({ status: z.enum(DeliveryStatus, "Estado inválido") });
const temperatureSchema = z.object({ celsius: z.coerce.number().min(-30, "Temperatura inválida").max(50, "Temperatura inválida") });

async function findDelivery(id: string) {
  const d = await prisma.delivery.findUnique({ where: { id }, include });
  if (!d) throw notFound("Entrega");
  return d;
}

export function logisticsRoutes() {
  const router = Router();

  router.get("/mine", requireUser("BUYER"), async (_req, res) => {
    const list = await prisma.delivery.findMany({ where: { buyerId: userOf(res).id }, include, orderBy: { createdAt: "desc" } });
    res.json(list.map(toJson));
  });

  router.get("/", requireUser("ADMIN"), async (req, res) => {
    const status = typeof req.query.status === "string" && STATUSES.includes(req.query.status) ? (req.query.status as DeliveryStatus) : undefined;
    const list = await prisma.delivery.findMany({ where: { status }, include, orderBy: { createdAt: "desc" } });
    res.json(list.map(toJson));
  });

  router.get("/routes", requireUser("ADMIN"), async (_req, res) => {
    const routes = await prisma.route.findMany({
      include: { deliveries: { select: { id: true, sequence: true }, orderBy: { sequence: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      routes.map(({ deliveries, ...r }) => ({ ...r, deliveryIds: deliveries.map((d) => d.id) })),
    );
  });

  router.post("/routes", requireUser("ADMIN"), async (req, res) => {
    const { zone } = zoneSchema.parse(req.body);
    const pending = await prisma.delivery.findMany({ where: { zone, status: "PENDING" }, orderBy: { createdAt: "asc" } });
    if (pending.length === 0) throw new HttpError(422, `No hay entregas pendientes en la zona ${zone}`);
    pending.sort((a, b) => Number(b.requiresColdChain) - Number(a.requiresColdChain));

    const route = await prisma.$transaction(async (tx) => {
      const r = await tx.route.create({
        data: { zone, totalKg: round2(pending.reduce((s, d) => s + d.totalKg, 0)), requiresColdChain: pending.some((d) => d.requiresColdChain) },
      });
      for (const [i, d] of pending.entries()) {
        await tx.delivery.update({
          where: { id: d.id },
          data: { status: "ASSIGNED", routeId: r.id, sequence: i + 1, history: { create: { status: "ASSIGNED" } } },
        });
      }
      return r;
    });
    const deliveryIds = pending.map((d) => d.id);
    publish("route.planned", { routeId: route.id, zone, deliveries: deliveryIds.length, deliveryIds });
    res.status(201).json({ ...route, deliveryIds });
  });

  router.patch("/:id/status", requireUser("ADMIN"), async (req, res) => {
    const d = await findDelivery(String(req.params.id));
    const { status } = statusSchema.parse(req.body);
    if (!canTransition(d.status, status)) throw new HttpError(409, `No se puede pasar de ${d.status} a ${status}`);
    const updated = await setStatus(d.id, status);
    const event = statusEvents[status];
    if (event) publish(event, { deliveryId: d.id, orderId: d.orderId, buyerId: d.buyerId });
    res.json(toJson(updated));
  });

  router.post("/:id/temperature", requireUser("ADMIN"), async (req, res) => {
    const d = await findDelivery(String(req.params.id));
    const { celsius } = temperatureSchema.parse(req.body);
    if (!d.requiresColdChain) throw new HttpError(422, "Esta entrega no requiere cadena de frío");
    const breach = isColdChainBreach(celsius);
    const updated = await prisma.delivery.update({
      where: { id: d.id },
      data: { temperatureLog: { create: { celsius } }, ...(breach ? { coldChainBreach: true } : {}) },
      include,
    });
    if (breach) publish("coldchain.breach", { deliveryId: d.id, orderId: d.orderId, celsius, range: COLD_CHAIN_RANGE });
    res.status(201).json(toJson(updated));
  });

  return router;
}
