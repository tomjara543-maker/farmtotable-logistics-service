# logistics-service

Entregas, rutas por zona y cadena de frío. Parte de **FarmToTable** (marketplace agrícola con microservicios orientados a eventos).

Estado: **Implementado** con PostgreSQL (Prisma) y RabbitMQ. Probado de punta a punta a través del API Gateway.

- Puerto local: `4005` · Ruta pública en el API Gateway: `/api/deliveries`
- Base de datos propia (`DATABASE_URL`), nunca compartida con otro servicio
- Eventos por RabbitMQ (exchange topic `farmtotable.events`, ver `src/events.ts`)

## Contrato REST

Es lo que ya consume el frontend (y lo que simula su modo demo en `src/lib/mock/server.ts` del repo del frontend).
El API Gateway valida el JWT y reenvía `x-user-id` / `x-user-role`; usa `requireUser()` de `src/auth.ts`.

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| `GET` | `/deliveries/mine` | BUYER | Entregas del comprador con `history[]` |
| `GET` | `/deliveries?status=` | ADMIN | Todas |
| `GET` | `/deliveries/routes` | ADMIN | Rutas |
| `POST` | `/deliveries/routes` | ADMIN | `{ zone }` agrupa las entregas PENDING de la zona (frío primero) → ASSIGNED |
| `PATCH` | `/deliveries/:id/status` | ADMIN | `{ status }` ASSIGNED→IN_TRANSIT→DELIVERED/FAILED, FAILED→IN_TRANSIT; 409 si no es válido |
| `POST` | `/deliveries/:id/temperature` | ADMIN | `{ celsius }` solo cadena de frío; fuera de 0–8 °C → `coldchain.breach` |

Errores: `{ "error": "mensaje" }` con 400 (validación zod), 401, 403, 404, 409 (estado inválido) o 422 (regla de negocio).

## Geolocalización

- Al crear una entrega (`payment.authorized`) la dirección se convierte en coordenadas con **Nominatim (OpenStreetMap)**, sin llave, respetando 1 petición por segundo y enviando un `User-Agent`. Si el servicio falla, se usa una aproximación por zona (`geoSource: "zone"`).
- `POST /deliveries/routes` ordena las paradas por **vecino más cercano** desde el centro de acopio (cadena de frío primero), calcula la distancia con la fórmula de Haversine y la guarda en `distanceKm`. La respuesta incluye `depot` y `stops[{ sequence, address, lat, lng, coldChain }]`.
- El frontend dibuja el mapa con Leaflet y teselas de OpenStreetMap.
- Por defecto todo está centrado en **Montería, Córdoba**: el centro de acopio en 8.7479, -75.8814 y las direcciones se buscan como "dirección, Montería, Córdoba, Colombia"; un resultado a más de 60 km del centro de acopio se descarta. Variables: `DEPOT_NAME`, `DEPOT_LAT`, `DEPOT_LNG` (centro de acopio), `GEOCODING_CITY`, `GEOCODING_MAX_KM` y `GEOCODING_ENABLED` (`false` desactiva Nominatim).

## Eventos

Publica:
- `delivery.created`
- `route.planned`
- `delivery.in_transit`
- `delivery.completed`
- `delivery.failed`
- `coldchain.breach`
- `delivery.cancelled`

Consume:
- `payment.authorized` → crea la entrega PENDING
- `order.cancelled` → CANCELLED

Todo consumidor debe envolverse en `idempotent()` (`src/db.ts`).

## Modelo de datos (Prisma)

- `Delivery` (id, orderId, buyerId, zone, address, totalKg, status, requiresColdChain, routeId, sequence, coldChainBreach)
- `DeliveryStatusHistory` (deliveryId, status, at)
- `TemperatureReading` (deliveryId, celsius, at)
- `Route` (id, zone, totalKg, requiresColdChain, createdAt)

## Desarrollo

```bash
cp .env.example .env    # ajusta DATABASE_URL
npm install
npm run db:migrate      # crea/aplica migraciones
npm run dev
```

## Despliegue

`Dockerfile` + `render.yaml` (Render) y `.github/workflows/ci.yml`: compila en cada push/PR y, en `main`,
publica la imagen en GHCR y dispara el deploy hook de Render si existe el secreto `RENDER_DEPLOY_HOOK_URL`.
