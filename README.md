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

## 4. Email reports (Google Apps Script + Gmail) — Brevo ki ab zaroorat nahi
Report email ab Google Apps Script se Gmail ke through jata hai. Code: `apps-script/Code.gs`.

**A. Apps Script banao**
1. Us Google account se login karo jisse mail bhejni hai (best: `operations@eveez.in` account) → script.google.com → **New project** → naam: `EV Hub Audit Mailer`.
2. `Code.gs` ka pura content `apps-script/Code.gs` se paste karo (purana code hata do). (Optional: Project Settings → "Show appsscript.json" ON karke `apps-script/appsscript.json` bhi paste kar do.)
3. ⚙ **Project Settings → Script properties → Add**:
   - `SCRIPT_SECRET` = lamba random string (`openssl rand -hex 32`). Ise code me mat likho.
   - `SENDER_EMAIL` = `operations@eveez.in` (optional, default yahi hai)
   - `ALLOWED_DOMAIN` = `eveez.in` (optional)
4. Editor me function `checkSetup` select karke **Run** → Google permission maangega (Gmail) → Allow. Execution log me dikhega "Will send from: ..." — yahi final sender hai.
   (Optional: `sendTestToMe` run karo, test mail apne inbox me aa jayegi.)

**B. Sender kaun hoga**
- Script `operations@eveez.in` se tabhi bhejti hai jab (a) script usi account se chal rahi ho, ya (b) us account ke Gmail me `operations@eveez.in` **Settings → Accounts → Send mail as** me verified alias ho.
- Warna mail us Google account se jati hai jisme script deploy hui hai (response me `sender` field me dikhta hai).

**C. Web App deploy**
1. **Deploy → New deployment → ⚙ Web app**. Execute as: **Me**. Who has access: **Anyone**. → Deploy.
2. `https://script.google.com/macros/s/.../exec` URL copy karo. (Anyone isliye zaroori hai ki backend bina Google login ke call kar sake; asli security `SCRIPT_SECRET` hai.)
3. Code badalne par: **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy** (URL wahi rahega).

**D. Backend env (Render / Cloud Run me, code me nahi)**
```
GOOGLE_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
GOOGLE_SCRIPT_SECRET=<wahi jo SCRIPT_SECRET me dala>
MAIL_FROM_NAME=EV Hub Audit
MAIL_ALLOWED_DOMAIN=eveez.in      # optional
```
Purane `BREVO_API_KEY` / `MAIL_FROM` hata do. Redeploy karo.

**E. Test**
Admin login → Report tab → email daalo → Send. "bhej diya" tabhi dikhega jab Apps Script ne Gmail se mail nikal di; koi bhi galti (galat secret, quota, access) UI me error ke roop me aayegi. Email me **Vehicles + Total RFD cost** upar dikhte hain aur poora vehicle-wise data (RFD cost + parts) `audit-report.csv` attachment me hota hai.
Limits: Gmail daily quota (free ~100 recipients/day, Workspace ~1500). Max 10 recipients per report.

## Flow
Admin login -> **Hubs** tab me hub ka naam add karo (hub ka login nahi hota) -> **Agents** tab me agent ka Login ID + password banao -> Agent ko do.
Agent: apni Login ID se login -> New Audit me **hub select** + vehicle number -> parts ki khuli list me scroll karke qty daalo aur Add dabao.
Har Add / qty change backend me draft ke roop me save hota hai; page refresh ho to wahi vehicle wapas khul jata hai. Save audit dabane par draft final audit ban jata hai.
Admin: Report tab me hub/agent/date/vehicle filter, CSV, print.

## Purane data ka migration
Pehli baar naya backend chalte hi: purane har agent-login ke naam se ek hub ban jayega (same ID) aur purane audits ko us agent se jod diya jayega. Kuch manually karna nahi hai.
