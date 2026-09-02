/**
 * Moving between the two interfaces over one simulation.
 *
 * `?player` is what decides which shell gets built — the developer shell is
 * the default, the player interface is the opt-in — and it is decided once at
 * startup, the runtime composed around the answer, so switching is a
 * navigation, not a toggle. Every other query parameter is carried across
 * unchanged, because a session is usually pinned to something else as well
 * (`?terrain=synthetic`, `?fixedDpr=1`, a capture port) and losing that on the
 * way to the developer tools would be its own small betrayal.
 */

/** Rebuild the current URL's query with `player` set or removed. */
export function interfaceSearch(
  search: string,
  target: 'developer' | 'player',
): string {
  const params = new URLSearchParams(search);
  if (target === 'player') {
    if (!params.has('player')) params.set('player', '1');
  } else {
    params.delete('player');
  }
  const next = params.toString();
  return next.length > 0 ? `?${next}` : '';
}

/** Reload into the other interface, keeping everything else about the URL. */
export function switchInterface(target: 'developer' | 'player'): void {
  const next = interfaceSearch(window.location.search, target);
  // Assigning `search` reloads. An empty string still clears the query, but
  // only via the full href — assigning '' to `search` is a no-op in some
  // browsers.
  if (next.length > 0) window.location.search = next;
  else window.location.href = window.location.pathname;
}

/** The header button both shells carry, so the way back is always in reach. */
export function createInterfaceSwitchButton(
  target: 'developer' | 'player',
  className: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = target === 'developer' ? 'Dev' : 'Player';
  button.title =
    target === 'developer'
      ? 'Switch to the full developer tools'
      : 'Switch to the player interface (?player)';
  button.addEventListener('click', () => switchInterface(target));
  return button;
}
