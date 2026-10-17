# Servir mesvotes derrière un serveur web existant

Si ton VPS héberge déjà un autre site, les ports 80 et 443 sont occupés par ton serveur web (Nginx, Apache, Caddy…). Dans ce cas, mesvotes tourne **sans son propre Caddy** : l'application écoute seulement en local sur `127.0.0.1:3010` (réglable avec `APP_PORT` dans `.env`), et ton serveur web lui transmet les visites de `mesvotes.fr`.

Vérifie d'abord que l'application répond :

```bash
curl http://127.0.0.1:3010/healthz     # doit afficher {"ok":true}
```

Le DNS de `mesvotes.fr` doit pointer vers ce serveur (enregistrement `A`).

---

## Nginx (le plus courant)

**1. Crée le site** `/etc/nginx/sites-available/mesvotes.fr` :

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mesvotes.fr;

    client_max_body_size 12m;   # fichiers joints jusqu'à 10 Mo

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**2. Active-le et recharge Nginx :**

```bash
sudo ln -s /etc/nginx/sites-available/mesvotes.fr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**3. Ajoute le certificat HTTPS** (Certbot modifie la configuration tout seul) :

```bash
sudo apt install -y certbot python3-certbot-nginx   # si Certbot n'est pas déjà installé
sudo certbot --nginx -d mesvotes.fr
```

C'est en ligne sur `https://mesvotes.fr`.

---

## Apache

```bash
sudo a2enmod proxy proxy_http headers
```

Crée `/etc/apache2/sites-available/mesvotes.fr.conf` :

```apache
<VirtualHost *:80>
    ServerName mesvotes.fr
    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3010/
    ProxyPassReverse / http://127.0.0.1:3010/
    RequestHeader set X-Forwarded-Proto "http"
    LimitRequestBody 12582912
</VirtualHost>
```

```bash
sudo a2ensite mesvotes.fr && sudo apachectl configtest && sudo systemctl reload apache2
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d mesvotes.fr
```

---

## Caddy déjà installé sur le serveur

Ajoute à ton `Caddyfile` existant, puis `sudo systemctl reload caddy` :

```caddy
mesvotes.fr {
	request_body {
		max_size 12MB
	}
	reverse_proxy 127.0.0.1:3010
}
```

---

## Points importants

- **Ne transmets pas l'en-tête `X-Forwarded-For` en l'ajoutant** (`$proxy_add_x_forwarded_for`) : utilise `$remote_addr`, comme ci-dessus. mesvotes s'en sert pour limiter les tentatives de connexion par adresse, et une valeur ajoutée pourrait être falsifiée par le visiteur.
- **`BASE_URL` dans `.env` doit être `https://mesvotes.fr`** : c'est ce qui active les cookies sécurisés et les bons liens dans les e-mails.
- Le port `3010` n'est jamais ouvert sur internet : Docker le lie à `127.0.0.1` uniquement.
- Pour repasser plus tard au Caddy intégré (serveur dédié à mesvotes), mets `COMPOSE_PROFILES=caddy` dans `.env` puis `sudo docker compose up -d`.
