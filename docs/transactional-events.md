# Transactional channel events

Status: implementation candidate on the P2b branch. Do not treat these routes as deployed until the
release record says so.

Knot Cloud can accept one bounded channel-origin pointer and fan it out to named webhook
destinations. A pointer contains only `spaceId`, `chatId`, and `messageId`. It is not proof of the
sender's identity or authority. A local Knot connector must fetch that message from Anytype and
authorize its native participant before an effect.

## Pre-approved destinations

Operators configure destinations at deployment time. Tenants select a name; API callers never
supply a URL, headers, or signing secret.

```json
{
  "automation": {
    "url": "https://hooks.example.net/knot/events",
    "secret": "replace-with-at-least-32-random-characters"
  }
}
```

Store that object in `WEBHOOK_DESTINATIONS_JSON`. URLs must use a public hostname and fixed HTTPS
path without embedded credentials, a query, or a fragment. Literal IP addresses and local names
are rejected. Removing a name causes its pending deliveries to dead-letter; it does not redirect
them elsewhere.

`WEBHOOK_MAX_ACTIVE_SUBSCRIPTIONS` sets the hard per-workspace active-subscription cap (default
`50`, maximum `1000`). Creation is serialized per workspace, so concurrent requests cannot exceed
the cap. Knot rejects duplicate active routes and duplicate subscription names with a conflict
response instead of creating ambiguous fan-out.

Workspace owners and admins create subscriptions with `POST /api/v1/session/webhooks`:

```json
{
  "name": "Channel automation",
  "destinationName": "automation",
  "eventTypes": ["channel.message.available"],
  "connectorIds": ["00000000-0000-4000-8000-000000000011"]
}
```

Use `GET /api/v1/session/webhooks` to list them and
`DELETE /api/v1/session/webhooks/<subscription-id>` to disable one.

## Accept an event

`POST /api/v1/events` uses a consumer API key with `anytype.chats.read`, bound to the selected
connector. The request is small, typed, time-bounded, and idempotent:

```json
{
  "protocolVersion": "1.0",
  "connectorId": "00000000-0000-4000-8000-000000000011",
  "idempotencyKey": "channel-event-00000001",
  "createdAt": 1788192000,
  "occurredAt": 1788192000,
  "eventType": "channel.message.available",
  "channelOrigin": {
    "spaceId": "space-id",
    "chatId": "chat-id",
    "messageId": "message-id"
  }
}
```

Postgres commits the event and its delivery rows together. Reusing the same idempotency key and
semantic body returns the original event; `createdAt` may change when a client retries. Reusing the
key with a different origin or event fails. A replay does not consume another API-key quota unit.
New events use the API key's durable per-minute and per-day limits. Delivery claims use a lease
fence, bounded exponential backoff, at most ten attempts, and a terminal dead-letter state. The
maintenance route only drives this durable outbox; it is not another workflow scheduler.
Neither webhook delivery nor a Cloud session can approve or modify a workflow or satisfy a local
management-authority check.

## Delivery verification

Every POST body is a canonical, bounded envelope. Verify `Knot-Signature` as HMAC-SHA256 over
`knot-webhook-hmac-sha256-v1`, the `Knot-Timestamp`, `Knot-Delivery-Id`, and the exact canonical
body. Deduplicate on `Knot-Delivery-Id`. Reject stale timestamps before doing work.

Webhook delivery means only that an origin pointer arrived. It never authorizes `chat.send`. The
corresponding local workflow must refetch the message from Anytype and apply its configured native
participant allowlist immediately before the effect.
