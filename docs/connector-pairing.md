# Connector pairing

Status: implemented in the connector-pairing release candidate. This flow is not a production
release until the release record and deployment verification say otherwise.

## Before you start

The local connector generates an Ed25519 key pair. Keep its private key on the connector machine.
The operator needs only these values from the local connector:

- a display name;
- the 43-character base64url public key;
- protocol version `1.0`;
- the least-privilege scopes and optional slug grants it needs.

Joining a cloud workspace does not grant access to Anytype, files, projects, prompts, or model
tools. Those permissions remain in the local Knot policy.

## Pair from the dashboard

1. Sign in and open **Connectors**.
2. Select **Start a pairing request**.
3. Enter the connector name and public key shown on the local machine.
4. Select only the requested scopes. Add comma-separated slug grants only when the connector needs
   them. A trailing `/*` includes descendants.
5. Select **Create request**.
6. Copy the pairing ID and poll token immediately. Knot Cloud stores only the token digest and will
   not show the raw token again. The request expires after ten minutes.
7. Give those one-time values to the local connector. Do not send a browser cookie, connector
   credential, or consumer API key to the poll endpoint.
8. Compare the connector name, complete public key, protocol version, scopes, and slug grants shown
   in the pending request with the local connector.
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

Pending polls can repeat. The first poll after approval, denial, or expiry returns the terminal
result and consumes the token. Later polls return `consumed`. A wrong token returns no pairing
information.

## Failure behavior

- An ordinary workspace member cannot create, approve, deny, rename, or revoke connectors.
- Approval cannot add scopes or slug grants that the connector did not request.
- A site grant must belong to the selected workspace.
- An expired or denied request cannot create a connector.
- A connector credential, consumer API key, browser cookie, or authorization header cannot replace
  the one-time poll token.
- Revocation is idempotent and permanently blocks that public key in the workspace.

The pairing route registers identity and cloud scopes only. Signed connector heartbeat and command
transport remain separate work in the implementation roadmap.
