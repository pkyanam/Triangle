/** True on macOS, where the Cmd key is the platform modifier. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Display label for the platform modifier key (⌘ on macOS, Ctrl elsewhere). */
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';

/** Whether the platform modifier is held for a keyboard event. */
export function hasMod(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}
