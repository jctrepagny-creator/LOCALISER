-- =====================================================================
-- État d'un enfant, consulté par la page d'installation sur son iPhone
-- (coche verte quand la première position arrive). Clé = "<utilisateur>:<secret>".
-- =====================================================================
create function public.svc_child_status(p_key text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_user  text := split_part(coalesce(p_key, ''), ':', 1);
  v_pass  text := substr(coalesce(p_key, ''), length(split_part(coalesce(p_key, ''), ':', 1)) + 2);
  v_cred  private.child_credentials%rowtype;
  v_child public.children%rowtype;
begin
  select * into v_cred from private.child_credentials where device_user = v_user;
  if not found or v_cred.secret_hash <> private.sha256_hex(v_pass) then
    raise exception 'invalid_credentials' using errcode = '28000';
  end if;
  select * into v_child from public.children where id = v_cred.child_id;
  return jsonb_build_object(
    'name', v_child.name,
    'username', v_user,
    'last_seen_at', v_child.last_seen_at,
    'last_fix_at', v_child.last_fix_at,
    'batt', v_child.batt
  );
end;
$$;

revoke all on function public.svc_child_status(text) from public, anon, authenticated;
grant execute on function public.svc_child_status(text) to service_role;
