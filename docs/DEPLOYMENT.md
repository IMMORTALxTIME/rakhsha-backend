# Rakhsha Backend — Deployment Guide

## Prerequisites
- Ubuntu 22.04 VPS (AWS EC2 t3.small+ / DigitalOcean Droplet 2GB+)
- Domain name with DNS pointed to your server IP
- Supabase project (PostgreSQL + PostGIS)
- Upstash Redis account
- Twilio account, Firebase project, Cloudinary account

---

## 1. Server Setup (AWS EC2 / DigitalOcean)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Docker & Docker Compose
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt install -y docker-compose-plugin

# Install Python 3 + pip (for ML service)
sudo apt install -y python3 python3-pip

# Install Certbot (SSL)
sudo apt install -y certbot nginx

# Create app directory
sudo mkdir -p /opt/rakhsha
sudo chown $USER:$USER /opt/rakhsha
```

---

## 2. Clone & Configure

```bash
cd /opt/rakhsha
git clone https://github.com/your-org/rakhsha-backend.git .

# Set up environment
cp .env.example .env
nano .env  # Fill in all values
```

### Critical .env values to set:
| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Supabase → Settings → Database → URI |
| `REDIS_URL` | Upstash → Redis → Connect details |
| `TWILIO_*` | Twilio Console → Account Info |
| `FIREBASE_*` | Firebase Console → Project Settings → Service Accounts |
| `CLOUDINARY_*` | Cloudinary → Dashboard |
| `GOOGLE_MAPS_API_KEY` | Google Cloud Console → APIs & Services |
| `JWT_SECRET` | Run: `openssl rand -hex 64` |

---

## 3. Database Setup (Supabase)

```bash
# Run migrations against your Supabase DB
DATABASE_URL="postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres" \
  node migrations/run.js
```

Or paste `migrations/001_schema.sql` directly in **Supabase SQL Editor**.

**Enable PostGIS in Supabase:**
```sql
-- Run in Supabase SQL Editor
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

---

## 4. SSL Certificate

```bash
# Stop nginx temporarily
sudo systemctl stop nginx

# Get certificate
sudo certbot certonly --standalone -d yourdomain.com

# Certificates saved to:
# /etc/letsencrypt/live/yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/yourdomain.com/privkey.pem

# Copy certs for Docker
sudo mkdir -p /opt/rakhsha/certs
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem /opt/rakhsha/certs/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem /opt/rakhsha/certs/
sudo chown -R $USER:$USER /opt/rakhsha/certs

# Update nginx.conf with your domain
sed -i 's/yourdomain.com/YOUR_ACTUAL_DOMAIN/g' nginx.conf
```

---

## 5. Deploy with Docker

```bash
cd /opt/rakhsha

# Build and start all services
docker compose up -d --build

# Check logs
docker compose logs -f backend
docker compose logs -f ml-service

# Verify health
curl https://yourdomain.com/health
```

---

## 6. Train ML Model

```bash
# Install Python dependencies
pip3 install xgboost scikit-learn pandas numpy psycopg2-binary

# Train with real DB data
python3 scripts/train_model.py --mode train --db-url "$DATABASE_URL"

# Or start prediction server (runs on port 8001)
python3 scripts/train_model.py --mode both
```

---

## 7. Process Manager (without Docker)

```bash
# Install PM2
npm install -g pm2

# Start backend
pm2 start src/server.js --name rakhsha-backend \
  --max-memory-restart 500M \
  --restart-delay 3000

# Auto-start on reboot
pm2 startup
pm2 save

# Monitor
pm2 monit
```

---

## 8. Auto-backup PostgreSQL

```bash
# Create backup script
cat > /opt/rakhsha/scripts/backup.sh << 'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/rakhsha_backup_$DATE.sql"
pg_dump "$DATABASE_URL" > "$BACKUP_FILE"
gzip "$BACKUP_FILE"
aws s3 cp "$BACKUP_FILE.gz" "s3://$BACKUP_S3_BUCKET/backups/"
rm -f "$BACKUP_FILE.gz"
echo "Backup completed: $DATE"
EOF
chmod +x /opt/rakhsha/scripts/backup.sh

# Add to crontab (daily at 2 AM)
echo "0 2 * * * /opt/rakhsha/scripts/backup.sh" | crontab -
```

---

## 9. Auto-renew SSL

```bash
# Add Certbot renewal hook
echo "0 12 * * * /usr/bin/certbot renew --quiet --deploy-hook 'docker compose -f /opt/rakhsha/docker-compose.yml restart nginx'" | crontab -
```

---

## 10. WebSocket Testing

```javascript
// Test in browser console or Node.js
const io = require('socket.io-client');
const socket = io('wss://yourdomain.com', {
  auth: { token: 'YOUR_JWT_TOKEN' }
});

socket.on('connect', () => console.log('Connected!'));

// Send location update
socket.emit('location-update', { lat: 23.2599, lng: 77.4126, route_id: null });

// Listen for safety alerts
socket.on('safety-alert', (data) => console.log('ALERT:', data));
```

---

## 11. Firewall Rules

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 5000/tcp   # Block direct backend access
sudo ufw deny 6379/tcp   # Block direct Redis access
sudo ufw deny 8001/tcp   # Block direct ML service
sudo ufw enable
```

---

## Monitoring

| Tool | Purpose |
|---|---|
| `docker compose logs -f` | Real-time logs |
| `pm2 monit` | Process monitor |
| `logs/` directory | Winston log files |
| `/health` endpoint | Health check |
| Sentry (optional) | Error tracking — set `SENTRY_DSN` in .env |

---

## Architecture Overview

```
Internet
   │
   ▼
Nginx (80/443) ──── SSL Termination, Rate Limiting
   │
   ▼
Express Backend (5000)
   ├── REST API (/api/v1/*)
   ├── Socket.io (WebSocket)
   └── Swagger UI (/api/docs)
   │
   ├── PostgreSQL + PostGIS (Supabase cloud)
   ├── Redis (Upstash cloud)
   ├── ML Service (Python, port 8001)
   ├── Firebase (FCM push)
   ├── Twilio (SMS)
   └── Cloudinary (media storage)
```
