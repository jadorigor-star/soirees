# Soirées du mois

Petite app pour organiser une soirée par mois, chaque fois dans un lieu différent et avec un organisateur différent. Chacun indique s'il vient, seul ou accompagné, et s'il mange 🍽️, chante au karaoké 🎤 ou boit un verre 🍷.

Hébergement : **Cloudflare Workers + D1** (gratuit pour cet usage). Code : **GitHub**, déployé automatiquement à chaque `push` sur `main`.

## Comment ça marche

- **Un seul lien pour tous** : on poste l'adresse de l'app dans les groupes. À la première visite, chacun touche son nom dans la liste ; le téléphone s'en souvient ensuite. Les administrateurs, eux, gardent un lien personnel secret (`/m/xxxx`).
- **WhatsApp et Signal** : l'app prépare les messages (annonce, rappel avant l'échéance, relances individuelles). L'organisateur les colle dans les deux groupes en un clic (bouton WhatsApp, bouton partager pour Signal, ou copier).
- **Organisateur tournant** : l'organisateur de la dernière soirée (ou un admin) crée la suivante et désigne le prochain organisateur. L'app suggère celui qui n'a pas organisé depuis le plus longtemps. Le nouvel organisateur complète le lieu depuis son propre lien.
- **Échéance** : compte à rebours visible par tous, liste de ceux qui n'ont pas répondu, message de rappel prêt à envoyer. Chaque membre peut ajouter la soirée à son agenda (fichier `.ics` avec alarme la veille).
- **Réponses reçues par message** : l'organisateur peut noter « Oui / Non » pour quelqu'un qui a répondu directement dans le groupe.

## Premier démarrage

1. Ouvrez l'adresse de l'app : la première personne crée son profil et devient **admin**. Enregistrez bien le lien personnel affiché dans la barre d'adresse.
2. Dans **Liste de distribution**, ajoutez les membres (nom, groupe WhatsApp ou Signal, téléphone facultatif).
3. Dans **Prévoir la soirée suivante**, créez la première soirée, puis partagez l'annonce dans les deux groupes.

## Déploiement

La base D1 `soirees-db` existe déjà sur le compte Cloudflare (voir `wrangler.jsonc`).

1. Créez un token Cloudflare : *My Profile → API Tokens → Create Token → modèle « Edit Cloudflare Workers »*, puis ajoutez la permission **Account › D1 › Edit**.
2. Dans le repo GitHub : *Settings → Secrets and variables → Actions → New repository secret*, nom `CLOUDFLARE_API_TOKEN`.
3. Poussez sur `main` (ou lancez l'action « Déploiement Cloudflare » à la main). L'app est ensuite en ligne sur `https://soirees.<votre-sous-domaine>.workers.dev`.

Sans GitHub, depuis un ordinateur : `npm install`, `npx wrangler login`, puis `npm run deploy`.

## Développement local

```bash
npm install
npm run dev        # http://localhost:8787
```

## Structure

```
src/index.js               API (Worker) : membres, soirées, réponses, export .ics
public/                    interface (HTML/CSS/JS sans dépendance)
migrations/0001_init.sql   schéma de la base D1
.github/workflows/         déploiement automatique
```
