import { NAVIGATION, ROUTE_BY_KEY } from "./navigation.js";
import { CAPABILITIES } from "./access.js";

export function buildPageViewModel(route, extras = {}) {
  return {
    route,
    navigation: extras.operator?.capabilities?.includes(CAPABILITIES.ADMIN) ? [...NAVIGATION, ROUTE_BY_KEY.admin] : NAVIGATION,
    operator: extras.operator,
    accessNotice: extras.accessNotice ?? null,
    stats: extras.stats ?? null,
    data: extras.data ?? {},
  };
}
