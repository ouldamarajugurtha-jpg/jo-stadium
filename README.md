# JO STADIUM — Projet complet

Projet Node.js / Express avec PostgreSQL pour les réservations du terrain et les tournois.

## Fichiers
- `server.js` : API, initialisation/migrations PostgreSQL, réservations, tournois, matchs et résultats.
- `public/index.html` : site client. Le menu hamburger contient désormais « Gestion d’administration » et mène à `/admin` (connexion toujours requise).
- `public/admin.html` : réservations, paiements et recettes.
- `public/admin-tournaments.html` : administration des tournois, équipes, calendrier et saisie des résultats.
- `public/tournaments.html` : inscriptions publiques, résultats et classements.
- `public/baridimob-logo.png` : logo fourni pour le paiement BaridiMob.

## Configuration Render
- Build command : `npm install`
- Start command : `npm start`
- Variables requises : `DATABASE_URL` et `ADMIN_PASSWORD`
- PostgreSQL doit rester attaché au service : ne supprime pas la base pour déployer cette version.

## Résultats manuels
Dans `/admin/tournois`, ouvre le tournoi et utilise « Saisie manuelle d’un résultat ». Choisis les deux équipes, saisis la date/heure si connues, le score et les cartons, puis appuie sur « Enregistrer le résultat ». Le serveur valide et sauvegarde le match en transaction PostgreSQL. Le classement public est recalculé à partir des résultats enregistrés.

La programmation préalable reste également disponible pour les matchs à venir. Les résultats déjà programmés peuvent être modifiés depuis leur fiche.

## Notes de sécurité et déploiement
- La page `/admin` et `/admin/tournois` demandent le mot de passe défini dans `ADMIN_PASSWORD`.
- Les migrations ajoutent/ajustent les colonnes des tournois et matchs sans supprimer les réservations.
- Fais une sauvegarde de la base PostgreSQL avant le déploiement. Vérifie les logs Render et teste l'enregistrement avec un tournoi de test.


## Accès administration et tournois (version corrigée)

- Depuis le menu ☰ du site client, « Gestion d’administration » ouvre `/admin` dans un nouvel onglet.
- Après connexion, un grand raccourci vert « Gestion des tournois » apparaît dans le tableau de bord. Il ouvre `/admin/tournois` dans un nouvel onglet.
- Les deux pages partagent le même jeton d'administration dans `localStorage` sur le même domaine.
- Le serveur désactive le cache des pages HTML pour éviter d'afficher l'ancien menu après un déploiement.

Après mise à jour, faire un rechargement forcé du navigateur mobile si une ancienne page reste affichée. Conserver la base PostgreSQL et les variables `DATABASE_URL` et `ADMIN_PASSWORD`.
