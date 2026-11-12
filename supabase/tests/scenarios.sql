-- Scénarios de test (exécutés par run_local.sh sur une base locale)
\set ON_ERROR_STOP 1

create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'ÉCHEC : %', msg; end if; end $$;

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- parent 1
  ('22222222-2222-2222-2222-222222222222'),  -- parent 2
  ('33333333-3333-3333-3333-333333333333'),  -- proche
  ('44444444-4444-4444-4444-444444444444');  -- inconnu

-- ===== Parent 1 crée la famille et ajoute un enfant =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.create_family('Famille Test', 'Papa') as fid \gset
select (public.create_invite(:'fid', 'parent'))->>'code' as code_parent \gset
select (public.create_invite(:'fid', 'proche'))->>'code' as code_proche \gset
select public.add_child(:'fid', 'Léa', '#e11d48') as child_json \gset
select (:'child_json'::jsonb)->>'child_id' as cid,
       (:'child_json'::jsonb)->>'username' as cuser,
       (:'child_json'::jsonb)->>'password' as cpass \gset
select pg_temp.assert(length(:'cpass') = 24, 'mot de passe enfant de 24 caractères');
select set_config('my.u', :'cuser', false);

-- ===== Parent 2 rejoint (code saisi en minuscules avec tiret) =====
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.join_family(lower(substr(:'code_parent', 1, 4) || '-' || substr(:'code_parent', 5)), 'Maman');
select pg_temp.assert((select count(*) from public.children) = 1, 'parent 2 voit l''enfant');

-- ===== Le proche rejoint, ne peut pas créer de zone ni d'enfant =====
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.join_family(:'code_proche', 'Mamie');
select pg_temp.assert((select role from public.members where user_id = auth.uid()) = 'proche', 'rôle proche');
do $$ begin
  insert into public.zones (family_id, name, lat, lon) select id, 'X', 0, 0 from public.families;
  raise exception 'ÉCHEC : un proche ne doit pas créer de zone';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.add_child((select id from public.families), 'Intrus', null);
  raise exception 'ÉCHEC : un proche ne doit pas ajouter d''enfant';
exception when raise_exception then
  if sqlerrm <> 'forbidden' then raise; end if;
end $$;

-- ===== Code déjà utilisé / inconnu refusé =====
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$ begin
  perform public.join_family('ZZZZZZZZ', 'Intrus');
  raise exception 'ÉCHEC : code invalide accepté';
exception when raise_exception then
  if sqlerrm <> 'invalid_code' then raise; end if;
end $$;
-- ===== Un inconnu ne voit rien =====
select pg_temp.assert((select count(*) from public.children) = 0, 'inconnu ne voit pas les enfants');
select pg_temp.assert((select count(*) from public.families) = 0, 'inconnu ne voit pas les familles');
do $$ begin
  perform public.watch((select id from public.families limit 1));
exception when others then null; end $$;

-- ===== Parent 1 crée une zone « Maison » =====
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into public.zones (family_id, name, lat, lon, radius_m) values (:'fid', 'Maison', 48.8566, 2.3522, 150);
reset role;

-- ===== Le téléphone de l'enfant envoie une position (à la maison) =====
set role service_role;
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8567,'lon',2.3523,'acc',10,'batt',80,'bs',1,
                     'tst', extract(epoch from now())::bigint, 'm', 1)) as resp \gset
\echo Réponse 1 : :resp
select pg_temp.assert(jsonb_path_exists(:'resp'::jsonb, '$[*] ? (@.action == "setWaypoints")'), 'zones envoyées au téléphone');
select pg_temp.assert(jsonb_path_exists(:'resp'::jsonb, '$[*].waypoints.waypoints[*] ? (@.desc == "+follow" && @.rad == 50)'), 'zone +follow envoyée');
select pg_temp.assert(jsonb_path_exists(:'resp'::jsonb, '$[*] ? (@.action == "setConfiguration" && @.configuration.monitoring == 1)'), 'profil éco envoyé');

-- Deuxième envoi : plus rien à synchroniser
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8567,'lon',2.3523,'acc',10,'batt',80,
                     'tst', extract(epoch from now())::bigint, 'm', 1)) as resp \gset
select pg_temp.assert(:'resp'::jsonb = '[]'::jsonb, 'réponse vide quand tout est à jour');

