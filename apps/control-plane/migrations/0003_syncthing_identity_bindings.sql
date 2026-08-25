CREATE TABLE "syncthing_identity_bindings" (
  "id" uuid PRIMARY KEY,
  "product_device_id" uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
  "hub_id" uuid NOT NULL REFERENCES "hubs" ("id"),
  "syncthing_device_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'verified',
  "verified_at" timestamptz NOT NULL DEFAULT now(),
  "last_observed_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);

CREATE UNIQUE INDEX "syncthing_identity_product_device_unique"
  ON "syncthing_identity_bindings" ("product_device_id");
CREATE UNIQUE INDEX "syncthing_identity_device_id_unique"
  ON "syncthing_identity_bindings" ("syncthing_device_id");
