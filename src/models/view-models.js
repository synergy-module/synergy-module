import { NAVIGATION } from "./navigation.js";

export function buildPageViewModel(route, extras = {}) {
  return {
    route,
    navigation: NAVIGATION,
    operator: extras.operator,
    accessNotice: extras.accessNotice ?? null,
    stats: extras.stats ?? null,
    data: extras.data ?? {},
  };
}
