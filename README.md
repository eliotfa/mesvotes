# mesvotes.fr

**Votez pour des idées. Pas pour des hommes.**

mesvotes est une plateforme de démocratie directe. N'importe qui propose une loi, tout le monde peut l'améliorer, et si elle réunit assez de parrains, on prend des mois pour en débattre avant de voter. Même les règles du jeu (durées, seuils, majorités) se changent par un vote.

C'est un projet citoyen, ouvert à tous les bords politiques. Il n'a aucune valeur légale : c'est une démonstration de ce que pourrait être une démocratie où l'on vote pour des textes plutôt que pour des personnes.

---

## Sommaire

- [Fonctionnement](#fonctionnement)
- [Installer sur un VPS](#installer-sur-un-vps-ubuntu-ou-debian)
- [Configuration](#configuration)
- [Exploitation : mises à jour, sauvegardes, journaux](#exploitation)
- [Déploiement automatique depuis GitHub](#déploiement-automatique-depuis-github)
- [Développer en local](#développer-en-local)
- [Architecture](#architecture)
- [Sécurité et limites connues](#sécurité-et-limites-connues)
- [Licence](#licence)

---

## Fonctionnement

Chaque proposition suit le même parcours, fixé par la **Constitution** de la plateforme :

| Étape | Durée par défaut | Ce qui se passe |
|---|---|---|
| **Projet** | 15 à 90 jours (au choix du porteur) | Tout le monde commente, apporte des sources et propose des amendements sur un paragraphe précis. Le porteur intègre ou refuse. Chaque version est gardée, avec ses différences mot à mot. |
| **Parrainage** | 60 jours maximum | Le texte est figé. Il faut 1 % des inscrits en parrains (minimum 50). Sinon, la proposition est archivée. |
| **Délibération** | 90 à 180 jours (au choix du porteur) | Le vote est annoncé. Temps long pour lire, comparer, débattre. |
| **Vote** | 7 jours | Pour, contre ou abstention, modifiable jusqu'à la clôture. Résultats cachés jusqu'à la fin. |
| **Résultat** | — | Adoptée si plus de 50 % de « pour » parmi les exprimés et au moins 5 % de participation. S'applique automatiquement. |

Les phases avancent toutes seules : une horloge interne vérifie les échéances chaque minute.

**Quatre types de propositions :**

- **Nouvelle loi** : si elle est adoptée, elle entre dans le *recueil des lois* en version 1.
- **Modification** d'une loi adoptée : on réécrit son texte, les différences s'affichent comme sur GitHub. Adoptée, la loi passe à la version suivante.
- **Abrogation** d'une loi adoptée : adoptée, la loi reste consultable mais n'est plus en vigueur.
- **Révision de la Constitution** : changer une règle chiffrée ou un texte de principe. Majorité renforcée (plus de 60 %, 10 % de participation). Si deux révisions se chevauchent, seules les règles touchées par chacune s'appliquent, comme une fusion de branches git.

**Et aussi :** tags et thèmes, recherche et filtres (type, phase, thème, tag, porteur, dates, tri), fichiers joints et liens, variantes (reprendre la proposition de quelqu'un d'autre), cahier « Présidentielle 2027 », votes des mineurs comptés et affichés aussi à part.

**Modération citoyenne :** ce sont les inscrits qui modèrent.

- Tout inscrit peut **signaler** une proposition, une contribution ou un compte, avec un motif (insulte, harcèlement, haine, menace, données personnelles, spam, fausse information, hors sujet, contenu illégal…).
- Dès **3 signalements**, une **affaire** est ouverte et confiée à un **jury de 7 inscrits tirés au sort**, hors la personne concernée et les auteurs des signalements. Une contribution signalée est masquée pendant l'examen.
- Chaque juré choisit une mesure : ne rien faire, masquer, avertir, suspendre 7 ou 30 jours, exclure. **La mesure retenue est la médiane des votes** : la plus sévère qu'au moins la moitié du jury juge justifiée.
- Le jury a **72 heures**. Si moins de la moitié a voté, des remplaçants sont tirés une fois ; ensuite, **le doute profite à l'auteur**.
- La personne sanctionnée peut **faire appel une fois**, devant un jury de 15 inscrits qui n'a jamais vu l'affaire.
- Toutes les décisions sont publiques (sans le contenu) sur la page Modération et dans le journal.
- Ces chiffres sont des règles de la Constitution : ils se changent par une révision votée.
- Un filtre automatique bloque d'emblée insultes, propos haineux, menaces, e-mails et téléphones. L'administration garde un droit d'**intervention d'urgence** pour les contenus manifestement illégaux, toujours inscrit au journal.

On juge la forme, jamais l'opinion.

---

## Installer sur un VPS (Ubuntu ou Debian)

### 1. Pointer le domaine vers le serveur

Chez ton registraire (là où tu as acheté `mesvotes.fr`), crée un enregistrement DNS :

| Type | Nom | Valeur |
|---|---|---|
| `A` | `@` (ou vide) | l'adresse IPv4 de ton VPS |

Facultatif : un enregistrement `AAAA` pour l'IPv6, et `www` si tu veux aussi `www.mesvotes.fr` (voir le `Caddyfile`).

### 2. Lancer l'installation

Connecte-toi en SSH au VPS, puis :

```bash
curl -fsSL https://raw.githubusercontent.com/eliotfa/mesvotes/main/scripts/install.sh | sudo bash -s -- \
  --domain mesvotes.fr --email toi@exemple.fr
```

Le script, en quelques minutes :

1. installe Docker et les outils nécessaires ;
2. télécharge le code dans `/opt/mesvotes` ;
3. crée la configuration `/opt/mesvotes/.env` ;
4. ouvre le pare-feu pour SSH, HTTP et HTTPS uniquement ;
5. démarre l'application et Caddy, qui obtient seul le certificat HTTPS ;
6. programme une sauvegarde quotidienne (gardée 14 jours).

**Ton serveur héberge déjà un autre site ?** Si les ports 80/443 sont occupés (Nginx, Apache…), le script le détecte : mesvotes tourne alors sans son propre Caddy, sur `127.0.0.1:3010`, et il ne reste qu'à ajouter un site dans ton serveur web existant. Guide pas à pas : [docs/reverse-proxy.md](docs/reverse-proxy.md).

Options utiles : `--admin-email moi@exemple.fr` (ce compte deviendra administrateur), `--demo` (mode démo avec données d'exemple), `--no-firewall`, `--dir /autre/dossier`.

### 3. Créer ton compte administrateur

Ouvre `https://mesvotes.fr` et inscris-toi. **Le premier compte créé devient administrateur** (ou celui dont l'e-mail correspond à `ADMIN_EMAIL`). Depuis la page « Admin », tu peux nommer des modérateurs.

> **Démarrer à quelques personnes :** par défaut, il faut 50 parrains pour qu'une proposition passe au débat. Pour tester entre amis, règle les valeurs `INIT_*` dans `.env` **avant le premier lancement** (par exemple `INIT_PARRAINAGE_MIN=3`), ou active le mode démo. Ensuite, ces règles ne changent plus que par une révision votée.

---

## Configuration

Tout se règle dans `/opt/mesvotes/.env` (modèle commenté : [`.env.example`](.env.example)). Après une modification :

```bash
cd /opt/mesvotes && sudo docker compose up -d
```

| Variable | Rôle |
|---|---|
| `DOMAIN`, `BASE_URL` | Domaine et adresse publique du site. |
| `COMPOSE_PROFILES` | `caddy` : HTTPS géré par le Caddy intégré. Vide : derrière ton serveur web ([guide](docs/reverse-proxy.md)). |
| `APP_PORT` | Port local de l'application (défaut `3010`, lié à `127.0.0.1` uniquement). |
| `ACME_EMAIL` | E-mail pour Let's Encrypt (alertes de certificat). |
| `ADMIN_EMAIL` | Ce compte devient administrateur à l'inscription. |
| `DEMO_MODE` | `true` : les administrateurs peuvent passer à l'étape suivante sans attendre. |
| `SEED_DEMO` | `true` : charge des exemples au premier lancement (base vide). |
| `SMTP_*`, `MAIL_FROM` | Envoi d'e-mails (confirmation d'adresse, mot de passe oublié). |
| `INIT_*` | Règles de la Constitution fondatrice, lues une seule fois. |

### Mentions légales

La page « Mentions légales et confidentialité » est générée à partir de `.env`. Renseigne au minimum :

```ini
LEGAL_NAME=Eliot Faggianelli
LEGAL_EMAIL=contact@mesvotes.fr        # adresse de contact réelle
HOSTING_NAME=Nom de ton hébergeur VPS
HOSTING_ADDRESS=Adresse de l'hébergeur
HOSTING_PHONE=Téléphone de l'hébergeur
HOSTING_LOCATION=France
```

Un particulier peut ne pas publier son adresse postale (`LEGAL_ADDRESS` facultatif) à condition d'indiquer l'hébergeur. Un bandeau rappelle aux administrateurs ce qui manque.

### E-mails

Sans SMTP, l'inscription fonctionne directement (pas de confirmation d'adresse) et les liens sont écrits dans les journaux (`docker compose logs app`).

Avec SMTP (Brevo, Mailjet, OVH, Gmail…), chaque compte doit confirmer son adresse avant de proposer, parrainer ou voter, et le « mot de passe oublié » est activé :

```ini
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=ton-identifiant
SMTP_PASS=ton-mot-de-passe-smtp
MAIL_FROM=mesvotes <ne-pas-repondre@mesvotes.fr>
```

---

## Exploitation

Toutes les commandes se lancent dans `/opt/mesvotes`.

| Action | Commande |
|---|---|
| Mettre à jour (sauvegarde + nouveau code + redémarrage) | `sudo ./scripts/update.sh` |
| Sauvegarder maintenant | `sudo ./scripts/backup.sh` |
| Restaurer une sauvegarde | `sudo ./scripts/restore.sh backups/mesvotes-AAAA-MM-JJ_HHMMSS.tar.gz` |
| Voir les journaux | `sudo docker compose logs -f app` |
| Redémarrer | `sudo docker compose restart` |
| État des conteneurs | `sudo docker compose ps` |

Les données vivent dans `data/` : la base `mesvotes.db` (SQLite) et les fichiers joints dans `data/uploads/`. Les sauvegardes sont dans `backups/`. Pense à les copier régulièrement hors du serveur (par exemple avec `rsync` ou `rclone`).

---

## Déploiement automatique depuis GitHub

À chaque `push` sur `main`, GitHub Actions lance les tests, construit l'image Docker puis, si les secrets sont configurés, se connecte au VPS et lance `scripts/update.sh`.

1. Sur ton ordinateur, crée une clé dédiée : `ssh-keygen -t ed25519 -f mesvotes_deploy -N ""`
2. Sur le VPS, ajoute la clé publique : `cat mesvotes_deploy.pub >> ~/.ssh/authorized_keys` (pour l'utilisateur qui déploiera ; s'il n'est pas root, il doit pouvoir lancer `sudo ./scripts/update.sh` sans mot de passe).
3. Sur GitHub : **Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Valeur |
|---|---|
| `VPS_HOST` | adresse IP ou nom du serveur |
| `VPS_USER` | utilisateur SSH (défaut : `root`) |
| `VPS_SSH_KEY` | contenu du fichier `mesvotes_deploy` (clé privée) |
| `VPS_PORT` | port SSH, si différent de 22 |
| `VPS_DIR` | dossier d'installation, si différent de `/opt/mesvotes` |

Sans ces secrets, le déploiement est simplement ignoré et les tests tournent quand même.

---

## Développer en local

Il faut seulement **Node.js 22.13 ou plus récent**. Aucune dépendance à installer : le serveur utilise uniquement les modules intégrés à Node (`node:http`, `node:sqlite`, `node:crypto`).

```bash
git clone https://github.com/eliotfa/mesvotes.git
cd mesvotes
npm run dev     # http://localhost:3000, mode démo + données d'exemple
npm test        # tests de bout en bout de l'API
```

La base de développement est créée dans `./data/`. Supprime ce dossier pour repartir de zéro.

---

## Architecture

```
mesvotes/
├── server/                 Serveur Node.js (aucune dépendance)
│   ├── index.js            HTTP, fichiers statiques, en-têtes de sécurité, horloge
│   ├── api.js              Routes de l'API JSON
│   ├── lifecycle.js        Cycle de vie des propositions et application des résultats
│   ├── moderation.js       Signalements, jurys tirés au sort, sanctions, appels
│   ├── model.js            Accès aux données et mise en forme
│   ├── db.js               SQLite (node:sqlite) et migrations
│   ├── auth.js             Mots de passe (scrypt), sessions, jetons
│   ├── antibot.js          Preuve de travail, délai minimum, champ piège
│   ├── mail.js             Client SMTP minimal
│   ├── seed.js             Données d'exemple
│   └── config.js           Variables d'environnement
├── public/                 Interface web (HTML, CSS, JavaScript sans framework)
│   ├── js/app.js           Application d'une seule page
│   └── shared/             Code partagé navigateur ↔ serveur :
│       ├── constitution.js   règles, articles, validation, fusion des révisions
│       ├── diff.js           différences mot à mot
│       ├── moderation.js     filtre automatique
│       └── util.js
├── test/api.test.js        Tests de bout en bout (node:test)
├── scripts/                install, update, backup, restore
├── Dockerfile · docker-compose.yml · Caddyfile
└── .github/workflows/ci.yml
```

La Constitution, le calcul des différences et le filtre de modération sont écrits une seule fois et utilisés des deux côtés : l'interface prévient tout de suite, le serveur fait foi.

### API (résumé)

| Méthode | Adresse | Rôle |
|---|---|---|
| `GET` | `/api/bootstrap` | Compte connecté, Constitution (toutes versions), statistiques |
| `POST` | `/api/auth/register` · `login` · `logout` · `forgot` · `reset` · `resend` | Comptes |
| `GET` | `/api/proposals?q&kind&phase&theme&tag&author&from&to&only27&mine&sort` | Liste filtrée |
| `POST` | `/api/proposals` | Déposer une proposition |
| `GET` | `/api/proposals/:id` | Détail complet (versions, débat, résultats) |
| `POST` | `/api/proposals/:id/versions` · `notes` · `parrainage` · `vote` | Participer |
| `PATCH` | `/api/proposals/:id/meta` | Thèmes et tags (porteur, phase Projet) |
| `POST` | `/api/notes/:id/decision` | Intégrer ou refuser un amendement |
| `POST` | `/api/reports` | Signaler (`type` : `note`, `proposal` ou `user`, `id`, `reason`, `comment`) |
| `GET` | `/api/moderation` · `/api/cases/:id` | Décisions publiques, affaires à juger, détail d'une affaire |
| `POST` | `/api/cases/:id/vote` · `/api/cases/:id/appeal` | Vote d'un juré, appel de la personne concernée |
| `GET/POST` | `/api/notifications` · `/api/notifications/read` | Notifications |
| `GET` | `/api/users/:pseudo` | Profil public |
| `GET` | `/api/laws` · `/api/laws/:id` · `/api/constitution` · `/api/journal` | Données publiques |
| `POST` | `/api/uploads` | Fichier joint (corps brut, en-tête `x-file-name`) |
| `GET/POST` | `/api/mod/*` · `/api/admin/*` | Modération et administration |

Toute requête d'écriture doit porter l'en-tête `x-mesvotes: 1` (protection CSRF).

---

## Sécurité et limites connues

**Anti-robot, sans service extérieur ni case à cocher :** l'inscription, la connexion et le mot de passe oublié demandent une preuve de travail (le navigateur calcule en arrière-plan, environ 0,2 seconde, ce qui coûte cher à un robot qui crée des milliers de comptes), un délai minimum de 2 secondes à l'inscription et un champ piège invisible. Réglages : `ANTIBOT_BITS` et `ANTIBOT_MIN_SECONDS` dans `.env`. Aucun cookie ni traceur tiers.

**En place :** mots de passe hachés avec scrypt, sessions en cookie `HttpOnly` / `SameSite=Lax` / `Secure`, protection CSRF, en-têtes de sécurité stricts (CSP, HSTS, anti-iframe), limitation des tentatives (inscription, connexion, publication), fichiers joints servis en mode isolé, validation et modération côté serveur, conteneur sans droits root, pare-feu.

**Limites assumées à ce stade :**

- **Pas de vérification d'identité.** Une même personne peut créer plusieurs comptes avec plusieurs e-mails. Les options (niveaux de confiance, parrainage, prestataire de vérification) sont décrites dans [docs/identite-et-vote-secret.md](docs/identite-et-vote-secret.md).
- **Le secret du vote n'est pas cryptographique.** La base associe chaque vote à un compte (c'est ce qui permet de changer d'avis jusqu'à la clôture). Les résultats ne sont publiés qu'agrégés, mais un administrateur ayant accès au serveur pourrait lire les votes. Une évolution prévue : des bulletins anonymes avec jetons à usage unique (voir le document ci-dessus).
- **Mineurs :** l'âge est déclaratif.
- **Données personnelles :** si le site s'ouvre largement, les opinions politiques sont des données sensibles au sens du RGPD. Il faudra alors une politique de confidentialité, des mentions légales et une analyse d'impact.

---

## Licence

[GNU AGPL v3](LICENSE). Tu peux utiliser, modifier et redistribuer ce logiciel. Si tu le fais tourner pour d'autres sur un serveur, tu dois publier ton code modifié sous la même licence. Un outil démocratique doit rester transparent.
