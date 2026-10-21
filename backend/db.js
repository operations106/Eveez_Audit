// Firestore via firebase-admin.
// Render: set env FIREBASE_SERVICE_ACCOUNT = full contents of the service-account JSON.
// Local: save the key as backend/serviceAccount.json.
const admin = require('firebase-admin');
const key = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : require('./serviceAccount.json');
admin.initializeApp({ credential: admin.credential.cert(key) });
module.exports = admin.firestore();
