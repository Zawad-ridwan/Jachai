// Tiny pub/sub store. Every view reads from `state` and calls `setState()` to
// change it; `render()` re-draws whichever view is currently active.
//
// Values marked 'loading' are set by plain assignment (not setState), so a
// view that starts a load while rendering can't trigger itself in a loop.

export const state = {
  view: 'dashboard', // 'dashboard' | 'profile' | 'upgrade' | 'feedback' | 'auth'
  tab: 'paste', // dashboard tab: 'paste' | 'images' | 'dark' | 'results'
  session: { signedIn: false }, // { signedIn, user, quota }
  notifications: { notifications: [], unreadCount: 0 },
  plans: null,
  invoices: null,

  pasteDraft: '',
  pasteTasks: [], // nothing is switched on until the person picks a check
  pageImages: null, // null | 'loading' | { title, url, images } | { error }
  selectedImages: [], // ids of chosen page images and uploads ('up-1', ...)
  uploads: [], // images picked from the device: { id, name, mimeType, size, data, thumb }, in memory only
  uploadProblems: [], // why some chosen files weren't accepted
  imageTextTasks: [], // checks to run on the text found in images; none until the person picks
  dark: null, // null | 'scanning' | { findings, counts, total } | { error }
  pageTox: null, // null | { entryId } for the whole-page toxicity scan started from this popup
  results: [],
  resultsLoaded: false,

  feedbackDraft: '', // what the person has typed on the feedback screen
  feedbackSent: false, // show the thank-you message

  bellOpen: false,
  busy: false,
  error: null,
};

const listeners = new Set();

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn(state));
}

export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}