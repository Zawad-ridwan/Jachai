// Fills the database with fake users and ~4 months of billing history so the
// admin dashboard has something to show. For local testing only.
//
//   npm run seed:demo              add 60 demo users
//   npm run seed:demo -- --reset   remove all demo users and their billing history
//
// Demo accounts can log in with the password: Demo@1234
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { getProPricePoisha } from '../services/settings.js';

const DEMO_DOMAIN = 'demo.multishield.test';
const USERS = 60;
const DAY = 86_400_000;
const price = getProPricePoisha(); // current Pro price, in poisha
const iso = (ms) => new Date(ms).toISOString();
const rand = (min, max) => min + Math.random() * (max - min);

if (process.argv.includes('--reset')) {
  const like = `%@${DEMO_DOMAIN}`;
  db.transaction(() => {
    db.prepare(`DELETE FROM billing_events WHERE external_id LIKE 'demo\\_%' ESCAPE '\\'`).run();
    const { changes } = db.prepare('DELETE FROM users WHERE email LIKE ?').run(like);
    console.log(`Removed ${changes} demo users and their billing history.`);
  })();
  process.exit(0);
}

const NAMES = ['Ayesha', 'Rahim', 'Nusrat', 'Tanvir', 'Farhana', 'Imran', 'Sadia', 'Arif',
  'Mitu', 'Kamal', 'Priya', 'Daniel', 'Sofia', 'Liam', 'Mei', 'Omar'];

const hash = bcrypt.hashSync('Demo@1234', 10); // follows the sign-up password rules
const runId = Date.now().toString(36);
const now = Date.now();

const insertUser = db.prepare(`
  INSERT INTO users (email, password_hash, display_name, role, subscription_expires_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertEvent = db.prepare(`
  INSERT INTO billing_events (user_id, type, amount_cents, currency, external_id, created_at) VALUES (?, ?, ?, 'bdt', ?, ?)
`);

const result = db.transaction(() => {
  let paid = 0;
  let churned = 0;

  for (let i = 0; i < USERS; i++) {
    const signup = now - rand(0, 120) * DAY;
    const events = [];
    let role = 'regular';
    let expires = null;

    if (Math.random() < 0.45) {
      const subAt = Math.min(now - DAY / 24, signup + rand(0, 20) * DAY);
      events.push(['subscribed', price, subAt]);
      const cancelAt = Math.random() < 0.3 ? subAt + rand(10, 100) * DAY : Infinity;
      let periodEnd = subAt + 30 * DAY;
      while (periodEnd < now && periodEnd < cancelAt) {
        events.push(['renewed', price, periodEnd]);
        periodEnd += 30 * DAY;
      }
      if (cancelAt < now) {
        events.push(['cancelled', 0, cancelAt]);
        churned++;
      } else {
        role = 'paid';
        expires = iso(periodEnd);
        paid++;
      }
    }

    const email = `demo-${runId}-${i}@${DEMO_DOMAIN}`;
    const name = `${NAMES[i % NAMES.length]} (demo)`;
    const { lastInsertRowid } = insertUser.run(email, hash, name, role, expires, iso(signup), iso(signup));
    const id = Number(lastInsertRowid);
    events.forEach(([type, cents, at], j) => insertEvent.run(id, type, cents, `demo_${id}_${j}`, iso(at)));
  }
  return { paid, churned };
})();

console.log(`Added ${USERS} demo users: ${result.paid} on Pro, ${result.churned} who cancelled, the rest free.`);
console.log('They can log in with the password "demo-password".');