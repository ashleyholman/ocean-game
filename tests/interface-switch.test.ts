/**
 * Switching between the two interfaces is a navigation, so the only thing
 * worth testing is the query it navigates to — and the property that matters
 * is what it *keeps*: a session pinned to a terrain fixture or a fixed device
 * pixel ratio must survive the trip to the player interface and back.
 */

import { describe, expect, it } from 'vitest';

import { interfaceSearch } from '../src/hud/interfaceSwitch';

describe('the interface switch', () => {
  it('adds and removes only the player parameter', () => {
    expect(interfaceSearch('', 'player')).toBe('?player=1');
    expect(interfaceSearch('?player=1', 'developer')).toBe('');
    expect(interfaceSearch('', 'developer')).toBe('');
  });

  it('keeps a deep link into a developer panel on the way to the player interface', () => {
    // `?debug=ocean` is a bookmark into a particular panel. Switching away and
    // back would otherwise silently demote it.
    expect(interfaceSearch('?debug=ocean', 'player')).toBe('?debug=ocean&player=1');
    expect(interfaceSearch('?debug=ocean&player=1', 'developer')).toBe('?debug=ocean');
  });

  it('carries every other parameter across in both directions', () => {
    expect(
      interfaceSearch('?terrain=synthetic&fixedDpr=1', 'player'),
    ).toBe('?terrain=synthetic&fixedDpr=1&player=1');
    expect(
      interfaceSearch('?player=1&terrain=synthetic&capturePort=5200', 'developer'),
    ).toBe('?terrain=synthetic&capturePort=5200');
  });
});
