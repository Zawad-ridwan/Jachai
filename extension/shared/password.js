// Password rules shown as a live checklist on the sign-up and change-password forms.
// Must match backend/src/services/password.js, which is what actually enforces them.

export const PASSWORD_MAX = 12;

export const PASSWORD_RULES = Object.freeze([
  { id: 'length', label: '8 to 12 characters', test: (pw) => [...pw].length >= 8 && [...pw].length <= PASSWORD_MAX },
  { id: 'uppercase', label: 'An uppercase letter (A–Z)', test: (pw) => /[A-Z]/.test(pw) },
  { id: 'lowercase', label: 'A lowercase letter (a–z)', test: (pw) => /[a-z]/.test(pw) },
  { id: 'number', label: 'A number (0–9)', test: (pw) => /[0-9]/.test(pw) },
  { id: 'special', label: 'A special character (e.g. ! @ # $ %)', test: (pw) => /[!-/:-@[-`{-~]/.test(pw) },
  { id: 'no_spaces', label: 'No spaces', test: (pw) => !/\s/.test(pw) },
]);

export const passwordOk = (pw) => PASSWORD_RULES.every((r) => r.test(String(pw ?? '')));

/** The checklist's HTML. Labels are fixed text, so nothing here needs escaping. */
export function passwordChecklist(pw = '') {
  return `<ul class="pw-rules" aria-live="polite">${PASSWORD_RULES.map(
    (r) => `<li data-rule="${r.id}" class="${r.test(pw) ? 'ok' : ''}">${r.label}</li>`,
  ).join('')}</ul>`;
}

/** Ticks/unticks the checklist in place while the person types (no re-render, so focus stays put). */
export function updateChecklist(list, pw) {
  for (const r of PASSWORD_RULES) list.querySelector(`[data-rule="${r.id}"]`)?.classList.toggle('ok', r.test(pw));
}
