import assert from "node:assert/strict";
import { test } from "node:test";
import { canTransition, isColdChainBreach } from "../src/deliveries";

test("canTransition solo permite el flujo asignada → en ruta → entregada/fallida y reintentos", () => {
  assert.equal(canTransition("ASSIGNED", "IN_TRANSIT"), true);
  assert.equal(canTransition("IN_TRANSIT", "DELIVERED"), true);
  assert.equal(canTransition("IN_TRANSIT", "FAILED"), true);
  assert.equal(canTransition("FAILED", "IN_TRANSIT"), true);

  assert.equal(canTransition("PENDING", "IN_TRANSIT"), false);
  assert.equal(canTransition("ASSIGNED", "DELIVERED"), false);
  assert.equal(canTransition("DELIVERED", "IN_TRANSIT"), false);
});

test("isColdChainBreach detecta temperaturas fuera del rango 0–8 °C", () => {
  for (const ok of [0, 4.5, 8]) assert.equal(isColdChainBreach(ok), false, `${ok} °C debería estar en rango`);
  for (const bad of [-0.1, 8.1, 15]) assert.equal(isColdChainBreach(bad), true, `${bad} °C debería ser ruptura`);
});
