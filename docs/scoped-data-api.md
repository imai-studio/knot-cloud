# Scoped Anytype data API

This guide covers the P4 implementation in this branch. It is not part of the deployed release
until [`releases.md`](releases.md) records it.

## Credential setup

An owner or admin opens **API keys** in the dashboard and creates a key with:

- one or more Anytype scopes;
- one or more connector UUIDs;
- per-minute and per-day request limits;
- an optional expiry.

Every selected connector must be active and grant every scope on the key. Knot shows the secret
once. Store it in the calling service's secret manager. Rotation invalidates the previous secret
immediately. Revocation is permanent.

Set `API_KEY_PEPPER` to at least 32 random characters. Increment `API_KEY_PEPPER_VERSION` when the
pepper changes. During a controlled rotation, set `API_KEY_PEPPER_PREVIOUS` to the old pepper. A
request authenticated with the old digest is rehashed with the current pepper after verification.
Remove the previous pepper after all active keys have been used or rotated.

## Submit an operation

Send `POST /api/v1/operations` with `Authorization: Bearer <key>` and
`Content-Type: application/json`:

```json
{
  "protocolVersion": "1.0",
  "connectorId": "00000000-0000-4000-8000-000000000003",
  "idempotencyKey": "customer-sync-2026-09-01-001",
  "createdAt": 1788264000,
  "expiresAt": 1788264600,
  "operation": {
    "type": "object.read",
    "spaceId": "space-id",
    "objectId": "object-id"
  }
}
```

The route accepts only the typed operation union in `@imai/knot-cloud-contract`. It does not accept
prompts, shell commands, paths, tools, or arbitrary HTTP requests. A successful request returns `202`
with an operation ID and status URL. An exact retry with the same idempotency key returns the same
operation. Reusing the key with another payload returns `409`.

The database checks the key scope, connector binding, connector scope, expiry, quota, and tenant in
the same transaction that creates the command. The local connector still applies its own policy
before execution.

## Read status

Send `GET /api/v1/operations/{operationId}` with the same API key. The response can be pending,
processing, succeeded, rejected by local policy, failed, expired, cancelled, or dead-lettered. A key
cannot read an operation created by another key or tenant.

## Human API routes

The dashboard uses human-session routes. They require an owner or admin workspace role. Mutations
also require a trusted browser origin.

| Method | Route                                        | Purpose           |
| ------ | -------------------------------------------- | ----------------- |
| GET    | `/api/v1/session/api-keys`                   | List key metadata |
| POST   | `/api/v1/session/api-keys`                   | Create a key      |
| GET    | `/api/v1/session/api-keys/{apiKeyId}`        | Inspect one key   |
| POST   | `/api/v1/session/api-keys/{apiKeyId}/rotate` | Rotate its secret |
| DELETE | `/api/v1/session/api-keys/{apiKeyId}`        | Revoke the key    |

Secrets are returned only by create and rotate responses. List, inspect, audit, and operation
responses never include a secret or digest.
