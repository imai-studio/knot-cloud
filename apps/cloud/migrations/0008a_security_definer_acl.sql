-- Repair SECURITY DEFINER ACLs after earlier migrations transferred ownership
-- before applying grants. Each owner performs its own ACL changes.

SELECT set_config('knot.migration_role', current_user, true);

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

SELECT set_config('role', current_setting('knot.migration_role'), true);
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

SELECT set_config('role', current_setting('knot.migration_role'), true);
REVOKE knot_bootstrap FROM CURRENT_USER GRANTED BY CURRENT_USER;

GRANT knot_pairing TO CURRENT_USER;
SET LOCAL ROLE knot_pairing;

REVOKE ALL ON FUNCTION public.poll_pairing_session(uuid, text, timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poll_pairing_session(uuid, text, timestamptz)
TO knot_app;

SELECT set_config('role', current_setting('knot.migration_role'), true);
REVOKE knot_pairing FROM CURRENT_USER GRANTED BY CURRENT_USER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc AS function
    JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = 'public'
      AND function.prosecdef
      AND (
        EXISTS (
          SELECT 1
          FROM aclexplode(
            coalesce(function.proacl, acldefault('f', function.proowner))
          ) AS privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM aclexplode(
            coalesce(function.proacl, acldefault('f', function.proowner))
          ) AS privilege
          WHERE privilege.grantee = 'knot_app'::regrole
            AND privilege.privilege_type = 'EXECUTE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Unsafe SECURITY DEFINER function ACL remains after repair';
  END IF;
END
$$;
