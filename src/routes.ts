import { Router } from "express";
import { z } from "zod";
import { requireUser, userOf } from "./auth";
import { canTransition, COLD_CHAIN_RANGE, include, isColdChainBreach, setStatus, toJson } from "./deliveries";
import { prisma } from "./db";
import { publish } from "./events";
import { approximateByZone, depot, haversineKm, locate, nearestNeighborOrder, routeDistanceKm } from "./geo";
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
      include: { deliveries: { select: { id: true, sequence: true, address: true, lat: true, lng: true, requiresColdChain: true }, orderBy: { sequence: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      routes.map(({ deliveries, ...r }) => ({
        ...r,
        distanceKm: r.distanceKm ?? undefined,
        deliveryIds: deliveries.map((d) => d.id),
        depot: depot(),
        stops: deliveries
          .filter((d) => d.lat != null && d.lng != null)
          .map((d) => ({ id: d.id, sequence: d.sequence, address: d.address, lat: d.lat, lng: d.lng, coldChain: d.requiresColdChain })),
      })),
    );
  });

  router.post("/routes", requireUser("ADMIN"), async (req, res) => {
    const { zone } = zoneSchema.parse(req.body);
    const pending = await prisma.delivery.findMany({ where: { zone, status: "PENDING" }, orderBy: { createdAt: "asc" } });
    if (pending.length === 0) throw new HttpError(422, `No hay entregas pendientes en la zona ${zone}`);
    const origin = depot();
    let lookups = 0;
    const located = [];
    for (const d of pending) {
      const precise =
        d.lat != null &&
        d.lng != null &&
        d.geoSource === "nominatim" &&
        haversineKm({ lat: d.lat, lng: d.lng }, origin) <= Number(process.env.GEOCODING_MAX_KM ?? 60);
      if (precise) {
        located.push({ d, lat: d.lat!, lng: d.lng!, changed: false });
        continue;
      }
      const p = lookups++ < 10 ? await locate(d.address, zone) : approximateByZone(zone, d.address);
      located.push({ d, lat: p.lat, lng: p.lng, changed: true, source: p.source });
    }
    const cold = nearestNeighborOrder(origin, located.filter((s) => s.d.requiresColdChain));
    const rest = nearestNeighborOrder(cold.at(-1) ?? origin, located.filter((s) => !s.d.requiresColdChain));
    const ordered = [...cold, ...rest];
    const distanceKm = routeDistanceKm(origin, ordered);

    const route = await prisma.$transaction(async (tx) => {
      const r = await tx.route.create({
        data: { zone, distanceKm, totalKg: round2(pending.reduce((s, d) => s + d.totalKg, 0)), requiresColdChain: pending.some((d) => d.requiresColdChain) },
      });
      for (const [i, s] of ordered.entries()) {
        await tx.delivery.update({
          where: { id: s.d.id },
          data: {
            status: "ASSIGNED",
            routeId: r.id,
            sequence: i + 1,
            ...(s.changed ? { lat: s.lat, lng: s.lng, geoSource: s.source } : {}),
            history: { create: { status: "ASSIGNED" } },
          },
        });
      }
      return r;
    });
    const deliveryIds = ordered.map((s) => s.d.id);
    publish("route.planned", { routeId: route.id, zone, deliveries: deliveryIds.length, deliveryIds });
    res.status(201).json({
      ...route,
      distanceKm,
      deliveryIds,
      depot: origin,
      stops: ordered.map((s, i) => ({ id: s.d.id, sequence: i + 1, address: s.d.address, lat: s.lat, lng: s.lng, coldChain: s.d.requiresColdChain })),
    });
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
