// Usage: npm run seed:admin -- admin@example.com "Adm1n@pass"
// The password must follow the sign-up rules: 8-12 characters with an uppercase
// letter, a lowercase letter, a number and a special character, and no spaces.
import bcrypt from 'bcryptjs';
import { db, queries } from '../db.js';
import { passwordProblems } from '../services/password.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run seed:admin -- <email> <password>');
  process.exit(1);
}
const problems = passwordProblems(password);
if (problems.length) {
  console.error(`That password doesn't meet the rules (${problems.join(', ')}).`);
  console.error('Use 8-12 characters with an uppercase letter, a lowercase letter, a number and a special character, and no spaces.');
  console.error('Tip: wrap it in double quotes so your terminal doesn\'t treat symbols like & or ! specially.');
  process.exit(1);
}

const normalized = email.trim().toLowerCase();
const hash = bcrypt.hashSync(password, 12);
const existing = queries.userByEmail.get(normalized);

if (existing) {
  db.prepare(
    "UPDATE users SET role = 'admin', password_hash = ?, token_version = token_version + 1 WHERE id = ?",
  ).run(hash, existing.id);
  console.log(`Promoted ${normalized} to admin.`);
} else {
  db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')").run(normalized, hash);
  console.log(`Created admin ${normalized}.`);
}