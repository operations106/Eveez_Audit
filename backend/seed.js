// node seed.js  -> creates first admin (user: admin / pass: admin123 - CHANGE IT)
const db = require('./db'), bcrypt = require('bcryptjs');
(async () => {
  await db.collection('users').doc('admin').set({ id:'admin', role:'admin', name:'Admin', hash: bcrypt.hashSync('admin123', 10) });
  console.log('admin created'); process.exit();
})();
