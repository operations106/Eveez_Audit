# Vehicle Audit App
## Backend (Node.js)
1. Firebase console > Firestore enable > Project settings > Service accounts > Generate key -> save as backend/serviceAccount.json
2. Set env ADMIN_PASSWORD; admin user is auto-created on first start (or run npm run seed locally)
3. JWT_SECRET=<same> npm start   (deploy on Render/Railway/VPS)
4. Firestore: create composite index when the console error link appears (audits: hubId asc + createdAt desc)
## Frontend (Firebase Hosting)
1. Set API const in frontend/index.html to backend URL
2. npm i -g firebase-tools && firebase login && firebase init hosting (public dir: frontend) && firebase deploy
## Use
Admin logs in (admin) -> creates hub IDs. Agent logs in with hub ID -> audits. Admin sees all hubs, filter, CSV.
