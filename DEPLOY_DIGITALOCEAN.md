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
