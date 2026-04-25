# 🛡️ Rakhsha — Intelligent Safe-Route Navigation Backend

> Production-ready backend for a women's safety app with real-time tracking, ML crime prediction, SOS alerts, and smart routing.

---

## ✨ Features

| Module | Description |
|---|---|
| **Auth** | JWT + refresh tokens, bcrypt, encrypted PII |
| **A\* Routing** | Shortest + weather-aware + lit-street routes via Google Maps |
| **Crime Prediction** | XGBoost ML model — risk score 0–100 with color coding |
| **Reporting** | Geo-tagged community reports with image/audio upload |
| **Real-time Tracking** | Socket.io — deviation detection (>50m), stop alerts (>2min) |
| **SOS Blast** | Push (FCM) + SMS (Twilio) + Email to all emergency contacts |
| **Fake Call** | Returns caller details + script for safety disguise |
| **Health/Stealth Mode** | Backend tracks normally; UI shows disguise |
| **Guardian System** | Invite guardians, live location sharing, relay alerts |
| **Smart Watch** | Wear OS / Apple Watch sync via WebSocket |
| **Check-in** | Safety logs with geo + battery + note |
| **Heatmap** | Aggregated crime + report density for map rendering |
| **Rate Limiting** | 100 req/min general, 10 req/min SOS, 10 req/15min auth |
| **Media** | Multer → Cloudinary (images, audio, video) |
| **Scheduler** | SOS escalation, check-in reminders, DB cleanup crons |

---

## 🚀 Quick Start (Local Dev)

```bash
git clone https://github.com/your-org/rakhsha-backend
cd rakhsha-backend
cp .env.example .env        # Fill in your credentials
npm install
node migrations/run.js      # Run DB migrations
npm run dev                 # Start with nodemon
```

Open `http://localhost:5000/api/docs` for Swagger UI.

---

## ☁️ Deploy on Railway (Free — Recommended for Hackathon)

**1. Push to GitHub**
```bash
git init && git add . && git commit -m "initial"
# Create repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/rakhsha-backend.git
git push -u origin main
```

**2. Deploy**
```
1. Go to railway.app → Login with GitHub
2. New Project → Deploy from GitHub repo
3. Select rakhsha-backend → Deploy
```

**3. Add environment variables**
```
Railway dashboard → your project → Variables → Raw Editor
→ Paste contents of rakhsha-hackathon.env
→ Fill in the 6 placeholder values with your real keys
→ Save (Railway auto-restarts)
```

**4. Run migrations** (from your laptop, once only)
```bash
# With your real Supabase URL:
DATABASE_URL=postgresql://postgres:PASS@db.xxxx.supabase.co:5432/postgres \
  node migrations/run.js
```

**5. Get your live URL**
```
Railway → Settings → Domains → Generate Domain
→ https://rakhsha-backend-xxxx.up.railway.app
```

Open `https://your-app.up.railway.app/api/docs` — share this with judges.

---

## 📁 Project Structure

```
src/
├── server.js              # Express + Socket.io entry point
├── config/
│   ├── database.js        # PostgreSQL pool
│   ├── redis.js           # Redis client + cache helpers
│   ├── firebase.js        # FCM admin SDK
│   ├── upload.js          # Multer + Cloudinary
│   └── swagger.js         # OpenAPI spec
├── routes/
│   ├── auth.js            # POST /register /login /emergency-contacts
│   ├── route.js           # POST /shortest /lit-street /safe-refuges /reroute
│   ├── crime.js           # GET /risk/:lat/:lng /hotspots /trends
│   ├── reports.js         # POST /report  GET /heatmap /nearby
│   ├── sos.js             # POST /trigger /fake-call /cancel
│   ├── guardian.js        # Guardian relationships
│   └── safety.js          # Check-in, health mode, watch sync
├── middleware/
│   ├── auth.js            # JWT protect + socket auth
│   ├── rateLimiter.js     # Redis-based rate limiting
│   └── errorHandler.js    # Global error handler
├── services/
│   ├── notificationService.js  # FCM + Twilio + Email
│   ├── routingService.js       # A* + Google Maps + weather
│   ├── crimeService.js         # ML scoring + heuristics
│   └── schedulerService.js     # Cron jobs
├── websocket/
│   └── socketManager.js   # Location tracking, deviation, guardians
└── utils/
    ├── AppError.js
    ├── logger.js           # Winston daily rotate
    ├── encryption.js       # AES-256-CBC for PII
    └── geoUtils.js         # Haversine, A*, PostGIS helpers
migrations/
├── 001_schema.sql          # Full DB schema + indexes + triggers + seeds
└── run.js                  # Migration runner
scripts/
└── train_model.py          # XGBoost ML training + prediction server
docs/
├── DEPLOYMENT.md           # Railway (hackathon) + AWS/DigitalOcean (production) guide
└── Rakhsha_API.postman_collection.json
```

