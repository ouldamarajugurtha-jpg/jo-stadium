# JO STADIUM — V7 corrections inscriptions et calendrier

Cette version s'appuie sur le projet V6 et corrige les problèmes d'inscription des équipes ainsi que l'affichage du classement.

## Corrections incluses

- Le ticket d'inscription est conservé dans le navigateur (`localStorage`) et reste visible après un rafraîchissement de la page.
- L'inscription ne déclenche plus un rechargement complet de la page juste après la création du ticket.
- Le rafraîchissement périodique de la liste des tournois est suspendu pendant qu'un formulaire est ouvert ou contient des coordonnées, afin de ne pas effacer la saisie.
- Les champs saisis en cours d'inscription sont conservés comme brouillon de session si la page doit être réaffichée.
- Le serveur attribue automatiquement chaque nouvelle équipe au groupe le moins rempli, avec tirage aléatoire entre les groupes de même taille. Le groupe est affiché sur le ticket.
- Les groupes attribués sont conservés quand l'administrateur génère le calendrier.
- Le calendrier de poule génère toutes les rencontres aller simple automatiquement. Exemple : 8 équipes, 2 groupes de 4 = 12 matchs de poule.
- Lorsque tous les matchs de poule sont terminés, le serveur crée la phase éliminatoire automatiquement. Les vainqueurs avancent jusqu'à la finale après l'enregistrement du score (et des tirs au but si le match est à égalité).
- Le classement public affiche une boule bleue à droite des deux places qualificatives et une boule rouge pour le meilleur troisième qualifié, si l'option est activée.
- Les réponses publiques n'exposent pas les téléphones des capitaines ni les codes de tickets dans les données de groupes.

## Installation sur Render

1. Sauvegarder le projet actuel.
2. Remplacer les fichiers du projet par ceux de cette archive en gardant la structure des dossiers.
3. Garder la base PostgreSQL existante et les variables `DATABASE_URL` et `ADMIN_PASSWORD`.
4. Commande de démarrage : `npm start`.
5. Déployer puis tester avec un tournoi de test avant une vraie compétition.

## Procédure de tournoi

1. Créer un tournoi avec le nombre d'équipes et de groupes voulus.
2. Laisser les équipes s'inscrire : chaque équipe reçoit son ticket et un groupe est attribué automatiquement.
3. Après les inscriptions, ouvrir la gestion du tournoi, choisir la date du premier match, l'heure de départ et le nombre de matchs par jour, puis cliquer une fois sur **Générer le tirage + calendrier**.
4. Saisir seulement les scores et les cartons pour chaque rencontre générée. Modifier les dates/heures si besoin.
5. Quand tous les matchs de poule sont terminés, les rencontres éliminatoires sont créées automatiquement jusqu'à la finale.

La génération du calendrier verrouille les inscriptions pour protéger le tirage et les résultats. Pour ajouter une équipe après cette étape, il faut réinitialiser le calendrier depuis une procédure d'administration adaptée.
