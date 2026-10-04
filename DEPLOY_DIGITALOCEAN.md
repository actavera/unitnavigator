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
pm2 start ecosystem.config.cjs
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

## Updating From GitHub

```bash
cd /var/www/unitnavigator
git pull
npm ci --omit=dev
pm2 restart unitnavigator
```

## Persistent Data

SQLite data lives in `data/`, and uploaded vehicle photos live in `public/uploads/`.
Those are ignored by Git and should be backed up from the droplet.

## PDF Preparation and E-Sign

Stirling PDF runs in Docker on the same droplet and is bound only to `127.0.0.1:8085`. PM2 supplies `STIRLING_PDF_URL=http://127.0.0.1:8085` to Unit Navigator. If Stirling login/API authentication is enabled later, also provide `STIRLING_PDF_API_KEY` in the PM2 environment.

DocuSeal is the e-sign provider. Supply Unit Navigator's own `DOCUSEAL_API_KEY` in the PM2 process environment; `DOCUSEAL_BASE_URL` is optional and only needed for a self-hosted DocuSeal instance (it defaults to `https://api.docuseal.com`). Do not reuse Blue Rhino Bath's signing credential — Unit Navigator has its own dedicated DocuSeal account. Completed submissions are checked through Unit Navigator so the signed PDF and its audit log can be freshly re-downloaded and archived locally under `data/esign-archives/`.

## Public Showroom Visibility: Production Audit Required

The public showroom (`/api/public/*` and the share-preview metadata) is now opt-in and strict:

- A dealership is served only if `status = 'active'` **and** `public_site_enabled = 1`. `NULL` and `0` are both hidden.
- Selection is by `?dealer=<slug or numeric id>` or by a matching `public_domain` host. There is **no fallback**: a missing, unknown, disabled, or mismatched selection returns an empty showroom and identifies no dealership. An explicit `?dealer=` that does not match never falls through to host matching.
- Only `ready` units are published. Units in auction, transport, recon, pending, or any other stage are never listed or fetchable.
- VIN, minimum price, costs, and internal fields are never returned.
- Dealerships created through the admin API start with `public_site_enabled = 0`. A database created fresh from this code also defaults the column to `0`. An existing database keeps its table-level default of `1`, which SQLite cannot change in place, so every `INSERT INTO dealerships` must set the column explicitly (the admin route does). **No existing production value is changed by this release, and no bulk change should be made without the audit below.**

Previously, a request with no selection, or an unmatched host such as the bare platform domain, silently served the first active dealership's showroom. After this release those requests return an empty showroom, so a live showroom that relied on that behavior goes blank.

### Audit before deploying (read-only)

Run as root on the droplet and review every row. Do not edit anything from this output without a deliberate decision per dealership.

```bash
cd /var/www/unitnavigator
node -e 'const D=require("better-sqlite3");const db=new D("data/unitnavigator.db",{readonly:true});console.table(db.prepare("SELECT id,name,status,public_site_enabled,public_slug,public_domain FROM dealerships ORDER BY id").all());console.table(db.prepare("SELECT dealership_id,stage,COUNT(*) AS units FROM units WHERE archived_at IS NULL GROUP BY dealership_id,stage ORDER BY dealership_id,stage").all())'
```

Check that:

1. Every dealership that should have a public showroom has `public_site_enabled = 1`, `status = 'active'`, and a `public_slug` or `public_domain` that its customers actually use. `NULL` in `public_site_enabled` now means hidden.
2. No live link or embed depends on the bare platform domain, or on a URL with no dealer, to show a default dealership.
3. Each public showroom has at least one `ready` unit, or it will show as empty.
4. Any dealership that should not be public has `public_site_enabled = 0`.

After deploying, open each live showroom and confirm it still loads. Numeric-id lookup (`?dealer=<id>`) is kept temporarily for existing links, under the same active-and-enabled rule.
