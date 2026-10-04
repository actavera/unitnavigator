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

## Database and Data Directory Permissions

`data/` holds the SQLite database (`unitnavigator.db`, `-wal`, `-shm`), signed-document archives (`data/esign-archives/`), and everything else that must never be public. It must be readable **only by the account that runs Unit Navigator**. On the production droplet the app runs as `root` under root's PM2, so `data/` must be `root:root`, mode `700`, and the database files mode `600`.

An earlier deployment left `data/` at `755` and the database files at `644`. Any local account on the droplet (the same machine also runs other apps under other accounts) could read password hashes and customer records. Treat the steps below as required.

### What the application now enforces

On **every start**, before opening the database (`database.js`, `services/dataDirSecurity.js`):

- creates `data/` as `700` if missing and tightens it to exactly `700` if it was looser;
- tightens `unitnavigator.db` and any existing `-wal`, `-shm`, `-journal` files to `600`;
- tightens the main file **before** turning on WAL. SQLite creates `-wal`/`-shm` with the main file's permissions, so every WAL/SHM file recreated after a restart, a crash, or a reboot is also `600`.

Immediately before listening, `server.js` re-verifies the directory and every database file. If anything is still readable by group/other, the directory is owned by a different account, or a database file is a symlink, the process **exits with a `Data directory security check failed` error and never accepts traffic**. In PM2 that shows as `errored` and in the error log; fix the cause, do not bypass the check.

Deliberately **not** done: no process-wide `umask`. A restrictive umask would silently change the mode of every other file the process writes (for example uploaded photos in `public/uploads/`, which Node serves). Protection comes from the `700` directory plus `600` database files. Signed-document archives inside `data/` are covered by the directory.

### Production remediation (run as root, in this order)

Step 1 closes the exposure immediately and needs no restart or downtime (root is unaffected by these modes). Steps 2-4 make it durable.

```bash
# 1. Close the exposure now
chmod 700 /var/www/unitnavigator/data
chmod 600 /var/www/unitnavigator/data/unitnavigator.db*
stat -c '%a %U:%G %n' /var/www/unitnavigator/data /var/www/unitnavigator/data/*

# 2. Confirm another account can no longer read it (run as a NON-root user, e.g. the deploy user)
test -r /var/www/unitnavigator/data/unitnavigator.db && echo "STILL EXPOSED" || echo "private"
ls /var/www/unitnavigator/data 2>&1 | head -1      # expect: Permission denied

# 3. Deploy the code that enforces this on every start
cd /var/www/unitnavigator && git pull && pm2 restart unitnavigator
pm2 list | grep unitnavigator                         # expect: online
pm2 logs unitnavigator --lines 30 --nostream          # expect: no "Data directory security check failed"

# 4. Re-check after the restart and after some real traffic (WAL/SHM are recreated and written)
stat -c '%a %U:%G %n' /var/www/unitnavigator/data /var/www/unitnavigator/data/*
```

Expected result: `data` is `700 root:root`; every `unitnavigator.db*` file is `600 root:root`. Also confirm `/root` is `700` (`stat -c '%a' /root`): PM2's saved environment, including `JWT_SECRET`, lives in `/root/.pm2/`.

**Rollback:** the code change does not alter data. To undo only the permissions, `chmod 755` the directory and `chmod 644` the files; this reopens the exposure and should not be done. If the app errors on start with the security message, run `chown -R root:root /var/www/unitnavigator/data` (or the runtime account that owns the process), then restart.

### After the exposure window

The database was readable by other local accounts, so assume password hashes (bcrypt) and customer data could have been read. Review who has accounts on the droplet and whether any of them is untrusted; if so, consider forcing password resets. This is a decision for the owner, not an automatic step.

### Reboot survival

The permission fix survives a reboot because it is applied by the application on each start, not by a one-time `chmod`. The app itself must also start on boot. The only systemd PM2 unit found on the droplet is `pm2-actavera.service`; there was **no unit for root's PM2**, which is the one that runs `unitnavigator`. Check and, if missing, register it:

```bash
systemctl is-enabled pm2-root          # "not-found" means root's PM2 is not started at boot by systemd
pm2 startup systemd -u root --hp /root # prints/installs the unit
pm2 save
```

Do not reboot to test this without a maintenance window; verify with `systemctl is-enabled pm2-root` and `systemctl status pm2-root`.

### Backups (none existed at the time of this audit)

No database backup was found on the droplet. Backups must never be group/world-readable and must never be written into `data/`'s parent web tree, `public/`, or `/tmp`. Use a root-only directory and SQLite's online backup, which is safe while the app is running:

```bash
umask 077
install -d -m 700 /root/backups/unitnavigator
cd /var/www/unitnavigator
node -e 'const D=require("better-sqlite3");const fs=require("fs");const db=new D("data/unitnavigator.db",{readonly:true});const out="/root/backups/unitnavigator/unitnavigator-"+new Date().toISOString().replace(/[:.]/g,"-")+".db";db.backup(out).then(()=>{fs.chmodSync(out,0o600);console.log("backup written:",out);db.close()}).catch(e=>{console.error("BACKUP FAILED",e.message);process.exit(1)})'
stat -c '%a %U:%G %n' /root/backups/unitnavigator /root/backups/unitnavigator/*
```

Expected: the directory is `700` and each backup file is `600`. Copy backups off the droplet only over an encrypted channel to storage that is itself access-controlled, and keep photo uploads (`public/uploads/`) in the backup plan separately. Scheduling (for example a root cron entry that runs the command above under `umask 077`) and retention are still to be decided.
