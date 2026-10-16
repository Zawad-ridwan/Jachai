// Password rules for new passwords (sign-up and change-password).
// The extension shows the same rules as a live checklist
// (extension/shared/password.js), but this file is what actually enforces them.
// Login does NOT use these rules, so accounts created before they existed can still sign in.

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 12;

const RULES = [
  ['length', (pw) => {
    const n = [...pw].length; // count characters, not UTF-16 code units
    return n >= PASSWORD_MIN && n <= PASSWORD_MAX;
  }],
  ['uppercase', (pw) => /[A-Z]/.test(pw)],
  ['lowercase', (pw) => /[a-z]/.test(pw)],
  ['number', (pw) => /[0-9]/.test(pw)],
  // Any printable ASCII symbol: ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
  ['special', (pw) => /[!-/:-@[-`{-~]/.test(pw)],
  ['no_spaces', (pw) => !/\s/.test(pw)],
];

/** Returns the ids of the rules the password breaks (an empty array means it's fine). */
export function passwordProblems(pw) {
  if (typeof pw !== 'string') return RULES.map(([id]) => id);
  return RULES.filter(([, ok]) => !ok(pw)).map(([id]) => id);
}
