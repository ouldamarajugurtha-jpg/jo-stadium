# JO STADIUM — version tournoi améliorée

## Contenu
- `server.js` : serveur Express et API PostgreSQL.
- `index.html` : site public de réservation, avec le logo BaridiMob fourni dans `public/baridimob-logo.png`.
- `admin.html` : administration des réservations.
- `public/tournaments.html` : inscription client, calendrier, résultats et classements publics.
- `public/admin-tournaments.html` : administration du tournoi, création du calendrier, saisie des scores et cartons.
- `public/baridimob-logo.png` : image fournie pour remplacer l'icône bleue créée précédemment.

## Déploiement Render
1. Décompresser l'archive et pousser son contenu dans le dépôt GitHub du service Render.
2. La racine du dépôt doit contenir `server.js`, `package.json`, `index.html`, `admin.html` et le dossier `public/`.
3. Commande de démarrage : `npm start`.
4. Configurer `DATABASE_URL` avec la même base PostgreSQL que celle qui contient les réservations existantes.
5. Configurer `ADMIN_PASSWORD` dans les variables d'environnement Render. Ne pas mettre le vrai mot de passe dans GitHub.
6. Déployer et vérifier `/api/health`, puis les réservations avant de tester les tournois.

## Fonctionnalités tournoi
- Jusqu'à 48 équipes et 12 groupes.
- Qualification optionnelle de 2 à 8 meilleurs troisièmes, ou désactivée.
- Génération du calendrier round-robin, déclenchée lorsque la capacité maximale est atteinte ou manuellement depuis l'administration.
- Modification de la date/heure de chaque match.
- Saisie des scores, jaunes et rouges, avec sauvegarde PostgreSQL.
- Calcul automatique des points (3 victoire, 1 nul), différence de buts, buts marqués et classements.
- Les deux premières places de chaque groupe sont indiquées en vert ; les meilleurs troisièmes qualifiés en bleu.
- Les clients peuvent consulter les tournois, les résultats et les classements, même lorsque les inscriptions sont fermées.

## Important — sauvegarde
Le serveur ajoute les tables et colonnes nécessaires via des migrations idempotentes sans supprimer les réservations existantes. Il faut impérativement conserver la même base PostgreSQL. Faire une sauvegarde de la base avant le déploiement est recommandé.

Le code a été contrôlé pour la syntaxe JavaScript et la structure des fichiers. La connexion à la base Render et les requêtes SQL doivent encore être vérifiées sur l'instance de production, car cette archive ne contient pas les identifiants de ta base.
