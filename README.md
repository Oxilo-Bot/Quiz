# Quiz Live

Petit site statique type Kahoot pour GitHub Pages, avec Supabase pour la base SQL et le temps reel.

## Lancer le projet

Ouvre `index.html` dans le navigateur, ou lance un petit serveur local :

```bash
npm install
npm run dev
```

## Configurer Supabase

1. Cree un projet sur Supabase.
2. Ouvre l'editeur SQL Supabase.
3. Execute le fichier `supabase.sql`.
4. Ouvre `supabase-config.js`.
5. Remplace `REMPLACE_MOI_PAR_TA_PUBLIC_KEY` par ta public/publishable key Supabase.

Le code admin n'est pas stocke dans les fichiers du site. Cree-le directement dans Supabase en ajoutant une ligne dans `admin_codes` avec un hash genere par `extensions.crypt('ton-code', extensions.gen_salt('bf'))`.

La public/publishable key peut etre presente cote navigateur. Ne mets jamais la secret key dans les fichiers. Les policies du fichier SQL sont ouvertes pour faciliter le prototype, sauf la table `admin_codes` qui passe par la fonction `verify_admin_code`. Pour une version publique serieuse, il faudra ajouter Supabase Auth et limiter les droits admin.

## Publier sur GitHub Pages

1. Mets ces fichiers dans un depot GitHub.
2. Va dans `Settings > Pages`.
3. Choisis la branche principale et le dossier racine.
4. Ouvre l'URL GitHub Pages.

## Fonctionnalites

- Creation de quiz par un admin local.
- Acces admin via code verifie par Supabase.
- Ajout de questions avec 4 reponses et une bonne reponse.
- Images de questions via Supabase Storage.
- Modification et suppression des questions par l'admin.
- Limite de 20 questions par quiz.
- Creation d'une session avec code a 6 chiffres.
- Lobby joueur avec pseudo.
- Verrouillage temporaire des entrees et exclusion de joueurs par l'admin.
- Deroule live question puis top 10 avec bouton continuer.
- Questions et scores synchronises via Supabase Realtime.
- Classement final.

## Prochaines ameliorations utiles

- Authentification admin Supabase.
- Timer visible cote joueur.
- Bonus de points selon la vitesse.
- Suppression et reorganisation des questions.
- Mode plein ecran pour l'ecran admin.
