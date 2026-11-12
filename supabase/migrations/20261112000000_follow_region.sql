-- =====================================================================
-- Relance automatique d'OwnTracks : zone « +follow » envoyée aux iPhone.
-- Une zone de géorepérage qui suit l'enfant ; à chaque sortie, iOS
-- réveille / relance OwnTracks en arrière-plan, même après une fermeture.
-- =====================================================================

-- Les noms de zones de la famille ne peuvent pas commencer par « + »
-- (réservé aux zones spéciales d'OwnTracks)
alter table public.zones
  add constraint zones_name_not_special check (left(name, 1) <> '+');

create or replace function public.svc_ingest_owntracks(p_user text, p_secret text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_cred      private.child_credentials%rowtype;
  v_child     public.children%rowtype;
  v_family    public.families%rowtype;
  v_type      text := p_payload ->> '_type';
  v_lat       double precision;
  v_lon       double precision;
  v_acc       integer;
  v_batt      smallint;
  v_tst       timestamptz;
  v_resp      jsonb := '[]'::jsonb;
  v_watching  boolean;
  v_desired   text;
  v_m         integer;
  v_zone      public.zones%rowtype;
  v_names     text[];
  v_waypoints jsonb;
begin
  select * into v_cred from private.child_credentials where device_user = p_user;
  if not found or v_cred.secret_hash <> private.sha256_hex(coalesce(p_secret, '')) then
    raise exception 'invalid_credentials' using errcode = '28000';
  end if;

  select * into v_child from public.children where id = v_cred.child_id for update;
  select * into v_family from public.families where id = v_child.family_id;

  update public.children
     set last_seen_at = now(), silence_alerted = false
   where id = v_child.id;

  if v_type = 'location' and p_payload ? 'lat' and p_payload ? 'lon' then
    v_lat  := (p_payload ->> 'lat')::double precision;
    v_lon  := (p_payload ->> 'lon')::double precision;
    v_acc  := round((p_payload ->> 'acc')::numeric)::integer;
    v_batt := (p_payload ->> 'batt')::smallint;
    v_m    := (p_payload ->> 'm')::integer;
    v_tst  := to_timestamp(coalesce((p_payload ->> 'tst')::double precision, extract(epoch from now())));
    if v_tst > now() + interval '5 minutes' then
      v_tst := now();
    end if;

    insert into public.locations (child_id, family_id, lat, lon, acc, vel, batt, trigger, recorded_at)
    values (v_child.id, v_child.family_id, v_lat, v_lon, v_acc,
            round((p_payload ->> 'vel')::numeric)::integer, v_batt,
            p_payload ->> 't', v_tst);

    if v_child.last_fix_at is null or v_tst >= v_child.last_fix_at then
      update public.children
         set lat = v_lat, lon = v_lon, acc = v_acc,
             vel = round((p_payload ->> 'vel')::numeric)::integer,
             last_fix_at = v_tst,
             batt = coalesce(v_batt, batt),
             batt_status = coalesce((p_payload ->> 'bs')::smallint, batt_status),
             conn = coalesce(p_payload ->> 'conn', conn)
       where id = v_child.id;
      perform private.check_battery(v_child.id);
      perform private.update_zone_presence(v_child.id, v_child.family_id, v_lat, v_lon, v_acc);
    end if;

  elsif v_type = 'transition' then
    -- Événement natif iOS d'entrée / sortie de zone (géorepérage)
    select * into v_zone from public.zones
    where family_id = v_child.family_id and name = p_payload ->> 'desc';
    if found and p_payload ->> 'event' in ('enter', 'leave') then
      perform private.set_presence(
        v_child.id, v_zone.id, (p_payload ->> 'event') = 'enter',
        coalesce((p_payload ->> 'lat')::double precision, v_zone.lat),
        coalesce((p_payload ->> 'lon')::double precision, v_zone.lon));
    end if;
  end if;

  -- --- Synchronisation des zones vers le téléphone (géorepérage iOS) ---
  if v_child.zones_synced_version <> v_family.zones_version then
    select coalesce(array_agg(name order by name), '{}') into v_names
    from public.zones where family_id = v_child.family_id;

    select coalesce(jsonb_agg(w), '[]'::jsonb) into v_waypoints
    from (
      select jsonb_build_object('_type', 'waypoint', 'desc', z.name,
                                'lat', z.lat, 'lon', z.lon, 'rad', z.radius_m,
                                'tst', extract(epoch from z.created_at)::bigint) as w
      from public.zones z where z.family_id = v_child.family_id
      union all
      -- zone invisible « +follow » : elle suit l'enfant ; quand il en sort,
      -- iOS relance OwnTracks même si l'app a été fermée par balayage
      select jsonb_build_object('_type', 'waypoint', 'desc', '+follow',
                                'lat', coalesce(v_lat, v_child.lat, 0), 'lon', coalesce(v_lon, v_child.lon, 0),
                                'rad', 50, 'tst', 1000000000)
      union all
      -- zones supprimées : latitude invalide = suppression côté iOS
      select jsonb_build_object('_type', 'waypoint', 'desc', old_name,
                                'lat', -1000000, 'lon', -1000000, 'rad', 0,
                                'tst', 0)
      from unnest(v_cred.synced_zone_names) as old_name
      where old_name <> all (v_names)
    ) s;

    v_resp := v_resp || jsonb_build_array(jsonb_build_object(
      '_type', 'cmd', 'action', 'setWaypoints',
      'waypoints', jsonb_build_object('_type', 'waypoints', 'waypoints', v_waypoints)));

    update private.child_credentials set synced_zone_names = v_names where child_id = v_child.id;
    update public.children set zones_synced_version = v_family.zones_version where id = v_child.id;
  end if;

  -- --- Profil de suivi : direct si un parent regarde la carte ---
  select exists (
    select 1 from public.watchers w
    where w.family_id = v_child.family_id
      and w.last_seen_at > now() - interval '45 seconds'
  ) into v_watching;

  v_desired := case when v_watching then 'direct' else v_child.idle_mode end;

  if v_desired is distinct from v_child.profile
     or (v_m is not null
         and v_m <> private.profile_monitoring(v_desired)
         and coalesce(v_batt, 100) >= 25          -- iOS repasse seul en éco si batterie faible
         and coalesce(v_child.profile_sent_at, '-infinity') < now() - interval '1 minute')
  then
    v_resp := v_resp || jsonb_build_array(jsonb_build_object(
      '_type', 'cmd', 'action', 'setConfiguration',
      'configuration', private.profile_config(v_desired)));
    update public.children
       set profile = v_desired, profile_sent_at = now()
     where id = v_child.id;
  end if;

  return v_resp;
end;
$$;

-- Forcer l'envoi de la nouvelle zone à tous les iPhone déjà configurés
update public.children set zones_synced_version = -1;
