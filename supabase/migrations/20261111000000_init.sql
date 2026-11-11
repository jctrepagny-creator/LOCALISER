-- =====================================================================
-- Localiser — schéma initial
--   * Les iPhone des enfants envoient leur position via OwnTracks (HTTP)
--     -> edge function `owntracks` -> public.svc_ingest_owntracks()
--   * Les parents / proches (app web PWA) lisent les données via RLS
--     et reçoivent les changements en temps réel (Supabase Realtime).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- Réglages internes (jamais exposés aux clients)
-- ---------------------------------------------------------------------
create table private.settings (
  key   text primary key,
  value text not null
);

insert into private.settings (key, value)
values ('internal_secret', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.families (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 60),
  zones_version integer not null default 0,
  created_at    timestamptz not null default now()
);

create table public.members (
  family_id    uuid not null references public.families (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null check (role in ('parent', 'proche')),
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index members_user_idx on public.members (user_id);

create table public.children (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families (id) on delete cascade,
  name                 text not null check (char_length(name) between 1 and 40),
  color                text not null default '#2563eb' check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- mode quand personne ne regarde : 'eco' (changements significatifs)
  -- ou 'reactif' (position au moins toutes les 3 min)
  idle_mode            text not null default 'eco' check (idle_mode in ('eco', 'reactif')),
  -- dernier profil OwnTracks envoyé au téléphone : eco | reactif | direct
  profile              text,
  profile_sent_at      timestamptz,
  lat                  double precision,
  lon                  double precision,
  acc                  integer,
  vel                  integer,
  batt                 smallint,
  batt_status          smallint,
  conn                 text,
  last_fix_at          timestamptz,
  last_seen_at         timestamptz,
  low_batt_alerted     boolean not null default false,
  silence_alerted      boolean not null default false,
  zones_synced_version integer not null default -1,
  created_at           timestamptz not null default now()
);
create index children_family_idx on public.children (family_id);

create table private.child_credentials (
  child_id          uuid primary key references public.children (id) on delete cascade,
  device_user       text not null unique,
  secret_hash       text not null,
  synced_zone_names text[] not null default '{}'
);

create table public.locations (
  id          bigint generated always as identity primary key,
  child_id    uuid not null references public.children (id) on delete cascade,
  family_id   uuid not null references public.families (id) on delete cascade,
  lat         double precision not null,
  lon         double precision not null,
  acc         integer,
  vel         integer,
  batt        smallint,
  trigger     text,
  recorded_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index locations_child_time_idx on public.locations (child_id, recorded_at desc);
create index locations_time_idx on public.locations (recorded_at);

create table public.zones (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 30),
  lat        double precision not null check (lat between -90 and 90),
  lon        double precision not null check (lon between -180 and 180),
  radius_m   integer not null default 150 check (radius_m between 50 and 5000),
  created_at timestamptz not null default now(),
  unique (family_id, name)
);

create table public.zone_presence (
  child_id   uuid not null references public.children (id) on delete cascade,
  zone_id    uuid not null references public.zones (id) on delete cascade,
  inside     boolean not null,
  updated_at timestamptz not null default now(),
  primary key (child_id, zone_id)
);

create table public.events (
  id         bigint generated always as identity primary key,
  family_id  uuid not null references public.families (id) on delete cascade,
  child_id   uuid references public.children (id) on delete cascade,
  type       text not null check (type in ('sos', 'zone_enter', 'zone_exit', 'battery_low', 'silence')),
  title      text not null,
  body       text not null default '',
  lat        double precision,
  lon        double precision,
  created_at timestamptz not null default now()
);
create index events_family_time_idx on public.events (family_id, created_at desc);

-- Qui regarde la carte en ce moment (battement toutes les ~15 s)
create table public.watchers (
  family_id    uuid not null references public.families (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

create table public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  family_id  uuid not null references public.families (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

create table private.invites (
  code       text primary key,
  family_id  uuid not null references public.families (id) on delete cascade,
  role       text not null check (role in ('parent', 'proche')),
  created_by uuid not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    uuid
);

-- ---------------------------------------------------------------------
-- Fonctions utilitaires
-- ---------------------------------------------------------------------
create function public.is_member(p_family_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.family_id = p_family_id and m.user_id = auth.uid()
  );
$$;

create function public.is_parent(p_family_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.family_id = p_family_id and m.user_id = auth.uid() and m.role = 'parent'
  );
$$;

create function private.random_code(
  p_len integer,
  p_alphabet text default 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
)
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  v_bytes bytea := extensions.gen_random_bytes(p_len);
  v_out   text := '';
  i       integer;
begin
  for i in 0 .. p_len - 1 loop
    v_out := v_out || substr(p_alphabet, (get_byte(v_bytes, i) % length(p_alphabet)) + 1, 1);
  end loop;
  return v_out;
end;
$$;

create function private.sha256_hex(p_text text)
returns text
language sql immutable set search_path = ''
as $$
  select encode(extensions.digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex');
$$;

-- Distance en mètres (haversine)
create function private.distance_m(lat1 double precision, lon1 double precision,
                                   lat2 double precision, lon2 double precision)
returns double precision
language sql immutable set search_path = ''
as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  ));
$$;

-- Profils de suivi envoyés à OwnTracks (setConfiguration)
--   eco     : changements significatifs iOS (~500 m / 5 min), très économe
--   reactif : mode déplacement, position toutes les 3 min ou 100 m
--   direct  : mode déplacement, position toutes les 5 s ou 5 m (quand un parent regarde)
create function private.profile_config(p_profile text)
returns jsonb
language sql immutable set search_path = ''
as $$
  select case p_profile
    when 'direct'  then '{"_type":"configuration","monitoring":2,"locatorInterval":5,"locatorDisplacement":5}'::jsonb
    when 'reactif' then '{"_type":"configuration","monitoring":2,"locatorInterval":180,"locatorDisplacement":100}'::jsonb
    else                '{"_type":"configuration","monitoring":1}'::jsonb
  end;
$$;

create function private.profile_monitoring(p_profile text)
returns integer
language sql immutable set search_path = ''
as $$
  select case when p_profile in ('direct', 'reactif') then 2 else 1 end;
$$;

-- ---------------------------------------------------------------------
-- RPC appelées par l'app parents (utilisateur connecté)
-- ---------------------------------------------------------------------
create function public.create_family(p_family_name text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if exists (select 1 from public.members where user_id = v_uid) then
    raise exception 'already_in_family';
  end if;
  insert into public.families (name) values (trim(p_family_name)) returning id into v_id;
  insert into public.members (family_id, user_id, role, display_name)
  values (v_id, v_uid, 'parent', trim(p_display_name));
  return v_id;
end;
$$;

create function public.create_invite(p_family_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_code    text;
  v_expires timestamptz := now() + interval '24 hours';
begin
  if not public.is_parent(p_family_id) then
    raise exception 'forbidden';
  end if;
  if p_role not in ('parent', 'proche') then
    raise exception 'invalid_role';
  end if;
  loop
    v_code := private.random_code(8);
    begin
      insert into private.invites (code, family_id, role, created_by, expires_at)
      values (v_code, p_family_id, p_role, auth.uid(), v_expires);
      exit;
    exception when unique_violation then
      -- rarissime : on retente avec un autre code
    end;
  end loop;
  return jsonb_build_object('code', v_code, 'expires_at', v_expires, 'role', p_role);
end;
$$;

create function public.join_family(p_code text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_code   text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_invite private.invites%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  select * into v_invite from private.invites
  where code = v_code and used_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'invalid_code';
  end if;
  if exists (select 1 from public.members where user_id = v_uid) then
    raise exception 'already_in_family';
  end if;
  insert into public.members (family_id, user_id, role, display_name)
  values (v_invite.family_id, v_uid, v_invite.role, trim(p_display_name));
  update private.invites set used_at = now(), used_by = v_uid where code = v_code;
  return v_invite.family_id;
end;
$$;

create function private.new_child_secret(p_child_id uuid)
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
    insert into private.child_credentials (child_id, device_user, secret_hash)
    values (p_child_id, v_user, private.sha256_hex(v_secret));
  else
    -- nouveau secret : l'ancien téléphone configuré ne pourra plus envoyer
    -- on force aussi la resynchronisation des zones et du profil
    update private.child_credentials
       set secret_hash = private.sha256_hex(v_secret), synced_zone_names = '{}'
     where child_id = p_child_id;
    update public.children
       set zones_synced_version = -1, profile = null
     where id = p_child_id;
  end if;
  return jsonb_build_object('child_id', p_child_id, 'username', v_user, 'password', v_secret);
end;
$$;

create function public.add_child(p_family_id uuid, p_name text, p_color text default '#2563eb')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_parent(p_family_id) then
    raise exception 'forbidden';
  end if;
  insert into public.children (family_id, name, color)
  values (p_family_id, trim(p_name), coalesce(p_color, '#2563eb'))
  returning id into v_id;
  return private.new_child_secret(v_id);
end;
$$;

create function public.reset_child_credentials(p_child_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_family uuid;
begin
  select family_id into v_family from public.children where id = p_child_id;
  if v_family is null or not public.is_parent(v_family) then
    raise exception 'forbidden';
  end if;
  return private.new_child_secret(p_child_id);
end;
$$;

-- Battement « je regarde la carte » : déclenche le mode direct
create function public.watch(p_family_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_member(p_family_id) then
    raise exception 'forbidden';
  end if;
  insert into public.watchers (family_id, user_id, last_seen_at)
  values (p_family_id, auth.uid(), now())
  on conflict (family_id, user_id) do update set last_seen_at = excluded.last_seen_at;
end;
$$;

create function public.unwatch(p_family_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.watchers where family_id = p_family_id and user_id = auth.uid();
$$;

create function public.get_vapid_public_key()
returns text
language sql stable security definer set search_path = ''
as $$
  select value from private.settings where key = 'vapid_public';
$$;

-- ---------------------------------------------------------------------
-- Logique interne : batterie, zones, présence
-- ---------------------------------------------------------------------
create function private.set_presence(p_child_id uuid, p_zone_id uuid, p_inside boolean,
                                     p_lat double precision, p_lon double precision)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_prev  boolean;
  v_child public.children%rowtype;
  v_zone  public.zones%rowtype;
begin
  select inside into v_prev from public.zone_presence
  where child_id = p_child_id and zone_id = p_zone_id
  for update;

  if not found then
    -- première information : on mémorise sans alerter
    insert into public.zone_presence (child_id, zone_id, inside)
    values (p_child_id, p_zone_id, p_inside)
    on conflict (child_id, zone_id) do nothing;
    return;
  end if;

  if v_prev = p_inside then
    return;
  end if;

  update public.zone_presence
     set inside = p_inside, updated_at = now()
   where child_id = p_child_id and zone_id = p_zone_id;

  select * into v_child from public.children where id = p_child_id;
  select * into v_zone from public.zones where id = p_zone_id;

  insert into public.events (family_id, child_id, type, title, body, lat, lon)
  values (
    v_child.family_id, p_child_id,
    case when p_inside then 'zone_enter' else 'zone_exit' end,
    case when p_inside
      then '📍 ' || v_child.name || ' est à « ' || v_zone.name || ' »'
      else '🚶 ' || v_child.name || ' a quitté « ' || v_zone.name || ' »'
    end,
    to_char(now() at time zone 'Europe/Paris', 'HH24:MI'),
    p_lat, p_lon
  );
end;
$$;

create function private.update_zone_presence(p_child_id uuid, p_family_id uuid,
                                              p_lat double precision, p_lon double precision,
                                              p_acc integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  z        public.zones%rowtype;
  v_dist   double precision;
  v_margin double precision := greatest(coalesce(p_acc, 0), 50);
begin
  -- position trop imprécise : on ne conclut rien
  if coalesce(p_acc, 0) > 500 then
    return;
  end if;
  for z in select * from public.zones where family_id = p_family_id loop
    v_dist := private.distance_m(p_lat, p_lon, z.lat, z.lon);
    if v_dist <= z.radius_m then
      perform private.set_presence(p_child_id, z.id, true, p_lat, p_lon);
    elsif v_dist > z.radius_m + v_margin then
      perform private.set_presence(p_child_id, z.id, false, p_lat, p_lon);
    end if;
    -- entre les deux : zone d'incertitude, on ne change rien
  end loop;
end;
$$;

create function private.check_battery(p_child_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c public.children%rowtype;
begin
  select * into c from public.children where id = p_child_id;
  if c.batt is null then
    return;
  end if;
  if c.batt < 15 and coalesce(c.batt_status, 1) not in (2, 3) and not c.low_batt_alerted then
    insert into public.events (family_id, child_id, type, title, body, lat, lon)
    values (c.family_id, c.id, 'battery_low',
            '🔋 Batterie faible : ' || c.name,
            'Il reste ' || c.batt || ' % sur le téléphone de ' || c.name || '.',
            c.lat, c.lon);
    update public.children set low_batt_alerted = true where id = c.id;
  elsif (c.batt >= 25 or c.batt_status in (2, 3)) and c.low_batt_alerted then
    update public.children set low_batt_alerted = false where id = c.id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC réservées au serveur (edge functions, clé service_role)
-- ---------------------------------------------------------------------

-- Reçoit un message OwnTracks, renvoie le tableau JSON de réponse
-- (commandes setConfiguration / setWaypoints pour le téléphone).
create function public.svc_ingest_owntracks(p_user text, p_secret text, p_payload jsonb)
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

-- Bouton SOS (Raccourci iOS). p_key = "<utilisateur>:<secret>"
create function public.svc_ingest_sos(p_key text, p_lat double precision, p_lon double precision,
                                      p_acc integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
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

  if p_lat is not null and p_lon is not null then
    insert into public.locations (child_id, family_id, lat, lon, acc, trigger, recorded_at)
    values (v_child.id, v_child.family_id, p_lat, p_lon, p_acc, 'sos', now());
    update public.children
       set lat = p_lat, lon = p_lon, acc = p_acc, last_fix_at = now(), last_seen_at = now(),
           silence_alerted = false
     where id = v_child.id;
  end if;

  -- anti double-appui : un seul SOS par tranche de 30 s
  if not exists (
    select 1 from public.events
    where child_id = v_child.id and type = 'sos' and created_at > now() - interval '30 seconds'
  ) then
    insert into public.events (family_id, child_id, type, title, body, lat, lon)
    values (v_child.family_id, v_child.id, 'sos',
            '🆘 SOS de ' || v_child.name,
            'Alerte envoyée à ' || to_char(now() at time zone 'Europe/Paris', 'HH24:MI') ||
              case when p_lat is null then ' (position inconnue)' else '' end || '.',
            coalesce(p_lat, v_child.lat), coalesce(p_lon, v_child.lon));
  end if;

  return jsonb_build_object('ok', true, 'child', v_child.name);
end;
$$;

-- Enregistre l'URL des fonctions et la paire de clés VAPID (une seule fois)
create function public.svc_ensure_settings(p_functions_url text, p_vapid_public text, p_vapid_private text)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.settings (key, value) values ('functions_url', p_functions_url)
  on conflict (key) do update set value = excluded.value;
  insert into private.settings (key, value) values ('vapid_public', p_vapid_public)
  on conflict (key) do nothing;
  insert into private.settings (key, value) values ('vapid_private', p_vapid_private)
  on conflict (key) do nothing;
  return (select value from private.settings where key = 'vapid_public');
end;
$$;

-- Données nécessaires à l'envoi d'une notification push
create function public.svc_notify_payload(p_event_id bigint, p_secret text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event public.events%rowtype;
begin
  if p_secret is distinct from (select value from private.settings where key = 'internal_secret') then
    raise exception 'forbidden' using errcode = '28000';
  end if;
  select * into v_event from public.events where id = p_event_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'event', to_jsonb(v_event),
    'vapid_public',  (select value from private.settings where key = 'vapid_public'),
    'vapid_private', (select value from private.settings where key = 'vapid_private'),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
      from public.push_subscriptions s where s.family_id = v_event.family_id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Déclencheurs
-- ---------------------------------------------------------------------
create function private.bump_zones_version()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.families
     set zones_version = zones_version + 1
   where id = coalesce(new.family_id, old.family_id);
  return null;
end;
$$;

create trigger zones_changed
after insert or update or delete on public.zones
for each row execute function private.bump_zones_version();

-- Chaque nouvel événement déclenche l'envoi des notifications push
create function private.dispatch_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url from private.settings where key = 'functions_url';
  select value into v_secret from private.settings where key = 'internal_secret';
  if v_url is null then
    return new;
  end if;
  if not exists (select 1 from public.push_subscriptions where family_id = new.family_id) then
    return new;
  end if;
  perform net.http_post(
    url     := v_url || '/notify',
    body    := jsonb_build_object('event_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    timeout_milliseconds := 10000
  );
  return new;
end;
$$;

create trigger events_dispatch
after insert on public.events
for each row execute function private.dispatch_event();

-- Un membre retiré de la famille ne reçoit plus rien
create function private.member_removed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.push_subscriptions where family_id = old.family_id and user_id = old.user_id;
  delete from public.watchers where family_id = old.family_id and user_id = old.user_id;
  return null;
end;
$$;

create trigger members_removed
after delete on public.members
for each row execute function private.member_removed();

-- ---------------------------------------------------------------------
-- Tâches planifiées
-- ---------------------------------------------------------------------
create function private.check_silence()
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
        -- batterie presque vide au dernier signal : probablement éteint
        (coalesce(batt, 100) <= 10 and last_seen_at < now() - interval '30 minutes')
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

create function private.cleanup()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.locations where recorded_at < now() - interval '7 days';
  delete from public.events where created_at < now() - interval '30 days';
  delete from private.invites where expires_at < now() - interval '1 day';
  delete from public.watchers where last_seen_at < now() - interval '1 day';
end;
$$;

select cron.schedule('localiser-silence', '*/10 * * * *', 'select private.check_silence()');
select cron.schedule('localiser-cleanup', '17 3 * * *', 'select private.cleanup()');

-- ---------------------------------------------------------------------
-- Sécurité : droits et RLS
-- ---------------------------------------------------------------------
alter table public.families           enable row level security;
alter table public.members            enable row level security;
alter table public.children           enable row level security;
alter table public.locations          enable row level security;
alter table public.zones              enable row level security;
alter table public.zone_presence      enable row level security;
alter table public.events             enable row level security;
alter table public.watchers           enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant select on public.families, public.members, public.children, public.locations,
                public.zones, public.zone_presence, public.events to authenticated;
grant update (name) on public.families to authenticated;
grant update (display_name), delete on public.members to authenticated;
grant update (name, color, idle_mode), delete on public.children to authenticated;
grant insert, update, delete on public.zones to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

grant execute on function
  public.is_member(uuid), public.is_parent(uuid),
  public.create_family(text, text), public.create_invite(uuid, text),
  public.join_family(text, text), public.add_child(uuid, text, text),
  public.reset_child_credentials(uuid), public.watch(uuid), public.unwatch(uuid),
  public.get_vapid_public_key()
to authenticated;

grant execute on function
  public.svc_ingest_owntracks(text, text, jsonb),
  public.svc_ingest_sos(text, double precision, double precision, integer),
  public.svc_ensure_settings(text, text, text),
  public.svc_notify_payload(bigint, text)
to service_role;

create policy families_select on public.families
  for select to authenticated using (public.is_member(id));
create policy families_update on public.families
  for update to authenticated using (public.is_parent(id)) with check (public.is_parent(id));

create policy members_select on public.members
  for select to authenticated using (public.is_member(family_id));
create policy members_update_self on public.members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy members_delete on public.members
  for delete to authenticated using (public.is_parent(family_id) or user_id = auth.uid());

create policy children_select on public.children
  for select to authenticated using (public.is_member(family_id));
create policy children_update on public.children
  for update to authenticated using (public.is_parent(family_id)) with check (public.is_parent(family_id));
create policy children_delete on public.children
  for delete to authenticated using (public.is_parent(family_id));

create policy locations_select on public.locations
  for select to authenticated using (public.is_member(family_id));

create policy zones_select on public.zones
  for select to authenticated using (public.is_member(family_id));
create policy zones_insert on public.zones
  for insert to authenticated with check (public.is_parent(family_id));
create policy zones_update on public.zones
  for update to authenticated using (public.is_parent(family_id)) with check (public.is_parent(family_id));
create policy zones_delete on public.zones
  for delete to authenticated using (public.is_parent(family_id));

create policy zone_presence_select on public.zone_presence
  for select to authenticated using (
    exists (select 1 from public.children c where c.id = child_id and public.is_member(c.family_id))
  );

create policy events_select on public.events
  for select to authenticated using (public.is_member(family_id));

create policy push_select on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy push_insert on public.push_subscriptions
  for insert to authenticated with check (user_id = auth.uid() and public.is_member(family_id));
create policy push_update on public.push_subscriptions
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_member(family_id));
create policy push_delete on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Temps réel : diffusion des changements aux apps parents
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.children, public.events, public.zones;
  end if;
end;
$$;
