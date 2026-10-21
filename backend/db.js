// Firestore via firebase-admin. Put serviceAccount.json (Firebase console > Project settings > Service accounts) here.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
module.exports = admin.firestore();
