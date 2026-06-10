// Tab-visibility computation for the db-page context strip. Pure and
// extracted from the nested layout so the subtle rule is testable: the
// CURRENT db is always visible, even when it sorts past the cutoff —
// a strip that hides the page you're on reads as broken navigation.

export const MAX_VISIBLE_DB_TABS = 4;

export interface DbTabs {
  visible: string[];
  overflow: string[];
}

export function computeDbTabs(
  names: readonly string[],
  current: string,
  max: number = MAX_VISIBLE_DB_TABS,
): DbTabs {
  let visible = names.slice(0, max);
  if (names.includes(current) && !visible.includes(current)) {
    visible = [...visible.slice(0, max - 1), current];
  }
  return {
    visible,
    overflow: names.filter((n) => !visible.includes(n)),
  };
}
