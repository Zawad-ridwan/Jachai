import { MSG, send } from '../../shared/messages.js';
import { state, setState } from '../state.js';
import { runAction, escapeHtml as h } from '../ui-helpers.js';

// "Send feedback" screen (the speech-bubble button in the header).
// Regular and Pro users can tell the Jachai team what works, what
// doesn't and how to fix it, or which features they'd like. Admins read it in
// the admin portal.

const MIN = 10;
const MAX = 2000;
const length = (text) => [...text.trim()].length;

export function renderFeedback(root) {
  if (state.feedbackSent) {
    root.innerHTML = `
      <div class="feedback">
        <button class="back">← Back</button>
        <div class="card feedback-thanks" role="status">
          <h1>Thanks!</h1>
          <p>Your feedback was sent to the Jachai team.</p>
          <div class="row">
            <button id="fb-done" class="primary">Back to Jachai</button>
            <button id="fb-another" class="secondary">Send more feedback</button>
          </div>
        </div>
      </div>`;
    const done = () => setState({ view: 'dashboard', feedbackSent: false, error: null });
    root.querySelector('.back').addEventListener('click', done);
    root.querySelector('#fb-done').addEventListener('click', done);
    root.querySelector('#fb-another').addEventListener('click', () => setState({ feedbackSent: false }));
    return;
  }

  root.innerHTML = `
    <div class="feedback">
      <button class="back">← Back</button>
      <h1>Send feedback</h1>
      <p class="muted small">Tell us what works well, what doesn’t work and how we could fix it, or which new features you’d like.</p>
      <label class="sr-only" for="fb-text">Your feedback</label>
      <textarea id="fb-text" rows="6" maxlength="${MAX}"
        placeholder="e.g. The fact-check is great for news. The image tab could…">${h(state.feedbackDraft)}</textarea>
      <div class="paste-meta muted small">
        <span id="fb-hint"></span>
        <span id="fb-count"></span>
      </div>
      <button id="fb-submit" class="primary full">Submit</button>
      ${state.error ? `<p class="error">${h(state.error)}</p>` : ''}
    </div>`;

  const textarea = root.querySelector('#fb-text');
  const submit = root.querySelector('#fb-submit');

  // Typing must not re-render (that would move the cursor), so these update in place.
  const refresh = () => {
    const n = length(state.feedbackDraft);
    root.querySelector('#fb-count').textContent = `${[...state.feedbackDraft].length.toLocaleString()} / ${MAX.toLocaleString()}`;
    root.querySelector('#fb-hint').textContent = n > 0 && n < MIN ? `At least ${MIN} characters` : '';
    submit.disabled = state.busy || n < MIN;
    submit.textContent = state.busy ? 'Sending…' : 'Submit';
  };
  refresh();

  root.querySelector('.back').addEventListener('click', () => setState({ view: 'dashboard', error: null }));

  textarea.addEventListener('input', () => {
    state.feedbackDraft = textarea.value; // kept in state, so a re-render doesn't lose it
    refresh();
  });

  submit.addEventListener('click', () => {
    const message = state.feedbackDraft.trim();
    if (length(message) < MIN) return;
    runAction(async () => {
      await send(MSG.FEEDBACK_SEND, { message });
      setState({ feedbackDraft: '', feedbackSent: true });
    }); // on error runAction shows it, and the draft stays
  });
}
