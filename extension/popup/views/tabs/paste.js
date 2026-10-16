import { MSG, send } from '../../../shared/messages.js';
import { TASKS, TEXT_TASKS, MAX_TEXT, canUse, detectLanguage, LANGUAGE_LABEL } from '../../../shared/tasks.js';
import { state, setState } from '../../state.js';
import { runAction, escapeHtml as h, coins } from '../../ui-helpers.js';
import { simplifyOnDevice } from '../../ondevice.js';

function costLabel(task, locked) {
  const t = TASKS[task];
  if (locked) return 'PRO';
  if (t.runsOn === 'device') return 'free \u00b7 on-device';
  return coins(t.cost);
}

function languageText(text) {
  const label = LANGUAGE_LABEL[detectLanguage(text)];
  return label ? `Detected: ${label}` : '';
}

export function renderPaste(root) {
  const { user, quota } = state.session;
  const selected = () => state.pasteTasks.filter((t) => canUse(t, user.role));
  const cost = () => selected().reduce((sum, t) => sum + TASKS[t].cost, 0);
  const overBudget = () => quota.limit !== null && cost() > quota.remaining;

  root.innerHTML = `
    <div class="paste">
      <textarea id="paste-text" rows="6" maxlength="${MAX_TEXT}"
        placeholder="Paste text in English or Bangla (\u09AC\u09BE\u0982\u09B2\u09BE)\u2026">${h(state.pasteDraft)}</textarea>
      <div class="paste-meta muted small">
        <span id="lang-label">${languageText(state.pasteDraft)}</span>
        <span id="char-count">${state.pasteDraft.length.toLocaleString()} / ${MAX_TEXT.toLocaleString()}</span>
      </div>

      <div class="task-grid" role="group" aria-label="Checks to run">
        ${TEXT_TASKS.map((task) => {
          const locked = !canUse(task, user.role);
          const on = !locked && state.pasteTasks.includes(task);
          return `
            <label class="task-toggle ${on ? 'on' : ''} ${locked ? 'locked' : ''}" title="${h(TASKS[task].label)}">
              <input type="checkbox" data-task="${task}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''} />
              <span class="task-name">${h(TASKS[task].short)}</span>
              <span class="task-cost">${costLabel(task, locked)}</span>
            </label>`;
        }).join('')}
      </div>
      ${
        user.role === 'regular'
          ? `<p class="muted small">Emotion and fact-checking are Pro checks. <button id="paste-upgrade" class="link">Upgrade</button></p>`
          : ''
      }

      <button id="run-analysis" class="primary full"></button>
      <p id="budget-note" class="error" hidden>Not enough coins left today for these checks.</p>
    </div>
  `;

  const textarea = root.querySelector('#paste-text');
  const runBtn = root.querySelector('#run-analysis');

  // Typing must not re-render (that would reset the text box), so the button,
  // language label and counter are updated in place.
  const refresh = () => {
    const n = selected().length;
    const c = cost();
    runBtn.textContent = n ? `Run ${n} check${n === 1 ? '' : 's'}${c ? ` \u00b7 ${coins(c)}` : ''}` : 'Pick at least one check';
    runBtn.disabled = state.busy || !state.pasteDraft.trim() || n === 0 || overBudget();
    root.querySelector('#budget-note').hidden = !overBudget();
  };
  refresh();

  textarea.addEventListener('input', () => {
    state.pasteDraft = textarea.value;
    root.querySelector('#lang-label').textContent = languageText(textarea.value);
    root.querySelector('#char-count').textContent =
      `${textarea.value.length.toLocaleString()} / ${MAX_TEXT.toLocaleString()}`;
    refresh();
  });

  root.querySelector('.task-grid').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-task]');
    if (!box) return;
    const others = state.pasteTasks.filter((t) => t !== box.dataset.task);
    setState({ pasteTasks: box.checked ? [...others, box.dataset.task] : others });
  });

  root.querySelector('#paste-upgrade')?.addEventListener('click', () => setState({ view: 'upgrade' }));

  runBtn.addEventListener('click', () => {
    const text = state.pasteDraft.trim();
    const tasks = TEXT_TASKS.filter((t) => selected().includes(t)); // stable order
    runAction(async () => {
      const onDevice = [];
      for (const task of tasks) {
        const { id } = await send(MSG.ANALYZE_TEXT, { task, text });
        if (TASKS[task].runsOn === 'device') onDevice.push(id);
      }
      setState({ tab: 'results' });
      // Started straight from this click, which Chrome requires for the first model download.
      const language = detectLanguage(text);
      for (const id of onDevice) simplifyOnDevice(id, text, language);
    });
  });
}