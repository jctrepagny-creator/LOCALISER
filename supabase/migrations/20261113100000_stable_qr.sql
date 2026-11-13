-- =====================================================================
-- 1. QR code d'installation stable : le secret est conservé (schéma privé,
--    lisible uniquement par les parents via get_child_setup) pour réafficher
--    le même QR code sans changer le mot de passe.
-- 2. Détection des iPhone refusés (mot de passe périmé) : auth_error_at.
-- 3. Pas d'alerte « silence » pour batterie faible quand le téléphone charge.
-- =====================================================================
alter table private.child_credentials add column secret_plain text;
alter table public.children add column auth_error_at timestamptz;

create or replace function private.new_child_secret(p_child_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user   text;
  v_secret text := private.random_code(24, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789');
begin
  select device_user into v_user from private.child_credentials where child_id = p_child_id;
  if v_user is null then
    v_user := 'enfant-' || lower(private.random_code(10, 'abcdefghijkmnpqrstuvwxyz23456789'));
    insert into private.child_credentials (child_id, device_user, secret_hash, secret_plain)
    values (p_child_id, v_user, private.sha256_hex(v_secret), v_secret);
  else
    update private.child_credentials
       set secret_hash = private.sha256_hex(v_secret), secret_plain = v_secret, synced_zone_names = '{}'
     where child_id = p_child_id;
    update public.children
       set zones_synced_version = -1, profile = null
     where id = p_child_id;
  end if;
  return jsonb_build_object('child_id', p_child_id, 'username', v_user, 'password', v_secret);
end;
$$;

-- Réafficher la configuration actuelle (même QR code). NULL si l'enfant a été
-- créé avant cette version : il faut alors générer un nouveau QR code une fois.
create function public.get_child_setup(p_child_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_family uuid;
  v_cred   private.child_credentials%rowtype;
begin
  select family_id into v_family from public.children where id = p_child_id;
  if v_family is null or not public.is_parent(v_family) then
    raise exception 'forbidden';
  end if;
  select * into v_cred from private.child_credentials where child_id = p_child_id;
  if v_cred.secret_plain is null then
    return null;
  end if;
  return jsonb_build_object('child_id', p_child_id, 'username', v_cred.device_user, 'password', v_cred.secret_plain);
end;
$$;

-- Appelée par la fonction owntracks quand un iPhone est refusé
create function public.svc_auth_failed(p_user text)
returns void
language sql security definer set search_path = ''
as $$
  update public.children set auth_error_at = now()
  where id = (select child_id from private.child_credentials where device_user = p_user);
$$;

-- Un envoi accepté efface l'erreur
create function private.clear_auth_error()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.last_seen_at is distinct from old.last_seen_at and new.auth_error_at is not null then
    new.auth_error_at := null;
  end if;
  return new;
end;
$$;

create trigger children_clear_auth_error
before update on public.children
for each row execute function private.clear_auth_error();

create or replace function private.check_silence()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c       public.children%rowtype;
  v_hours integer;
  v_since text;
begin
  for c in
    select * from public.children
    where last_seen_at is not null
      and not silence_alerted
      and (
        -- batterie presque vide (et pas en charge) au dernier signal : probablement éteint
        (coalesce(batt, 100) <= 10 and coalesce(batt_status, 1) not in (2, 3)
         and last_seen_at < now() - interval '30 minutes')
        or (idle_mode = 'reactif' and last_seen_at < now() - interval '30 minutes')
        or (idle_mode = 'eco' and last_seen_at < now() - interval '12 hours')
      )
  loop
    v_hours := floor(extract(epoch from now() - c.last_seen_at) / 3600);
    v_since := case when v_hours < 1
                 then floor(extract(epoch from now() - c.last_seen_at) / 60) || ' min'
                 else v_hours || ' h' end;
    insert into public.events (family_id, child_id, type, title, body, lat, lon)
    values (c.family_id, c.id, 'silence',
            '⚠️ Plus de nouvelles de ' || c.name,
            'Dernier signal il y a ' || v_since ||
              coalesce(' (batterie ' || c.batt || ' %)', '') ||
              '. Téléphone éteint, hors réseau ou OwnTracks fermé ?',
            c.lat, c.lon);
    update public.children set silence_alerted = true where id = c.id;
  end loop;
end;
$$;

revoke all on function public.get_child_setup(uuid) from public, anon;
grant execute on function public.get_child_setup(uuid) to authenticated;
revoke all on function public.svc_auth_failed(text) from public, anon, authenticated;
grant execute on function public.svc_auth_failed(text) to service_role;
