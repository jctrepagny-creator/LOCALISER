-- =====================================================================
-- Notification de test : envoyée uniquement aux appareils de la personne
-- qui la demande, pour vérifier que les alertes push arrivent.
-- =====================================================================
alter table public.events add column target_user uuid references auth.users (id) on delete cascade;

alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('sos', 'zone_enter', 'zone_exit', 'battery_low', 'silence', 'test'));

create or replace function public.svc_notify_payload(p_event_id bigint, p_secret text)
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
      from public.push_subscriptions s
      where s.family_id = v_event.family_id
        and (v_event.target_user is null or s.user_id = v_event.target_user)
    ), '[]'::jsonb)
  );
end;
$$;

create function public.test_notification(p_family_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_subs integer;
begin
  if not public.is_member(p_family_id) then
    raise exception 'forbidden';
  end if;
  select count(*) into v_subs from public.push_subscriptions
  where family_id = p_family_id and user_id = auth.uid();
  insert into public.events (family_id, type, title, body, target_user)
  values (p_family_id, 'test', '🔔 Test de notification',
          'Les alertes Localiser arrivent bien sur cet appareil.', auth.uid());
  return jsonb_build_object(
    'subscriptions', v_subs,
    'server_ready', exists (select 1 from private.settings where key = 'functions_url')
                and exists (select 1 from private.settings where key = 'vapid_private')
  );
end;
$$;

revoke all on function public.test_notification(uuid) from public, anon;
grant execute on function public.test_notification(uuid) to authenticated;
revoke all on function public.svc_notify_payload(bigint, text) from public, anon, authenticated;
grant execute on function public.svc_notify_payload(bigint, text) to service_role;
