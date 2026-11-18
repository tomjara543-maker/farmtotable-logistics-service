-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN "lat" DOUBLE PRECISION,
ADD COLUMN "lng" DOUBLE PRECISION,
ADD COLUMN "geo_source" TEXT;

-- AlterTable
ALTER TABLE "routes" ADD COLUMN "distance_km" DOUBLE PRECISION;
