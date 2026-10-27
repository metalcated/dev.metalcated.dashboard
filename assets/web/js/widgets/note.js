// Sticky note (read-only).

import { el } from '../dom.js';
import { subscribe } from '../realtime.js';
import { state } from '../state.js';

// The colours the Homey app offers, in its order, as it stores them.
export const NOTE_COLORS = {
  yellow: '#fef49c',
  red: '#ffb3b0',
  green: '#deffdb',
  blue: '#bce1fe',
};

// The note's text lives in its widget store; the key isn't documented, so take the first string.
function noteText(stored) {
  if (typeof stored === 'string') return stored;
  if (stored == null || typeof stored !== 'object') return '';
  for (const key of ['text', 'content', 'value', 'note']) {
    if (typeof stored[key] === 'string') return stored[key];
  }
  return Object.values(stored).find((entry) => typeof entry === 'string') ?? '';
}

export function mountNote({ body, widget }) {
  const sticky = el('div', 'sticky-note');
  sticky.style.background = NOTE_COLORS[widget.data?.color] ?? NOTE_COLORS.yellow;
  body.append(sticky);
  let stored = {};

  const show = () => {
    const text = noteText(stored);
    sticky.textContent = text || 'Empty note';
    sticky.classList.toggle('is-empty', !text);
  };

  state.client.api('GET', `/api/manager/dashboards/widgetstore/${encodeURIComponent(widget.id)}/state`)
    .then((result) => {
      stored = result ?? {};
      show();
    })
    .catch((error) => {
      // A note nobody has written on has no store yet.
      if (error.status === 404) show();
      else sticky.textContent = error.message;
    });

  return subscribe(`homey:widgetstore:${widget.id}`, 'state', ({ state: next, replace }) => {
    stored = replace || typeof next !== 'object' || next === null ? next : { ...stored, ...next };
    show();
  });
}
