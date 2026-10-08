import { buildPageViewModel } from "../models/view-models.js";

export function renderPage(req, res, page) {
  const headerPrefix = req.fragmentHeaderPrefix ?? "X-Synergy-Module";
  res.set({
    [`${headerPrefix}-Path`]: page.data.path ?? req.originalUrl ?? page.route.path,
    [`${headerPrefix}-Title`]: page.route.title,
    [`${headerPrefix}-Key`]: page.route.key,
  });

  if (req.isSynergyModuleFragment) {
    return res.render(`pages/${page.route.view}`, { page });
  }

  return res.render("layouts/app", { pageView: page, page });
}

export function createPageController() {
  return {
    show(route, extras = {}) {
      return (req, res) => {
        const accessNotice = route.key === "home" && !req.isSynergyModuleFragment
          ? req.session.accessNotice
          : null;
        if (accessNotice) delete req.session.accessNotice;
        return renderPage(req, res, buildPageViewModel(route, {
          operator: req.session.operator,
          accessNotice,
          ...extras,
        }));
      };
    },
  };
}
