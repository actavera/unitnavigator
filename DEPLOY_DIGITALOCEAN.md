# Unit Navigator DigitalOcean Deployment

This app runs as a Node/Express process behind Nginx.

## DNS

Point these records at the droplet public IP:

- `A unitnavigator.com -> DROPLET_IP`
- `A www.unitnavigator.com -> DROPLET_IP`

## Server Setup

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## App Setup

```bash
cd /var/www
sudo git clone git@github.com:actavera/unitnavigator.git unitnavigator
sudo chown -R $USER:$USER /var/www/unitnavigator
cd /var/www/unitnavigator
npm ci --omit=dev
npm run seed
# JWT_SECRET is required in production -- see "Required Production Configuration" below
JWT_SECRET="$(openssl rand -hex 32)" pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Nginx

```bash
sudo cp deploy/nginx-unitnavigator.conf /etc/nginx/sites-available/unitnavigator
sudo ln -s /etc/nginx/sites-available/unitnavigator /etc/nginx/sites-enabled/unitnavigator
sudo nginx -t
sudo systemctl reload nginx
```

## HTTPS

```bash
sudo certbot --nginx -d unitnavigator.com -d www.unitnavigator.com
```

## Required Production Configuration: JWT_SECRET

With `NODE_ENV=production`, the app **refuses to start** unless `JWT_SECRET` is set (`middleware/auth.js`). A deploy without it crash-loops and the site returns 502 from Nginx. Set it before the first start, and verify it before every restart.

- **Generate on the server, never in chat, a ticket, or the repo.** `ecosystem.config.cjs` is tracked in git and must never contain it. Do not paste it into a shell command that is logged or shared.
- **Store it root-only, in PM2's environment.** The app runs as `unitnavigator` in **root's** PM2 (`/var/www/unitnavigator` is root-owned). Set it as root, then persist it:

```bash
cd /var/www/unitnavigator
JWT_SECRET="$(openssl rand -hex 32)" pm2 restart unitnavigator --update-env
pm2 save
```

- **Back it up.** Keep a copy in your password manager. If the PM2 process is deleted and recreated without it, the secret is lost and every session is invalidated again.
- **Expect sessions to end.** Changing or first setting `JWT_SECRET` signs every user out; they simply log in again. Rotate it only deliberately.
- **Refresh vs. persist.** `--update-env` copies the current shell environment into the running process; `pm2 save` writes it to PM2's saved list so it survives a reboot. A plain `pm2 restart unitnavigator` (no `--update-env`) keeps the stored values and is the normal way to restart.

### Pre-restart configuration check

Run this as root before every restart. It confirms the stored process environment has a `JWT_SECRET` of at least 32 characters, without printing it. It exits non-zero if the secret is missing, so do not restart until it passes.

```bash
pm2 jlist 2>/dev/null | node -e 'const raw=require("fs").readFileSync(0,"utf8");const a=JSON.parse(raw.slice(raw.indexOf("[{")));const p=a.find(x=>x.name==="unitnavigator");const ok=Boolean(p&&p.pm2_env&&p.pm2_env.JWT_SECRET&&String(p.pm2_env.JWT_SECRET).length>=32);console.log(ok?"JWT_SECRET: set (value not shown)":"JWT_SECRET: MISSING or too short");process.exit(ok?0:1)'
```

## Updating From GitHub

Run as root (the checkout and PM2 process are root-owned).

```bash
cd /var/www/unitnavigator
# 1. Pre-restart configuration check (see above) -- must print "JWT_SECRET: set"
# 2. Update
git pull
npm ci --omit=dev
# 3. Restart and confirm it stays up
pm2 restart unitnavigator
pm2 list | grep unitnavigator
pm2 logs unitnavigator --lines 30 --nostream
```

`npm ci` can take a minute or two while `better-sqlite3` installs its native module; let it finish. Afterwards confirm the process is `online` with an unchanged restart count, the log shows no new errors, and `https://unitnavigator.com/home` returns 200.

## Persistent Data

SQLite data lives in `data/`, and uploaded vehicle photos live in `public/uploads/`.
Those are ignored by Git and should be backed up from the droplet.

## PDF Preparation and E-Sign

Stirling PDF runs in Docker on the same droplet and is bound only to `127.0.0.1:8085`. PM2 supplies `STIRLING_PDF_URL=http://127.0.0.1:8085` to Unit Navigator. If Stirling login/API authentication is enabled later, also provide `STIRLING_PDF_API_KEY` in the PM2 environment.

DocuSeal is the e-sign provider. Supply Unit Navigator's own `DOCUSEAL_API_KEY` in the PM2 process environment; `DOCUSEAL_BASE_URL` is optional and only needed for a self-hosted DocuSeal instance (it defaults to `https://api.docuseal.com`). Do not reuse Blue Rhino Bath's signing credential — Unit Navigator has its own dedicated DocuSeal account. Completed submissions are checked through Unit Navigator so the signed PDF and its audit log can be freshly re-downloaded and archived locally under `data/esign-archives/`.
