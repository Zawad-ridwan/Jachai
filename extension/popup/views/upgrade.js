import { MSG, send } from '../../shared/messages.js';
import { state, setState } from '../state.js';
import { runAction, errorText, escapeHtml as h, fmtMoney } from '../ui-helpers.js';

/** state.plans: null = not requested, 'loading' = in flight, 'error' = failed, object = loaded. */
function ensurePlans() {
  if (state.plans !== null) return;
  state.plans = 'loading'; // plain assignment: no re-render, so no loop
  send(MSG.BILLING_PLANS)
    .then((plans) => setState({ plans }))
    .catch((err) => setState({ plans: 'error', error: errorText(err) }));
}

export function renderUpgrade(root) {
  const { user } = state.session;
  const plans = state.plans;

  root.innerHTML = `
    <div class="upgrade">
      <button class="back">\u2190 Back</button>
      <h1>Plans</h1>
      <div id="plans">${
        plans && typeof plans === 'object'
          ? renderPlans(plans, user)
          : plans === 'error'
            ? '<p class="muted">Couldn\u2019t load plans. Close and reopen the popup to try again.</p>'
            : '<p class="muted">Loading\u2026</p>'
      }</div>
      ${state.error ? `<p class="error">${h(state.error)}</p>` : ''}
    </div>
  `;

  root.querySelector('.back').addEventListener('click', () => setState({ view: 'dashboard', error: null }));

  ensurePlans();

  root.querySelector('#checkout-btn')?.addEventListener('click', () => {
    runAction(async () => {
      const result = await send(MSG.BILLING_CHECKOUT);
      // Mock mode upgrades instantly. Stripe mode opens a checkout tab; the popup
      // picks up the new Pro status the next time it's opened.
      if (!result.redirected) setState({ session: result, view: 'dashboard', invoices: null });
    });
  });
}

function renderPlans(plansData, user) {
  return `
    <div class="plans-grid">
      ${plansData.plans
        .map((plan) => {
          const isCurrent = (plan.id === 'regular' && user.role === 'regular') || (plan.id === 'pro' && user.isPro);
          return `
          <div class="plan-card ${plan.id === 'pro' ? 'plan-pro' : ''}">
            <h2>${h(plan.name)}</h2>
            <p class="price">${plan.priceCents === 0 ? 'Free' : `${fmtMoney(plan.priceCents, plansData.currency)}/${h(plan.interval)}`}</p>
            <p class="muted">${plan.dailyTokens === null ? 'Unlimited coins/day' : `${plan.dailyTokens} coins/day`}</p>
            <ul class="feature-list">
              ${plan.features.map((f) => `<li>\u2713 ${h(f)}</li>`).join('')}
            </ul>
            ${
              plan.id === 'pro' && !isCurrent
                ? `<button id="checkout-btn" class="primary full" ${state.busy ? 'disabled' : ''}>
                     Upgrade now
                   </button>`
                : `<p class="current-plan">${isCurrent ? 'Your current plan' : ''}</p>`
            }
          </div>`;
        })
        .join('')}
    </div>
  `;
}