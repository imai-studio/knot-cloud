# Connector pairing

Status: implemented in the connector-pairing release candidate. This flow is not a production
release until the release record and deployment verification say otherwise.

## Before you start

The local connector generates an Ed25519 key pair. Keep its private key on the connector machine.
The operator needs only these values from the local connector:

- a display name;
- the 43-character base64url public key;
- protocol version `1.0`;
- the scopes, sites, and optional slug grants it needs.

Joining a cloud workspace does not grant access to Anytype, files, projects, prompts, or model
tools. Those permissions remain in the local Knot policy.

## Pair from the dashboard

1. Sign in and open **Connectors**.
2. Select **Start a pairing request**.
3. Enter the connector name and public key shown on the local machine.
4. Select only the requested scopes and sites. Add slug grants only when the connector needs them.
   Separate slugs with commas. A trailing `/*` includes descendants.
5. Select **Create request**.
6. Copy the pairing ID and poll token immediately. Knot Cloud stores only the token digest and will
   not show the raw token again. The request expires after ten minutes.
7. Give those one-time values to the local connector. Do not send a browser cookie, connector
   credential, or consumer API key to the poll endpoint.
8. Compare the connector name, full public key, protocol version, scopes, sites, and slug grants
   with the values on the local machine.
9. Select **Approve exact request** or **Deny**.

Approval creates one connector for that workspace and public key. Retrying the same approval or
approving a second request for the same active public key reuses the connector. A revoked public key
cannot be paired again.

## Protocol flow

The browser uses its verified human session:

- `POST /api/v1/pairing/sessions` creates a request and returns the raw poll token once.
- `GET /api/v1/pairing/sessions` lists review records without the poll token or its digest.
- `PUT /api/v1/pairing/sessions/{pairingId}` approves or denies the request.
- `GET /api/v1/connectors` lists workspace connectors.
- `PATCH /api/v1/connectors/{connectorId}` changes a display name.
- `DELETE /api/v1/connectors/{connectorId}` permanently revokes a connector.

The local connector uses only:

- `POST /api/v1/pairing/poll` with the pairing ID and one-time poll token in the versioned JSON
  body.

Pending polls can repeat. Knot Cloud allows 30 poll attempts per minute for each address reported by
Vercel. Requests without a Vercel client-address header share one fallback bucket. The route stops
with `503` if Upstash is unavailable instead of accepting an unthrottled poll.

The first poll after approval or denial returns the result and consumes the token. The result
expires ten minutes after the operator decides. Polling after that returns `expired` and consumes
the token. Later polls return `consumed`. A malformed pairing ID, an unknown pairing ID, and a wrong
token all return the same `401` response.

The review list never includes the poll token or its digest. It shows whether the local connector
retrieved the result or missed its deadline. When an owner loads this list, Knot Cloud removes
records whose result expired more than 30 days earlier and returns at most 50 recent records.

## Failure behavior

- An ordinary workspace member cannot create, approve, deny, rename, or revoke connectors.
- Approval cannot add scopes, sites, or slug grants that the connector did not request.
- A site grant must belong to the selected workspace.
- An expired or denied request cannot create a connector.
- A connector credential, consumer API key, browser cookie, or authorization header cannot replace
  the one-time poll token.
- Revocation is idempotent and permanently blocks that public key in the workspace.

Site and slug grants limit Knot Cloud operations. They do not grant local Anytype, filesystem, or
agent access. The local Knot policy still decides whether to run each command.

The pairing route registers identity and cloud grants only. Signed connector heartbeat and command
transport remain separate work in the implementation roadmap.
