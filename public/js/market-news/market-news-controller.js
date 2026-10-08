const instances = new WeakMap();

function createEventRow(documentRef, event) {
  const row = documentRef.createElement("article");
  row.className = `calendar-event calendar-event-${event.importance}`;
  row.dataset.calendarEvent = "";
  row.dataset.eventId = event.id;
  row.dataset.timestamp = event.timestamp;
  row.dataset.market = event.market.toLowerCase();
  row.dataset.impact = event.importance;

  const fields = [
    ["time", "", "calendar-event-time", "TIME"],
    ["span", event.importance.toUpperCase(), "calendar-impact", "IMPACT"],
    ["span", event.market, "calendar-market", "MARKET"],
    ["span", event.title, "calendar-event-title", "EVENT"],
  ];
  for (const [tag, text, className, label] of fields) {
    const node = documentRef.createElement(tag);
    node.className = className;
    node.dataset.field = label;

    const fieldLabel = documentRef.createElement("span");
    fieldLabel.className = "calendar-field-label";
    fieldLabel.textContent = `${label} :: `;
    node.append(fieldLabel);

    if (label === "IMPACT") {
      const marker = documentRef.createElement("span");
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = "●";
      node.append(marker, documentRef.createTextNode(" "));
    }

    const value = documentRef.createElement("span");
    value.dataset.eventFieldValue = "";
    value.textContent = text;
    node.append(value);
    if (tag === "time") {
      node.dataset.eventTime = "";
      node.dateTime = event.timestamp;
      value.dataset.eventTimeValue = "";
    }
    row.append(node);
  }
  return row;
}

function formatUpdatedTime(root, timestamp) {
  const updated = root.querySelector("[data-calendar-updated]");
  if (!updated) return;
  const value = timestamp === undefined ? updated.dateTime : timestamp;
  updated.dateTime = value || "";
  const date = new Date(value || "");
  updated.textContent = Number.isNaN(date.getTime()) ? "--" : date.toLocaleString();
}

function groupRows(root, windowRef, { locale, timeZone } = {}) {
  const documentRef = root.ownerDocument;
  const eventsContainer = root.querySelector("[data-calendar-events]");
  if (!eventsContainer) return;
  const rows = [...eventsContainer.querySelectorAll("[data-calendar-event]")];
  const timeFormatter = new windowRef.Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  const dayFormatter = new windowRef.Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "short",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });

  rows.sort((left, right) => {
    const leftTime = Date.parse(left.dataset.timestamp || "");
    const rightTime = Date.parse(right.dataset.timestamp || "");
    return (Number.isNaN(leftTime) ? Infinity : leftTime) - (Number.isNaN(rightTime) ? Infinity : rightTime);
  });
  eventsContainer.replaceChildren();

  const days = new Map();
  for (const row of rows) {
    const timestamp = new Date(row.dataset.timestamp || "");
    const valid = !Number.isNaN(timestamp.getTime());
    const label = valid ? dayFormatter.format(timestamp) : "DATE UNKNOWN";
    const eventTime = row.querySelector("[data-event-time]");
    if (eventTime) {
      const eventTimeValue = eventTime.querySelector("[data-event-time-value]") ?? eventTime;
      eventTimeValue.textContent = valid ? timeFormatter.format(timestamp) : "--:--";
      if (valid) eventTime.dateTime = timestamp.toISOString();
    }
    let day = days.get(label);
    if (!day) {
      day = documentRef.createElement("section");
      day.className = "calendar-day";
      day.dataset.calendarDay = "";
      const heading = documentRef.createElement("h3");
      heading.className = "calendar-day-label";
      heading.id = `calendar-day-${days.size + 1}`;
      heading.textContent = label;
      day.setAttribute("aria-labelledby", heading.id);
      day.append(heading);
      days.set(label, day);
      eventsContainer.append(day);
    }
    day.append(row);
  }

  const timezone = root.querySelector("[data-calendar-timezone]");
  if (timezone) timezone.textContent = "TIMES LOCAL";
}

