# 🐺 Leo's Auctions — Full Stack Platform

Tampa Bay Amazon Return Auction Site with real payments, user accounts, and role-based admin panel.

---

## 🚀 Quick Setup (5 Minutes)

### 1. Install Node.js
Download from https://nodejs.org — **v18 or later required**

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
```
Then open `.env` and fill in your keys (see sections below).

### 4. Set up the database
```bash
npm run setup
```
This creates the SQLite database and seeds default accounts.

### 5. Start the server
```bash
npm start
```
Visit **http://localhost:3000** 🎉

---

## 🔑 Default Login Accounts

| Role     | Email                        | Password          |
|----------|------------------------------|-------------------|
| Owner    | owner@leosauctions.com       | LeoOwner2026!     |
| Manager  | manager@leosauctions.com     | LeoManager2026!   |
| Employee | employee@leosauctions.com    | LeoEmployee2026!  |

> **Change these passwords immediately after first login!**

---

## 💳 Stripe Payment Setup

1. Create a free account at https://stripe.com
2. Go to **Developers → API Keys**
3. Copy your **Publishable key** and **Secret key**
4. Add to `.env`:
```
STRIPE_SECRET_KEY=sk_live_YOUR_KEY
STRIPE_PUBLISHABLE_KEY=pk_live_YOUR_KEY
```
5. For webhooks (optional but recommended):
   - Go to Stripe Dashboard → **Webhooks**
   - Add endpoint: `https://yoursite.com/api/payments/webhook`
   - Select event: `payment_intent.succeeded`
   - Copy the webhook secret to `.env`:
   ```
   STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET
   ```

> 💡 Use `sk_test_` and `pk_test_` keys during development. The demo card number is `4242 4242 4242 4242`.

---

## ☁️ Cloudinary Image Storage Setup

Free tier gives you **25GB storage + 25GB bandwidth/month** — more than enough to start.

1. Sign up free at https://cloudinary.com
2. From your dashboard, copy:
   - **Cloud Name**
   - **API Key**
   - **API Secret**
3. Add to `.env`:
```
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
USE_CLOUDINARY=true
```

Images automatically get resized and optimized. Without Cloudinary, images are stored locally in `backend/uploads/`.

---

## 👥 Role Permissions

| Feature                          | Customer | Employee | Manager | Owner |
|----------------------------------|:--------:|:--------:|:-------:|:-----:|
| Browse & bid                     | ✅       | ✅       | ✅      | ✅    |
| Buy Now / checkout               | ✅       | ✅       | ✅      | ✅    |
| Create listings (draft)          | ❌       | ✅       | ✅      | ✅    |
| Upload photos to listings        | ❌       | ✅       | ✅      | ✅    |
| Edit listing title/description   | ❌       | ✅       | ✅      | ✅    |
| Set/change pricing               | ❌       | ❌       | ✅      | ✅    |
| Replace/delete photos            | ❌       | ❌       | ✅      | ✅    |
| Activate/publish listings        | ❌       | ❌       | ✅      | ✅    |
| Manage orders & pickups          | ❌       | ❌       | ✅      | ✅    |
| View Deal Alert subscribers      | ❌       | ❌       | ✅      | ✅    |
| Manage users                     | ❌       | ❌       | ✅      | ✅    |
| Create employee accounts         | ❌       | ❌       | ✅      | ✅    |
| Create manager accounts          | ❌       | ❌       | ❌      | ✅    |
| Change user roles                | ❌       | ❌       | ❌      | ✅    |
| **View full audit log**          | ❌       | ❌       | ❌      | ✅    |

---

## 📜 Audit Log (Owner Only)

Every significant action is timestamped and attributed:
- Price changes (who changed it, old vs new value)
- Listing creation/edits
- Image uploads/replacements
- Order status changes
- User role changes
- Staff account creation
- Login events

Access via **Admin Panel → Audit Log**

---

## 🔔 Deal Alert Subscribers

This replaces the "Wish List" feature. Customers subscribe with:
- Email address
- Optional: category, keyword, max price, condition filter

Subscribers are visible to Managers and Owners in **Admin → Deal Alert Subscribers**.

Future enhancement: trigger emails when a matching listing goes live (requires email SMTP config).

---

## 📧 Email Notifications (Optional)

Add to `.env`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password    # Gmail App Password, not your login password
FROM_EMAIL=noreply@leosauctions.com
FROM_NAME=Leo's Auctions
```

For Gmail: go to Google Account → Security → 2-Step Verification → App Passwords

---

## 🌐 Production Deployment

### Option A: VPS (DigitalOcean, Linode, etc.)
```bash
# Install PM2 for process management
npm install -g pm2

# Start with PM2
pm2 start backend/server.js --name "leos-auctions"
pm2 save
pm2 startup

# Use nginx as reverse proxy on port 80/443
```

### Option B: Railway / Render (free tier available)
1. Push code to GitHub
2. Connect repo to Railway or Render
3. Set environment variables in their dashboard
4. Deploy — they handle HTTPS automatically

### Option C: Heroku
```bash
heroku create leos-auctions
heroku config:set $(cat .env | xargs)
git push heroku main
```

---

## 🏗️ Project Structure

```
leos-auctions/
├── backend/
│   ├── server.js              # Express app entry point
│   ├── db/
│   │   ├── setup.js           # Database initialization script
│   │   ├── connection.js      # SQLite connection module
│   │   └── leos_auctions.db   # SQLite database (created by setup)
│   ├── middleware/
│   │   └── auth.js            # JWT auth + role guards + audit logger
│   ├── routes/
│   │   ├── auth.js            # Login, register, profile
│   │   ├── listings.js        # Listings CRUD + image upload
│   │   ├── bids.js            # Bidding engine
│   │   ├── payments.js        # Stripe checkout + orders
│   │   ├── admin.js           # Staff admin routes
│   │   └── dealAlerts.js      # Deal alert subscriptions
│   └── uploads/               # Local image storage (if not using Cloudinary)
├── frontend/
│   └── public/
│       └── index.html         # Complete single-page application
├── .env.example               # Environment variable template
├── .env                       # Your config (DO NOT commit to git)
├── package.json
└── README.md
```

---

## 🛡️ Security Notes

- JWT tokens expire after 7 days
- Passwords hashed with bcrypt (cost factor 12)
- Rate limiting: 30 auth requests/15min, 200 API requests/min
- Role validation on every admin endpoint
- SQL injection protected via parameterized queries (better-sqlite3)
- File upload validation (type + size limits)
- Helmet.js security headers

---

## 💡 Next Steps

- [ ] Add SMS notifications (Twilio) for outbid alerts
- [ ] Add email notifications for winning bids
- [ ] Auto-notify Deal Alert subscribers when matching listings go live
- [ ] Add Google/Apple OAuth login
- [ ] Mobile app (React Native)

---

*Built for Leo's Auctions — Tampa Bay, FL*
