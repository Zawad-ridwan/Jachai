import { MSG, send } from '../../shared/messages.js';
import { state, setState } from '../state.js';
import { runAction, escapeHtml as h } from '../ui-helpers.js';
import { PASSWORD_MAX, passwordOk, passwordChecklist, updateChecklist } from '../../shared/password.js';

let mode = 'login'; // 'login' | 'signup'
// What the person has typed, so a re-render (e.g. after an error) doesn't wipe the form.
const draft = { displayName: '', email: '', password: '' };

export function renderAuth(root) {
  root.innerHTML = `
    <div class="auth-card">
      <h1 class="brand">\u{1F6E1}\uFE0F Jachai</h1>
      <p class="muted">${mode === 'login' ? 'Log in to your account' : 'Create your account'}</p>

      <form id="auth-form" novalidate>
        ${
          mode === 'signup'
            ? `<input id="displayName" type="text" placeholder="Name (optional)" maxlength="60" value="${h(draft.displayName)}" />`
            : ''
        }
        <input id="email" type="email" placeholder="Email" autocomplete="email" required value="${h(draft.email)}" />
        ${
          mode === 'signup'
            ? `<input id="password" type="password" placeholder="Password (8\u201312 characters)" autocomplete="new-password"
                 required minlength="8" maxlength="${PASSWORD_MAX}" value="${h(draft.password)}" aria-describedby="pw-rules" />
               <div id="pw-rules">${passwordChecklist(draft.password)}</div>`
            : `<input id="password" type="password" placeholder="Password" autocomplete="current-password" required
                 value="${h(draft.password)}" />`
        }
        <button type="submit" class="primary full" ${state.busy ? 'disabled' : ''}>
          ${state.busy ? 'Please wait\u2026' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
      </form>

      <button id="toggle-mode" class="link full">
        ${mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
      </button>

      ${state.error ? `<p class="error">${state.error}</p>` : ''}
    </div>
  `;

  const form = root.querySelector('#auth-form');
  const submitBtn = form.querySelector('button[type="submit"]');
  const pwInput = root.querySelector('#password');
  const rules = root.querySelector('#pw-rules');

  // Sign up stays disabled until every password rule passes.
  const refresh = () => {
    if (mode === 'signup') submitBtn.disabled = state.busy || !passwordOk(pwInput.value);
  };
  refresh();

  // Typing never re-renders (that would move focus), so the checklist and button update in place.
  form.addEventListener('input', (e) => {
    if (e.target.id in draft) draft[e.target.id] = e.target.value;
    if (e.target === pwInput && rules) updateChecklist(rules, pwInput.value);
    refresh();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = root.querySelector('#email').value.trim();
    const password = pwInput.value;
    const displayName = root.querySelector('#displayName')?.value.trim();
    if (mode === 'signup' && !passwordOk(password)) return;

    runAction(async () => {
      const session =
        mode === 'login'
          ? await send(MSG.AUTH_LOGIN, { email, password })
          : await send(MSG.AUTH_SIGNUP, { email, password, displayName: displayName || undefined });
      Object.assign(draft, { displayName: '', email: '', password: '' }); // signed in: forget the form
      setState({ session, view: 'dashboard' });
    });
  });

  root.querySelector('#toggle-mode').addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    draft.password = ''; // a login password shouldn't carry over into "choose a new password"
    setState({ error: null }); // triggers a re-render via the app's subscriber
  });
}