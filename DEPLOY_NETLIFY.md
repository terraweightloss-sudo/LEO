# 🚀 Netlify Deployment Guide — Leo's Auctions

This app has two parts:
- **Frontend** (HTML/CSS/JS) → hosted on **Netlify** (free)
- **Backend** (Node.js/Express/SQLite) → hosted on **Railway** (free tier available)

---

## PART 1 — Deploy the Backend on Railway

Railway is the easiest way to host a Node.js + SQLite backend. Free tier included.

### Step 1: Push your code to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/leos-auctions.git
git push -u origin main
```

### Step 2: Deploy on Railway
1. Go to **https://railway.app** and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `leos-auctions` repo
4. Railway auto-detects Node.js and uses `npm start`

### Step 3: Set environment variables on Railway
In your Railway project → **Variables**, add each of these:

```
NODE_ENV=production
JWT_SECRET=pick-a-long-random-string-here-change-this
PORT=3000

# Stripe (get from stripe.com → Developers → API Keys)
STRIPE_SECRET_KEY=sk_live_YOUR_KEY
STRIPE_PUBLISHABLE_KEY=pk_live_YOUR_KEY
STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET

# Contact form email (Gmail recommended)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-gmail-app-password
CONTACT_TO_EMAIL=your@gmail.com

# Cloudinary (cloudinary.com → Dashboard)
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
USE_CLOUDINARY=true

# Your Netlify frontend URL (fill in after Netlify deploy)
FRONTEND_URL=https://YOUR-SITE.netlify.app
```

### Step 4: Run database setup on Railway
In Railway → your service → **Shell** tab:
```bash
npm run setup
```

### Step 5: Note your Railway URL
Railway gives you a URL like: `https://leos-auctions-production.up.railway.app`
Save this — you'll need it for Netlify.

---

## PART 2 — Deploy the Frontend on Netlify

### Step 1: Update netlify.toml with your Railway URL
Open `netlify.toml` and replace `YOUR-BACKEND-URL.railway.app` with your actual Railway URL:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://leos-auctions-production.up.railway.app/api/:splat"
  status = 200
  force = true
```

Commit and push this change to GitHub.

### Step 2: Connect to Netlify
1. Go to **https://netlify.com** → Log in
2. Click **Add new site → Import an existing project**
3. Choose **GitHub** and select your `leos-auctions` repo
4. Set these build settings:
   - **Base directory**: (leave blank)
   - **Build command**: (leave blank)
   - **Publish directory**: `frontend/public`
5. Click **Deploy site**

### Step 3: Set Netlify environment variables
In Netlify → **Site Settings → Environment Variables**, add:

```
STRIPE_PUBLISHABLE_KEY = pk_live_YOUR_KEY
```

### Step 4: Done! 🎉
Your site is live at `https://YOUR-SITE.netlify.app`

---

## PART 3 — Stripe Webhook Setup

For reliable payment confirmation, set up a Stripe webhook:

1. Go to **Stripe Dashboard → Developers → Webhooks**
2. Click **Add endpoint**
3. URL: `https://YOUR-BACKEND.railway.app/api/payments/webhook`
4. Select event: `payment_intent.succeeded`
5. Copy the **Signing secret** → add to Railway env vars as `STRIPE_WEBHOOK_SECRET`

---

## PART 4 — Gmail App Password (for contact form)

Google requires an "App Password" instead of your real password for SMTP:

1. Go to **myaccount.google.com → Security**
2. Enable **2-Step Verification** (required)
3. Go to **Security → App Passwords**
4. Select **Mail** + **Other** → name it "Leos Auctions"
5. Copy the 16-character password → use as `SMTP_PASS`

---

## Custom Domain (Optional)

In Netlify → **Domain Settings → Add custom domain**
- Point your domain's DNS to Netlify (they'll guide you)
- Free HTTPS certificate included automatically

---

## Quick Checklist

- [ ] Backend deployed on Railway
- [ ] `npm run setup` run on Railway (creates DB + default accounts)
- [ ] Railway env vars set (JWT_SECRET, Stripe keys, SMTP, Cloudinary)
- [ ] `netlify.toml` updated with your Railway URL
- [ ] Frontend deployed on Netlify
- [ ] Stripe webhook configured
- [ ] Default passwords changed (owner@leosauctions.com, etc.)
- [ ] Custom domain connected (optional)

---

## Local Development

```bash
npm install
cp .env.example .env    # Fill in your keys
npm run setup           # Create database
npm start               # → http://localhost:3000
```

Everything runs on one port locally. On Netlify, the frontend is static and `/api/*` is proxied to Railway.

---

*Need help? The README.md has full documentation on all features.*
