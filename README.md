# EV Hub Audit — Setup

## 1. Firebase
1. console.firebase.google.com → naya project → **Firestore Database** enable karo (production mode; sirf backend access karta hai).
2. Project Settings → Service accounts → **Generate new private key** (JSON).

## 2. Backend (Node.js)
cd backend && npm install
cp .env.example .env     # JWT_SECRET, ADMIN_USER, ADMIN_PASS bharo
# FIREBASE_SERVICE_ACCOUNT me JSON ko single line me paste karo
npm start                # pehli baar chalte hi admin ban jayega

Deploy: Google Cloud Run / Render / Railway (koi bhi Node host). Cloud Run par service account env ki zaroorat nahi.

## 3. Frontend (Firebase Hosting)
Edit frontend/public/config.js → API_URL = deployed backend URL
npm i -g firebase-tools && firebase login && firebase init hosting  (public dir: frontend/public, SPA: No)
firebase deploy --only hosting
Backend .env me CORS_ORIGIN = apna hosting URL rakho.

## Flow
Admin login → Parts tab me parts+price (bulk paste) → Hubs tab me hub ID+password banao → Agent ko do.
Agent: Hub ID se login → New Audit. Admin: Report tab me hub/date/vehicle filter, CSV, print.