---

## 🌐 API Endpoints

### Auth
| Method | Endpoint | Auth |
|---|---|---|
| POST | `/api/auth/register` | ❌ |
| POST | `/api/auth/login` | ❌ |
| POST | `/api/auth/logout` | ✅ |
| POST | `/api/auth/refresh` | ❌ |
| POST | `/api/auth/emergency-contacts` | ✅ |
| GET  | `/api/auth/me` | ✅ |

### Route
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/route/shortest` | A* + crime-weighted routing |
| POST | `/api/route/lit-street` | Weather + night-aware routing |
| POST | `/api/route/safe-refuges` | Nearby police/hospital/cafe |
| POST | `/api/route/reroute` | Recompute on deviation |
| GET  | `/api/route/history` | User route history |

### Crime
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/crime/risk/:lat/:lng` | ML risk score (0-100) |
| GET | `/api/crime/hotspots` | Top 20 crime clusters |
| GET | `/api/crime/trends` | Hour/day crime patterns |

### SOS
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/sos/trigger` | Blast push+SMS+email to contacts |
| POST | `/api/sos/cancel` | Cancel active SOS |
| POST | `/api/sos/fake-call` | Return fake caller details |
| GET  | `/api/sos/history` | SOS event history |

### WebSocket Events
| Event | Direction | Description |
|---|---|---|
| `location-update` | Client→Server | Send GPS coords |
| `safety-alert` | Server→Client | Deviation / stop alert |
| `sos-confirmed` | Server→Client | SOS acknowledgment |
| `watch-user` | Client→Server | Guardian starts tracking |
| `user-location` | Server→Guardian | Live location relay |
| `watch-connect` | Client→Server | Wearable connects |
| `watch-sync` | Server→Watch | Route + alert data |

---

## 🔐 Security

- JWT access tokens (7d) + refresh tokens (30d)
- Token blacklist on logout (Redis)
- AES-256-CBC encryption for phone numbers
- bcrypt (cost 12) for passwords
- Redis rate limiting per user (100 req/min)
- Helmet.js security headers
- CORS whitelist
- Socket.io JWT auth middleware

---

## 🤖 ML Crime Prediction

```bash
# Train model (uses DB data or synthetic fallback)
python3 scripts/train_model.py --mode train

# Start prediction microservice on port 8001
python3 scripts/train_model.py --mode serve

# Both
python3 scripts/train_model.py --mode both --db-url "$DATABASE_URL"
```

Features used: hour, day-of-week, season, crime type, severity, spatial bin, night/weekend flags.

---

## 📦 Tech Stack

- **Runtime**: Node.js 20 + Express 4
- **Database**: PostgreSQL 14 + PostGIS (Supabase)
- **Cache**: Redis (Upstash)
- **WebSocket**: Socket.io 4
- **Auth**: JWT + bcrypt
- **Push**: Firebase Admin (FCM)
- **SMS**: Twilio
- **Email**: Nodemailer (SendGrid)
- **Media**: Multer + Cloudinary
- **ML**: Python 3 + XGBoost + scikit-learn
- **Routing**: Google Maps Directions API + A*
- **Weather**: OpenWeatherMap API
- **Logs**: Winston + Daily Rotate
- **Scheduler**: node-cron
- **Docs**: Swagger UI (OpenAPI 3.0)
- **Deploy**: Railway (free) / Docker + Nginx + PM2 (production)

---

## 📄 License

MIT © Rakhsha Team