-- Mauvais mot de passe
do $$ begin
  perform public.svc_ingest_owntracks(current_setting('my.u'), 'faux', '{"_type":"location","lat":1,"lon":1}');
  raise exception 'ÉCHEC : mot de passe faux accepté';
exception when sqlstate '28000' then null; end $$;
reset role;

select pg_temp.assert((select count(*) from public.events) = 0, 'aucune alerte au premier point');
select pg_temp.assert((select inside from public.zone_presence) = true, 'présence Maison mémorisée');

-- ===== Abonnement push + URL des fonctions → les événements partent en notification =====
set role service_role;
select public.svc_ensure_settings('https://exemple.supabase.co/functions/v1', 'PUB', 'PRIV') as vapid \gset
select pg_temp.assert(:'vapid' = 'PUB', 'clé VAPID publique');
select pg_temp.assert(public.svc_ensure_settings('https://exemple.supabase.co/functions/v1', 'AUTRE', 'AUTRE') = 'PUB', 'clés VAPID non écrasées');
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into public.push_subscriptions (endpoint, user_id, family_id, p256dh, auth)
values ('https://push.example/abc', auth.uid(), :'fid', 'k', 'a');
reset role;

-- ===== L'enfant quitte la maison → alerte =====
set role service_role;
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8600,'lon',2.3600,'acc',15,'batt',79,
                     'tst', extract(epoch from now())::bigint, 'm', 1));
reset role;
select pg_temp.assert((select count(*) from public.events where type = 'zone_exit') = 1, 'alerte sortie de zone');
select pg_temp.assert((select count(*) from net.calls where url like '%/notify') = 1, 'notification déclenchée');
select title, body from public.events;

-- Transition native iOS « enter » → alerte d'arrivée
set role service_role;
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  '{"_type":"transition","event":"enter","desc":"Maison","lat":48.8566,"lon":2.3522,"t":"c"}');
-- Puis une position dans la zone : pas de doublon
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8566,'lon',2.3522,'acc',10,'batt',79,
                     'tst', extract(epoch from now())::bigint, 'm', 1));
reset role;
select pg_temp.assert((select count(*) from public.events where type = 'zone_enter') = 1, 'une seule alerte d''arrivée');

-- ===== Un parent regarde la carte → mode direct =====
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.watch(:'fid');
reset role;
set role service_role;
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8566,'lon',2.3522,'acc',10,'batt',79,
                     'tst', extract(epoch from now())::bigint, 'm', 1)) as resp \gset
\echo Réponse direct : :resp
select pg_temp.assert(jsonb_path_exists(:'resp'::jsonb, '$[*] ? (@.configuration.locatorInterval == 5)'), 'profil direct envoyé');
reset role;

-- Le parent ferme la carte → retour en éco au prochain envoi
update public.watchers set last_seen_at = now() - interval '2 minutes';
set role service_role;
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8566,'lon',2.3522,'acc',10,'batt',79,
                     'tst', extract(epoch from now())::bigint, 'm', 2)) as resp \gset
select pg_temp.assert(jsonb_path_exists(:'resp'::jsonb, '$[*] ? (@.configuration.monitoring == 1)'), 'retour en éco');
reset role;

-- ===== Batterie faible : une seule alerte =====
set role service_role;
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8566,'lon',2.3522,'acc',10,'batt',12,'bs',1,
                     'tst', extract(epoch from now())::bigint, 'm', 1));
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8566,'lon',2.3522,'acc',10,'batt',11,'bs',1,
                     'tst', extract(epoch from now())::bigint, 'm', 1));
reset role;
select pg_temp.assert((select count(*) from public.events where type = 'battery_low') = 1, 'une alerte batterie');

-- ===== SOS (double appui = une alerte) =====
set role service_role;
select public.svc_ingest_sos(:'cuser' || ':' || :'cpass', 48.85, 2.35, 20);
select public.svc_ingest_sos(:'cuser' || ':' || :'cpass', 48.85, 2.35, 20);
do $$ begin
  perform public.svc_ingest_sos('x:y', 1, 1);
  raise exception 'ÉCHEC : SOS avec mauvaise clé accepté';
exception when sqlstate '28000' then null; end $$;
reset role;
select pg_temp.assert((select count(*) from public.events where type = 'sos') = 1, 'une alerte SOS');

