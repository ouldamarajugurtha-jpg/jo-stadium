# JO STADIUM — backend et tournois

## Contenu
- `server.js` : serveur Express, API des réservations et API des tournois.
- `public/index.html` : site client de réservation avec le logo BaridiMob fourni.
- `public/admin.html` : administration des réservations et paiements.
- `public/admin-tournaments.html` : administration des tournois, équipes, calendrier, scores et cartons.
- `public/tournaments.html` : inscriptions publiques, calendrier, résultats et classements.
- `public/baridimob-logo.png` : logo BaridiMob utilisé dans la page de réservation.

## Variables d’environnement nécessaires
- `DATABASE_URL` : URL de connexion PostgreSQL.
- `ADMIN_PASSWORD` : mot de passe administrateur.
- `PORT` : facultatif, Render fournit normalement cette valeur.

Le serveur ne démarre pas si `DATABASE_URL` ou `ADMIN_PASSWORD` sont absents.

## Déploiement Render
- **Root Directory** : `JO_STADIUM_backend` si tu téléverses le dossier parent, ou laisser vide si tu places directement les fichiers du dossier dans la racine du dépôt.
- **Build Command** : `npm install`
- **Start Command** : `npm start`
- Ajouter `DATABASE_URL` et `ADMIN_PASSWORD` dans les variables d’environnement Render. Conserver la même base PostgreSQL que celle qui contient les réservations existantes.

## Tournois inclus
- Maximum de 48 équipes par tournoi.
- De 2 à 24 groupes, sans dépasser le nombre d’équipes.
- Option de qualification des meilleurs troisièmes désactivée ou réglée de 2 à 8 équipes.
- Création des matchs avec choix de date et d’heure.
- Enregistrement manuel des scores et des cartons jaunes/rouges.
- Calcul automatique des points, victoires, nuls, défaites, buts, différence de buts et classements.
- Affichage public des calendriers, résultats et classements ; vert pour les deux premiers, bleu pour les meilleurs troisièmes qualifiés.

## Important pour les données existantes
La migration ajoute les tables et colonnes de tournoi au démarrage. Elle ne supprime pas la table des réservations. Déploie en conservant la même base PostgreSQL et ne supprime pas la base Render.
