import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, request, Running, startApp } from "./helpers";

let api: Running;

before(async () => {
  const { createApp } = await import("../src/app");
  api = await startApp(createApp());
});

after(() => api.close());

test("planificar rutas es exclusivo del administrador", async () => {
  const anonymous = await request(api.url, "/deliveries/routes", { method: "POST", body: { zone: "Norte" } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, "Debes iniciar sesión");

  const buyer = await request(api.url, "/deliveries/routes", { method: "POST", headers: as("b-1", "BUYER"), body: { zone: "Norte" } });
  assert.equal(buyer.status, 403);

  const producer = await request(api.url, "/deliveries/mine", { headers: as("p-1", "PRODUCER") });
  assert.equal(producer.status, 403);
});

test("POST /deliveries/routes exige una zona y responde el error en JSON", async () => {
  const res = await request(api.url, "/deliveries/routes", { method: "POST", headers: as("admin-1", "ADMIN"), body: { zone: "   " } });

  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type")!, /application\/json/);
  assert.match(res.body.error, /El campo zone es obligatorio/);

  const health = await request(api.url, "/health");
  assert.deepEqual(health.body, { service: "logistics-service", status: "ok" });
});
