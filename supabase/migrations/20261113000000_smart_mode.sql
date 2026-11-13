-- =====================================================================
-- Mode « intelligent » (anciennement « éco ») quand personne ne regarde :
-- OwnTracks en mode déplacement (une position tous les 50 m / 60 s) tant
-- que l'enfant bouge, puis bascule seul en mode économe après 5 minutes
-- d'immobilité (réglage « adapt », qui s'appuie sur la zone « +follow »).
-- Le trajet est donc détaillé, sans vider la batterie à l'arrêt.
-- =====================================================================
create or replace function private.profile_config(p_profile text)
returns jsonb
language sql immutable set search_path = ''
as $$
  select case p_profile
    when 'direct'  then '{"_type":"configuration","monitoring":2,"locatorInterval":5,"locatorDisplacement":5,"adapt":0}'::jsonb
    when 'reactif' then '{"_type":"configuration","monitoring":2,"locatorInterval":180,"locatorDisplacement":100,"adapt":0}'::jsonb
    else                '{"_type":"configuration","monitoring":2,"locatorInterval":60,"locatorDisplacement":50,"adapt":5}'::jsonb
  end;
$$;

-- Mode attendu dans les messages du téléphone (champ « m »), pour renvoyer
-- la configuration si le téléphone ne l'a pas appliquée.
-- NULL pour le mode intelligent : le téléphone alterne légitimement entre
-- 1 (à l'arrêt) et 2 (en mouvement), il ne faut donc pas le « corriger ».
create or replace function private.profile_monitoring(p_profile text)
returns integer
language sql immutable set search_path = ''
as $$
  select case when p_profile in ('direct', 'reactif') then 2 else null end;
$$;

-- Renvoyer le nouveau profil à tous les iPhone à leur prochain envoi
update public.children set profile = null;
