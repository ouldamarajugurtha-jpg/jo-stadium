# JO STADIUM — Projet complet V6

Application Node.js / Express + PostgreSQL pour les réservations du terrain, l’administration et les tournois.

## Fichiers
- `server.js` : API, migrations PostgreSQL, réservations, tirage au sort, génération du calendrier, résultats et phase éliminatoire.
- `public/index.html` : site client et paiement BaridiMob.
- `public/admin.html` : administration des réservations, paiements et recettes.
- `public/admin-tournaments.html` : gestion des équipes, tirage au sort, calendrier, résultats et cartons.
- `public/tournaments.html` : page publique avec calendrier, scores, classements et qualifications.
- `public/baridimob-logo.png` : logo BaridiMob fourni.

## Déploiement Render
- Build command : `npm install`
- Start command : `npm start`
- Variables requises : `DATABASE_URL` et `ADMIN_PASSWORD`
- Conserver la base PostgreSQL actuelle. Les migrations ajoutent les colonnes nécessaires sans supprimer les réservations.

## Nouveau fonctionnement des tournois
1. Créer le tournoi, définir le nombre maximum d’équipes (4 à 48), les groupes et éventuellement 2 à 8 meilleurs troisièmes.
2. Laisser les équipes s’inscrire. Quand la liste est prête, ouvrir `/admin/tournois` et utiliser **« Générer le tirage + calendrier »**.
3. Le tirage répartit les équipes aléatoirement dans les groupes. Le calendrier de poule est créé automatiquement selon le format aller simple (chaque équipe rencontre une fois les autres équipes de son groupe).
4. La date du premier match, l’heure de départ et le nombre de matchs par jour sont configurables. Les créneaux sont espacés de 90 minutes. Chaque rencontre reste modifiable dans l’administration.
5. L’administrateur saisit les scores et cartons dans chaque match, puis clique sur **« Enregistrer le résultat »**. Le classement est recalculé depuis les résultats stockés dans PostgreSQL.
6. Quand tous les matchs de poule prévus sont terminés, le serveur crée automatiquement le tableau éliminatoire jusqu’à la finale. Les deux premiers de chaque groupe sont qualifiés ; si l’option est activée, les meilleurs troisièmes sélectionnés complètent le tableau. Les exemptions (BYE) sont propagées automatiquement.
7. Pour un match éliminatoire nul, saisir aussi les tirs au but avec un score différent afin de déterminer le vainqueur. Le vainqueur passe automatiquement au match suivant.

## Couleurs du classement public
- Vert à droite de la ligne : les deux premières équipes de chaque groupe.
- Bleu à droite : meilleur troisième qualifié ou troisième candidat si l’option est activée.

## Important
- Génère le tirage seulement lorsque toutes les équipes sont inscrites : la génération ferme les inscriptions pour préserver le calendrier.
- Le tirage peut être recréé uniquement tant qu’aucun résultat n’a été saisi. Les résultats existants ne sont pas supprimés par une génération accidentelle.
- Fais une sauvegarde de PostgreSQL avant le déploiement. Les tests de syntaxe des fichiers ne remplacent pas un test sur la base Render réelle.
