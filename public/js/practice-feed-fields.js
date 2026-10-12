const calibrationColumns = ["station", "model", "targetAt", "issuedAt", "availableAt", "predicted", "actual", "actualObservedAt"];
export function parseWeatherCalibrationCsv(text) {
  if (typeof text !== "string" || text.length > 70000) throw new Error("Choose a calibration CSV smaller than 70 KB.");
  const records = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else if (!cell || quoted) quoted = !quoted; else throw new Error("The CSV contains an unexpected quotation mark."); }
    else if ((ch === "," || ch === "\n" || ch === undefined) && !quoted) {
      row.push(cell.replace(/\r$/, "").trim()); cell = "";
      if (ch !== ",") { if (row.some(Boolean)) records.push(row); row = []; }
    } else cell += ch ?? "";
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted field.");
  const headers = records.shift()?.map(value => value.replace(/^\uFEFF/, ""));
  if (!headers || headers.length !== calibrationColumns.length || calibrationColumns.some(name => !headers.includes(name))) throw new Error(`Use the template columns: ${calibrationColumns.join(", ")}.`);
  if (records.length < 7 || records.length > 200) throw new Error("Include 7 to 200 dated forecast and measured temperature rows.");
  return records.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const value = Object.fromEntries(headers.map((name, i) => [name, values[i]]));
    for (const name of ["predicted", "actual"]) { if (!value[name] || !Number.isFinite(Number(value[name]))) throw new Error(`CSV row ${index + 2}: ${name} must be a Celsius temperature.`); value[name] = Number(value[name]); }
    for (const name of ["targetAt", "issuedAt", "availableAt", "actualObservedAt"]) if (!Number.isFinite(Date.parse(value[name]))) throw new Error(`CSV row ${index + 2}: ${name} needs an ISO date and time.`);
    return value;
  });
}