export function initializeMarketNewsPage(root, {
  fetchImpl = root.ownerDocument.defaultView.fetch.bind(root.ownerDocument.defaultView),
  windowRef = root.ownerDocument.defaultView,
  refreshIntervalMs = 60_000,
  locale,
  timeZone,
} = {}) {
  if (instances.has(root)) return instances.get(root);
  const filters = { impact: "all", market: "all" };
  let disposed = false;
  let refreshing = false;
  let activeRequest = null;

  function setLinkStatus(message) {
    const status = root.querySelector("[data-calendar-link-status]")
      ?? root.querySelector("[data-calendar-status]");
    if (status) status.textContent = message;
  }

  function applyFilters() {
    const rows = [...root.querySelectorAll("[data-calendar-event]")];
    let visibleCount = 0;
    for (const row of rows) {
      const impactMatch = filters.impact === "all" || row.dataset.impact === filters.impact;
      const marketMatch = filters.market === "all" || row.dataset.market === filters.market;
      row.hidden = !(impactMatch && marketMatch);
      if (!row.hidden) visibleCount += 1;
    }
    root.querySelectorAll("[data-calendar-day]").forEach((day) => {
      day.hidden = !day.querySelector("[data-calendar-event]:not([hidden])");
    });
    const count = root.querySelector("[data-calendar-count]");
    if (count) count.textContent = String(visibleCount);
    const hasEvents = rows.length > 0;
    const isOffline = root.dataset.calendarState === "offline" && !hasEvents;
    const empty = root.querySelector("[data-calendar-empty]");
    const filterEmpty = root.querySelector("[data-calendar-filter-empty]");
    const offline = root.querySelector("[data-calendar-offline]");
    if (empty) empty.hidden = hasEvents || isOffline;
    if (filterEmpty) filterEmpty.hidden = !hasEvents || visibleCount > 0;
    if (offline) offline.hidden = !isOffline;
  }

  function selectFilter(group, value) {
    filters[group] = value;
    root.querySelectorAll(`[data-calendar-${group}]`).forEach((button) => {
      const datasetKey = `calendar${group[0].toUpperCase()}${group.slice(1)}`;
      const active = button.dataset[datasetKey] === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    applyFilters();
  }

  function setBusy(busy) {
    root.setAttribute("aria-busy", String(busy));
    const button = root.querySelector("[data-calendar-refresh]");
    if (button) button.disabled = busy;
    if (busy) setLinkStatus("SYNCING CALENDAR...");
  }

  function renderCalendar(calendar) {
    const eventsContainer = root.querySelector("[data-calendar-events]");
    if (!eventsContainer) return;
    eventsContainer.replaceChildren(...calendar.events.map((event) => createEventRow(root.ownerDocument, event)));
    root.dataset.calendarState = calendar.state;
    formatUpdatedTime(root, calendar.updatedAt);
    setLinkStatus(calendar.state === "live" ? "LINK :: LIVE" : "LINK :: STALE DATA");
    groupRows(root, windowRef, { locale, timeZone });
    applyFilters();
  }

  function renderRefreshFailure() {
    const hasEvents = Boolean(root.querySelector("[data-calendar-event]"));
    if (hasEvents) {
      setLinkStatus("DATA LINK DEGRADED :: RETAINING LAST BUFFER");
    } else {
      root.dataset.calendarState = "offline";
      setLinkStatus("LINK :: OFFLINE");
    }
    applyFilters();
  }

  async function refresh({ force = false } = {}) {
    if (disposed || refreshing) return;
    refreshing = true;
    activeRequest = new windowRef.AbortController();
    setBusy(true);
    try {
      const suffix = force ? "?refresh=1" : "";
      const response = await fetchImpl(`/api/market-news/events${suffix}`, {
        headers: { Accept: "application/json" },
        signal: activeRequest.signal,
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error("calendar refresh failed");
      renderCalendar(payload.calendar);
    } catch (error) {
      if (error?.name !== "AbortError") renderRefreshFailure();
    } finally {
      refreshing = false;
      activeRequest = null;
      setBusy(false);
    }
  }

  function onClick(event) {
    const target = event.target.closest?.("[data-calendar-impact], [data-calendar-market], [data-calendar-refresh]");
    if (!target || !root.contains(target)) return;
    if (target.hasAttribute("data-calendar-refresh")) {
      refresh({ force: true });
      return;
    }
    if (target.dataset.calendarImpact) selectFilter("impact", target.dataset.calendarImpact);
    if (target.dataset.calendarMarket) selectFilter("market", target.dataset.calendarMarket);
  }

  groupRows(root, windowRef, { locale, timeZone });
  formatUpdatedTime(root);
  applyFilters();
  root.addEventListener("click", onClick);

  const interval = refreshIntervalMs > 0
    ? windowRef.setInterval(() => refresh(), refreshIntervalMs)
    : null;
  const instance = {
    dispose() {
      disposed = true;
      activeRequest?.abort();
      if (interval !== null) windowRef.clearInterval(interval);
      root.removeEventListener("click", onClick);
      instances.delete(root);
    },
  };
  instances.set(root, instance);
  return instance;
}
