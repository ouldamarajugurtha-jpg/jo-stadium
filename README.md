# JO STADIUM — version améliorée des tournois

## Déploiement Render
1. Utilise une base PostgreSQL persistante et configure `DATABASE_URL`.
2. Configure `ADMIN_PASSWORD` avec un mot de passe administrateur fort.
3. Build command : `npm install`
4. Start command : `npm start`
5. Node.js 18 ou plus récent est requis.

Les tables tournois/équipes/matchs sont créées automatiquement. La migration élargit la limite à 48 équipes et conserve les réservations déjà stockées dans PostgreSQL.

## Fonctions de tournoi
- Jusqu'à 48 équipes et 12 groupes.
- Option de qualification des meilleurs troisièmes.
- Calendrier aller simple automatique dans chaque groupe.
- Modification des dates/heures des matchs.
- Saisie des scores et cartons jaunes/rouges.
- Classements recalculés automatiquement.
- Consultation publique des résultats et classements.
- Persistance des matchs et tournois dans PostgreSQL.

## Important
Ce ZIP reprend les pages `index.html` et `admin.html` du précédent projet retrouvé, ainsi que le `server.js` et les deux pages tournoi fournis dans cette conversation. Le JavaScript serveur et les scripts des deux pages tournoi ont passé `node --check`. Une connexion réelle à PostgreSQL/Render n'a pas pu être testée ici : vérifie `DATABASE_URL` et `ADMIN_PASSWORD` dans Render avant de déplo
yer.