export function initializePracticeFeedFields(root, { onFeedback = () => {} } = {}) {
  const doc = root.ownerDocument, host = root.querySelector("[data-practice-feed-fields]");
  if (!host) return { render() {}, read: () => ({}), dispose() {} };
  let current = "", disposed = false, upload = null, uploadError = null;
  const drafts = new Map(), listeners = [];
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const field = (name, label, type = "text", value = "", help = "", attrs = {}) => {
    const wrapper = el("label", label, "field"), input = el("input"); input.name = `practice_feed_${name}`; input.dataset.forwardField = name; input.type = type; input.value = value;
    for (const [key, val] of Object.entries(attrs)) input[key] = val;
    wrapper.append(input); if (help) wrapper.append(el("small", help, "practice-help")); host.append(wrapper); return input;
  };
  const select = (name, label, options, value) => {
    const wrapper = el("label", label, "field"), input = el("select"); input.name = `practice_feed_${name}`; input.dataset.forwardField = name;
    for (const [key, label] of options) { const option = el("option", label); option.value = key; input.append(option); } input.value = value; wrapper.append(input); host.append(wrapper); return input;
  };
  const values = () => Object.fromEntries([...host.querySelectorAll("[data-forward-field]")].filter(input => input.type !== "file").map(input => [input.dataset.forwardField, input.value]));
  function render(strategyId) {
    if (disposed || strategyId === current) return;
    if (current) drafts.set(current, { fields: values(), upload, uploadError });
    current = strategyId; host.replaceChildren(); const draft = drafts.get(current); upload = draft?.upload ?? null; uploadError = draft?.uploadError ?? null;
    host.hidden = !["crypto-directional", "wallet-copy", "weather-forecast", "maker-resting", "solana-momentum"].includes(current);
    if (current === "crypto-directional") {
      host.append(el("h3", "Crypto window"), el("p", "Select the matching live Up/Down market above. These times must match its contract, including the date and timezone.", "practice-help"));
      select("asset", "Underlying asset", [["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["SOL", "Solana"], ["XRP", "XRP"]], "BTC");
      select("windowMinutes", "Contract duration", [["5", "5 minutes"], ["15", "15 minutes"]], "5");
      select("direction", "Outcome to follow", [["Up", "Up"], ["Down", "Down"]], "Up");
      const findWindow = el("button", "Find current crypto window", "btn"); findWindow.type = "button"; findWindow.dataset.practiceAction = "find-window"; host.append(findWindow);
      field("windowOpenedAt", "Window opens (UTC)", "text", "", "Example: 2026-10-12T12:00:00Z. Use the actual 5 or 15 minute contract window.", { required: true, placeholder: "YYYY-MM-DDTHH:mm:ssZ" });
      field("windowEndsAt", "Window ends (UTC)", "text", "", "Must match the selected market's scheduled end.", { required: true, placeholder: "YYYY-MM-DDTHH:mm:ssZ" });
      select("referenceMode", "Probability model reference", [["proxy", "Binance spot estimate · no credentials"], ["recorded", "Recorded Polymarket reference · recorder required"]], "proxy");
      select("autoAdvance", "After this window finishes", [["false", "Keep watching this contract"], ["true", "Continue with the next current window"]], "false");
      host.append(el("p", "Continuing preserves your virtual balance and fixed rules. A new window is selected only when every old position has settled or closed; the same asset, duration and Up/Down direction are preserved.", "practice-help"));
      host.append(el("p", "The Binance estimate differs from the contract's oracle. It cannot evaluate the final 60 seconds. Recorded mode needs a reference recording covering the opening and current window.", "practice-help"));
    }
    if (current === "wallet-copy") {
      field("walletAddress", "Public wallet to follow", "text", "", "This account watches that wallet's new buys of the selected outcome. A fresh history screen, delay and price limits apply.", { required: true, placeholder: "0x…", maxLength: 42, pattern: "0x[0-9a-fA-F]{40}" });
      select("followAllMarkets", "Markets to follow", [["false", "Only the selected outcome"], ["true", "Eligible new buys across this wallet's markets"]], "false");
      host.append(el("p", "Across-market following keeps your risk limits and wallet performance checks. The worker chooses an eligible current buy; the selected market remains its fallback when no new buy qualifies.", "practice-help"));
    }
    if (current === "maker-resting") host.append(el("p", "The worker records your configured bid only after it is below the current ask. A later public sell strictly through that price supplies simulated fill evidence. Queue priority is unknown.", "practice-help"));
    if (current === "weather-forecast") {
      host.append(el("h3", "Settlement station and forecast calibration"), el("p", "Use the exact station in the market rules. All temperatures below and in the calibration file are Celsius. Current forecasts are saved automatically; the change rule waits for a later forecast.", "practice-help"));
      field("station", "Settlement station identifier", "text", "", "Example: KNYC. Confirm the station in the contract.", { required: true, pattern: "[A-Z0-9_-]{3,20}" });
      field("latitude", "Station latitude", "number", "", "", { required: true, min: -90, max: 90, step: "any" });
      field("longitude", "Station longitude", "number", "", "", { required: true, min: -180, max: 180, step: "any" });
      field("date", "Weather date at the station", "date", "", "", { required: true });
      field("timezone", "Station timezone", "text", "America/New_York", "Use an IANA name such as America/New_York or Europe/London.", { required: true });
      select("metric", "Temperature measure", [["high", "Daily high"], ["low", "Daily low"]], "high");
      field("bucketLower", "Bucket lower bound (°C)", "number", "", "Inclusive. Leave blank for no lower bound.", { step: "any" });
      field("bucketUpper", "Bucket upper bound (°C)", "number", "", "Exclusive. Leave blank for no upper bound. Convert Fahrenheit contract boundaries before using them.", { step: "any" });
      select("leadHours", "Calibration forecast lead", [["0", "Same day"], ["24", "At least 24 hours ahead"], ["48", "At least 48 hours ahead"]], "24");
      const file = field("calibration", "Measured forecast calibration (CSV)", "file", "", "7–200 rows. At least 7 prior dates for a matching model: gfs_seamless, ecmwf_ifs025 or icon_seamless. Use measured station temperatures, with actuals recorded after each weather date.", { accept: ".csv,text/csv" });
      const status = el("p", upload ? `${upload.length} calibration rows loaded.` : "No calibration file loaded.", "practice-help"); status.setAttribute("aria-live", "polite"); host.append(status);
      const link = el("a", "Download CSV column template"); link.download = "weather-calibration-template.csv"; link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(calibrationColumns.join(",") + "\n")}`; host.append(link);
      const handler = async () => { const selected = file.files?.[0]; upload = null; uploadError = null; if (!selected) return; const strategy = current;
        try { if (selected.size > 70000) throw new Error("Choose a calibration CSV smaller than 70 KB."); const rows = parseWeatherCalibrationCsv(await selected.text()); if (disposed || strategy !== current) return; upload = rows; status.textContent = `${rows.length} dated calibration rows loaded. The server verifies station, lead and availability before saving.`; }
        catch (error) { if (disposed || strategy !== current) return; uploadError = error.message; status.textContent = error.message; onFeedback(error.message, true); } };
      file.addEventListener("change", handler); listeners.push(() => file.removeEventListener("change", handler));
    }
    if (current === "solana-momentum") host.append(el("p", "Solana token discovery and authority/holder screening are available in Market data. Automated scalp entries need executable swap prices and deployer evidence; the public pool feed does not supply those checks.", "practice-help"));
    for (const input of host.querySelectorAll("[data-forward-field]")) if (input.type !== "file" && draft?.fields[input.dataset.forwardField] !== undefined) input.value = draft.fields[input.dataset.forwardField];
  }
  function read() {
    const v = values();
    if (current === "crypto-directional") { if (!Number.isFinite(Date.parse(v.windowOpenedAt)) || !Number.isFinite(Date.parse(v.windowEndsAt))) throw new Error("Enter both crypto contract times with their timezone."); return { asset: v.asset, referenceMode: v.referenceMode, autoAdvance: v.autoAdvance === "true", windowOpenedAt: new Date(v.windowOpenedAt).toISOString(), windowEndsAt: new Date(v.windowEndsAt).toISOString() }; }
    if (current === "wallet-copy") return { walletAddress: v.walletAddress.trim(), followAllMarkets: v.followAllMarkets === "true" };
    if (current === "weather-forecast") {
      if (!upload) throw new Error(uploadError ?? "Upload the station's dated calibration CSV before creating this weather account.");
      return { weather: { station: v.station.trim().toUpperCase(), settlementStation: v.station.trim().toUpperCase(), latitude: Number(v.latitude), longitude: Number(v.longitude), date: v.date, timezone: v.timezone.trim(), metric: v.metric,
        bucketLower: v.bucketLower.trim() === "" ? null : Number(v.bucketLower), bucketUpper: v.bucketUpper.trim() === "" ? null : Number(v.bucketUpper), leadHours: Number(v.leadHours), calibrationRecords: upload } };
    }
    if (current === "solana-momentum") throw new Error("Use Market data to screen Solana tokens. An executable swap feed and deployer checks are required before automatic scalp accounts can run.");
    return {};
  }
  return { render, read, dispose() { disposed = true; for (const off of listeners) off(); } };
}
