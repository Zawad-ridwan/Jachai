import { setState } from './state.js';
import { errorText } from '../shared/format.js';

export { errorText, escapeHtml, coins, clip, fmtDate, fmtTimeAgo, fmtMoney, fmtCountdown } from '../shared/format.js';

/**
 * Runs an async action with a shared busy flag and error banner, so every
 * view gets the same "disable buttons while working, show errors" behavior
 * without repeating the try/catch everywhere.
 */
export async function runAction(action) {
  setState({ busy: true, error: null });
  try {
    await action();
  } catch (err) {
    setState({ error: errorText(err) });
  } finally {
    setState({ busy: false });
  }
}