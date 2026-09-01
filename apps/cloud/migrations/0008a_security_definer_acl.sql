-- Repair SECURITY DEFINER ACLs after earlier migrations transferred ownership
-- before applying grants. Each owner performs its own ACL changes.

GRANT knot_resolver TO CURRENT_USER;
SET LOCAL ROLE knot_resolver;

REVOKE ALL ON FUNCTION public.resolve_connector(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_api_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_invitation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_command(
  uuid,
  uuid,
  uuid,
  integer,
  timestamptz,
  text,
  public.command_state,
  jsonb,
  text,
  boolean,
  integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.resolve_connector(uuid) TO knot_app;
GRANT EXECUTE ON FUNCTION public.resolve_api_key(text) TO knot_app;
GRANT EXECUTE ON FUNCTION public.resolve_invitation(text) TO knot_app;
GRANT EXECUTE ON FUNCTION public.complete_command(
  uuid,
  uuid,
  uuid,
  integer,
  timestamptz,
  text,
  public.command_state,
  jsonb,
  text,
  boolean,
  integer
) TO knot_app;

RESET ROLE;
REVOKE knot_resolver FROM CURRENT_USER GRANTED BY CURRENT_USER;

GRANT knot_bootstrap TO CURRENT_USER;
SET LOCAL ROLE knot_bootstrap;

REVOKE ALL ON FUNCTION public.resolve_or_bootstrap_workspace(
  text,
  text,
  text,
  smallint,
  text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.select_workspace_for_session(text, text, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.resolve_or_bootstrap_workspace(
  text,
  text,
  text,
  smallint,
  text
) TO knot_app;
GRANT EXECUTE ON FUNCTION public.select_workspace_for_session(text, text, uuid)
TO knot_app;

RESET ROLE;
REVOKE knot_bootstrap FROM CURRENT_USER GRANTED BY CURRENT_USER;

GRANT knot_pairing TO CURRENT_USER;
SET LOCAL ROLE knot_pairing;

REVOKE ALL ON FUNCTION public.poll_pairing_session(uuid, text, timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poll_pairing_session(uuid, text, timestamptz)
TO knot_app;

RESET ROLE;
REVOKE knot_pairing FROM CURRENT_USER GRANTED BY CURRENT_USER;