-- ===== Silence : téléphone muet depuis longtemps =====
update public.children set last_seen_at = now() - interval '13 hours', batt = 60;
select private.check_silence();
select private.check_silence();
select pg_temp.assert((select count(*) from public.events where type = 'silence') = 1, 'une alerte silence');

-- ===== Suppression d'une zone → suppression envoyée au téléphone =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
delete from public.zones where name = 'Maison';
reset role;
set role service_role;
select public.svc_ingest_owntracks(:'cuser', :'cpass',
  jsonb_build_object('_type','location','lat',48.8566,'lon',2.3522,'acc',10,'batt',60,
                     'tst', extract(epoch from now())::bigint, 'm', 1)) as resp \gset
\echo Réponse suppression zone : :resp
select pg_temp.assert(jsonb_path_exists(:'resp'::jsonb, '$[*].waypoints.waypoints[*] ? (@.desc == "Maison" && @.lat == -1000000)'), 'zone supprimée côté téléphone');
reset role;

-- ===== Nouveau QR : l'ancien mot de passe ne marche plus =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (public.reset_child_credentials(:'cid'))->>'password' as newpass \gset
reset role;
select set_config('my.u', :'cuser', false), set_config('my.p', :'cpass', false), set_config('my.np', :'newpass', false);
set role service_role;
do $$ begin
  perform public.svc_ingest_owntracks(current_setting('my.u'), current_setting('my.p'), '{"_type":"location","lat":1,"lon":1}');
  raise exception 'ÉCHEC : ancien mot de passe encore accepté';
exception when sqlstate '28000' then null; end $$;
select public.svc_ingest_owntracks(current_setting('my.u'), current_setting('my.np'),
  '{"_type":"location","lat":48.8566,"lon":2.3522}') as resp \gset
select pg_temp.assert(jsonb_path_exists(:'resp'::jsonb, '$[*] ? (@.action == "setConfiguration")'), 'nouveau téléphone reconfiguré');
reset role;

-- ===== Historique visible par le proche, pas par l'inconnu =====
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.assert((select count(*) from public.locations) >= 8, 'le proche voit l''historique');
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.assert((select count(*) from public.locations) = 0, 'l''inconnu ne voit pas l''historique');
reset role;

select private.cleanup();
select pg_temp.assert((select count(*) from cron.jobs) = 2, 'deux tâches planifiées');

-- ===== Un membre retiré perd ses abonnements push =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
delete from public.members where user_id = '11111111-1111-1111-1111-111111111111';
reset role;
select pg_temp.assert((select count(*) from public.push_subscriptions) = 0, 'abonnements push supprimés avec le membre');

-- ===== État de l'enfant pour la page d'installation =====
set role service_role;
select pg_temp.assert((public.svc_child_status(current_setting('my.u') || ':' || current_setting('my.np')))->>'name' = 'Léa', 'état enfant lisible avec la bonne clé');
do $$ begin
  perform public.svc_child_status(current_setting('my.u') || ':faux');
  raise exception 'ÉCHEC : état enfant lisible avec une fausse clé';
exception when sqlstate '28000' then null; end $$;
reset role;

-- ===== Notification de test : seulement pour la personne qui la demande =====
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into public.push_subscriptions (endpoint, user_id, family_id, p256dh, auth)
select 'https://push.example/maman', auth.uid(), family_id, 'k', 'a' from public.members where user_id = auth.uid();
reset role;
insert into public.push_subscriptions (endpoint, user_id, family_id, p256dh, auth)
select 'https://push.example/mamie', '33333333-3333-3333-3333-333333333333', family_id, 'k', 'a' from public.members where user_id = '33333333-3333-3333-3333-333333333333';
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select (public.test_notification((select family_id from public.members where user_id = auth.uid())))->>'subscriptions' as nsubs \gset
reset role;
select pg_temp.assert(:'nsubs' = '1', 'un abonnement pour la personne');
select set_config('my.ev', (select id::text from public.events where type = 'test'), false),
       set_config('my.sec', (select value from private.settings where key = 'internal_secret'), false);
set role service_role;
select pg_temp.assert(jsonb_array_length((public.svc_notify_payload(current_setting('my.ev')::bigint,
  current_setting('my.sec')))->'subscriptions') = 1, 'test envoyé seulement à la personne');
reset role;
