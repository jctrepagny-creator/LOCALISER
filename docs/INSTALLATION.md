# Installation de Localiser — pas à pas

Tout se fait depuis un téléphone, sans ordinateur. Comptez 30 à 45 minutes la première fois.

## Vue d'ensemble

| Qui | Appareil | Ce qu'on installe |
|---|---|---|
| Enfants | iPhone | **OwnTracks** (gratuit, App Store) + un **widget SOS** (app Raccourcis d'Apple) |
| Parents | Android | **Localiser** (app web installée depuis Chrome) |
| Proches | iPhone ou Android | **Localiser** via un lien, ajouté à l'écran d'accueil |
| Serveur | Supabase (votre projet `aafgbtaudauxhayqpovc`) | Installé automatiquement par GitHub |

---

## Étape 1 — Deux codes à récupérer sur Supabase

1. **Jeton d'accès** : ouvrez <https://supabase.com/dashboard/account/tokens>, touchez **Generate new token**, nommez-le `github-localiser` et copiez-le. Il ne sera affiché qu'une fois.
2. **Mot de passe de la base** : c'est celui choisi à la création du projet. Si vous l'avez oublié : projet → **Project Settings → Database → Reset database password**.

> Ne collez jamais ces deux codes dans une conversation ou un fichier : uniquement dans les secrets GitHub (étape 2).

## Étape 2 — Réglages du dépôt GitHub

Dans le dépôt `localiser` sur github.com :

1. **Settings → Secrets and variables → Actions → New repository secret**, deux fois :
   - `SUPABASE_ACCESS_TOKEN` = le jeton de l'étape 1.1
   - `SUPABASE_DB_PASSWORD` = le mot de passe de l'étape 1.2
2. **Settings → Pages → Build and deployment → Source : GitHub Actions**.
   - GitHub Pages est gratuit pour un dépôt **public**. Pour un dépôt privé, il faut un abonnement GitHub payant. Le code ne contient aucun secret, donc rendre le dépôt public ne pose pas de problème de sécurité.
3. Fusionnez la branche de travail dans `main` (pull request → **Merge**). Si le dépôt n'a pas encore de branche `main`, c'est la branche de travail qui est la branche par défaut : passez directement au point 4 et lancez le déploiement avec **Run workflow**.
4. Onglet **Actions** : le déploiement « Déployer Localiser » démarre et dure 2 à 4 minutes. Les deux étapes doivent être vertes ✅. Pour le relancer : **Actions → Déployer Localiser → Run workflow**.
5. L'adresse de l'app s'affiche dans **Settings → Pages**. Elle ressemble à `https://<votre-compte>.github.io/localiser/`. Notez-la.

Le déploiement fait tout seul les opérations suivantes :

- il crée les tables et les règles de sécurité ;
- il installe les fonctions serveur ;
- il active les connexions anonymes, nécessaires pour l'appairage par QR code ;
- il publie l'app.

## Étape 3 — Le premier parent (Android)

1. Ouvrez l'adresse de l'app dans **Chrome**.
2. Menu **⋮ → Installer l'application** (ou « Ajouter à l'écran d'accueil »), puis ouvrez **Localiser** depuis l'écran d'accueil.
3. **Créer ma famille** : saisissez le nom de la famille et votre prénom.
4. Dans le menu **☰**, section **Notifications**, touchez **Activer les alertes** et acceptez.
5. Paramètres Android → Applications → Chrome → Batterie : choisissez **Sans restriction**, pour que les alertes arrivent même quand le téléphone est en veille.

## Étape 4 — L'autre parent et les proches

1. Sur le téléphone du premier parent : **☰ → Inviter un parent** (ou **Inviter un proche**). Un QR code s'affiche.
2. Sur l'autre téléphone, ouvrez **l'appareil photo**, scannez le QR code et ouvrez le lien.
   - **Android** : installez l'app (menu ⋮ → Installer), puis saisissez votre prénom.
   - **iPhone** : la page explique comment l'ajouter à l'écran d'accueil (Partager ⬆︎ → « Sur l'écran d'accueil »). Ouvrez ensuite Localiser **depuis l'écran d'accueil** et saisissez le code à 8 caractères. Sans cette étape, les alertes ne fonctionnent pas sur iPhone (iOS 16.4 minimum).
3. Activez les alertes : **☰ → Notifications**.

Un **proche** voit la carte et reçoit les alertes, mais ne peut pas modifier la famille. Chaque code est valable 24 h et ne sert qu'une fois.

## Étape 5 — L'iPhone de chaque enfant

Sur le téléphone d'un parent : **☰ → Ajouter un enfant**. Saisissez le prénom et choisissez une couleur. La page de configuration s'affiche alors. **Gardez-la ouverte** et suivez-la avec l'iPhone de l'enfant en main :

1. Installez **OwnTracks** depuis l'App Store et ouvrez-le une fois.
2. Scannez le **premier QR code** avec l'appareil photo de l'iPhone, touchez « Ouvrir dans OwnTracks » et acceptez.
   - Si l'iPhone affiche « URI or file configuration not allowed », allez dans Réglages iOS → OwnTracks, autorisez la configuration par URL, puis rescannez.
3. Réglez les autorisations :
   - **Position : « Toujours »**, avec **Position exacte** activée ;
   - Réglages → Général → **Actualisation en arrière-plan** activée pour OwnTracks ;
   - **Ne pas fermer OwnTracks** en le balayant vers le haut dans le sélecteur d'apps.
4. Dans OwnTracks, touchez la flèche ↑ : l'enfant doit apparaître sur votre carte.
5. Scannez le **second QR code** (bouton SOS) et suivez la page qui s'ouvre pour créer le Raccourci et son widget. Faites un essai en prévenant tout le monde.

Si le QR code ne fonctionne pas, la page de configuration contient aussi les réglages à saisir à la main.

## Étape 6 — Les zones

**☰ → Ajouter une zone** : déplacez la carte pour mettre le centre sous la croix, nommez la zone (Maison, École…) et choisissez le rayon. Les zones sont envoyées aux iPhone, qui les surveillent eux-mêmes grâce au géorepérage d'iOS. Les alertes d'arrivée et de départ fonctionnent donc même en mode économie.

---

## Comment fonctionne le « temps réel »

- **Quand un parent a l'app ouverte**, les iPhone passent en **mode direct** : une position toutes les 5 secondes, ou à chaque déplacement de 5 m. Sur la carte, l'enfant affiche « EN DIRECT ».
- **Quand personne ne regarde**, chaque iPhone revient au mode choisi pour l'enfant (☰ → Gérer) :
  - **Économie** (par défaut) : une position à chaque déplacement important (environ 500 m). La batterie est préservée.
  - **Réactif** : une position au moins toutes les 3 minutes. Le passage en direct est plus rapide, mais la batterie baisse davantage.
- ⚠️ **Limite d'iOS** : le serveur ne peut pas réveiller un iPhone. Il lui envoie l'ordre de passer en direct **au prochain envoi du téléphone**. Si l'enfant ne bouge pas en mode économie, ce passage peut prendre plusieurs minutes. L'app affiche alors « Passage en direct… ». Le mode **Réactif** réduit cette attente à 3 minutes au maximum.
- Quand la batterie de l'iPhone descend sous 15 %, OwnTracks repasse de lui-même en mode économie.

## Les alertes

| Alerte | Quand |
|---|---|
| 🆘 SOS | L'enfant touche le widget SOS |
| 📍 / 🚶 Zones | Arrivée ou départ d'une zone |
| 🔋 Batterie faible | Moins de 15 %, hors charge |
| ⚠️ Plus de nouvelles | Aucun signal depuis 12 h (mode économie), 30 min (mode réactif), ou 30 min si la batterie était presque vide |

L'historique des trajets est conservé 7 jours, et les alertes 30 jours.

## Dépannage

- **Un enfant est « Sans nouvelles »** : OwnTracks a été fermé, l'iPhone est éteint ou n'a plus de réseau, ou l'autorisation de position n'est plus sur « Toujours ». Rouvrez OwnTracks.
- **Je ne reçois pas les alertes** : ☰ → Notifications doit indiquer ✅. Sur Android, vérifiez que Chrome n'est pas restreint par l'économie de batterie. Sur iPhone, l'app doit être ouverte depuis l'écran d'accueil.
- **Téléphone de l'enfant changé ou réinitialisé** : ☰ → Gérer → **Nouveau QR code de configuration**, puis refaites l'étape 5. L'ancienne configuration est désactivée.
- **Le déploiement GitHub échoue** : ouvrez l'étape en rouge dans l'onglet Actions. Le plus souvent, un secret est manquant ou mal copié.
