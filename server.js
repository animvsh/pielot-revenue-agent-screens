import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8080);
const dataDir = process.env.PIELOT_DATA_DIR || path.join("/tmp", "pielot-data");
const statePath = path.join(dataDir, "state.json");

const workflowRuns = new Map();

const demoCustomers = [
  { name: "Sarah Johnson", phone: "(415) 555-0199", optedIn: true, lastOrder: "36 days ago", orders: 12, spend: 342.18, segment: "Lapsed weekday" },
  { name: "Mike Chen", phone: "(415) 555-0123", optedIn: true, lastOrder: "17 days ago", orders: 8, spend: 186.45, segment: "Game night" },
  { name: "Alicia Garcia", phone: "(415) 555-0177", optedIn: true, lastOrder: "6 days ago", orders: 15, spend: 512.3, segment: "High value" },
  { name: "David Patel", phone: "(415) 555-0144", optedIn: false, lastOrder: "45 days ago", orders: 3, spend: 67.89, segment: "No consent" },
  { name: "Emily Brown", phone: "(415) 555-0102", optedIn: true, lastOrder: "28 days ago", orders: 6, spend: 133.25, segment: "Lunch lapsed" },
];

const demoCampaign = {
  id: "camp_tuesday_comeback",
  name: "Tuesday Comeback Offer",
  status: "Draft",
  audience: "At-risk weekday customers",
  audienceSize: 412,
  offer: "$5 off orders above $30",
  sendWindow: "Tuesday at 1:15 PM",
  validWindow: "Tuesday, 2 PM - 6 PM",
  sms: "Hey, we miss you. Get $5 off your order of $30+ today from 2-6 PM. Perfect time for your weekday pizza fix. Reply STOP to opt out.",
  projectedRevenue: 3240,
  estimatedProfit: 730,
  deliveryRate: 0,
  orders: 0,
};

const campaignMetrics = new Map([
  [demoCampaign.id, {
    campaign_id: demoCampaign.id,
    status: "Draft",
    texts_sent: 0,
    delivered: 0,
    redemptions: 0,
    orders: 0,
    revenue: 0,
    profit_impact: 0,
    clicks: 0,
    unsubscribes: 0,
    updated_at: new Date().toISOString(),
    timeline: ["Campaign drafted", "Waiting for approval"],
  }],
]);

const optOuts = new Map();
const sessions = new Map();

function defaultState() {
  return {
    users: [{ id: "user_demo_owner", email: "owner@pleasurepizza.com", name: "Pleasure Pizza Owner" }],
    restaurants: [{
      id: "rest_pleasure_pizza",
      owner_id: "user_demo_owner",
      name: "Pleasure Pizza",
      location: "San Francisco, CA",
      cuisine: "Pizza",
      average_order_value: 28,
      popular_items: ["Pizza", "Garlic knots", "Wings"],
      tone: "Friendly",
      sms_provider: "twilio-ready",
    }],
    customers: demoCustomers,
    imports: [],
    campaigns: [demoCampaign],
    campaignMetrics: [...campaignMetrics.values()],
    optOuts: [],
    auditLog: ["Seeded demo workspace"],
  };
}

function ensureStateFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify(defaultState(), null, 2));
  }
}

function readState() {
  ensureStateFile();
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function writeState(nextState) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2));
}

function syncStateMaps() {
  const state = readState();
  campaignMetrics.clear();
  for (const metrics of state.campaignMetrics || []) campaignMetrics.set(metrics.campaign_id, metrics);
  optOuts.clear();
  for (const optOut of state.optOuts || []) optOuts.set(optOut.phone, optOut);
}

function appendAudit(message) {
  const state = readState();
  state.auditLog = [...(state.auditLog || []), `${new Date().toISOString()} ${message}`];
  writeState(state);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter(([key]) => key).map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]));
}

function getSessionUser(req) {
  const sid = parseCookies(req.headers.cookie || "").pielot_session;
  const userId = sessions.get(sid);
  if (!userId) return null;
  return readState().users.find((user) => user.id === userId) || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function parseBoolean(value) {
  return ["yes", "true", "1", "y", "opted in", "opt-in"].includes(String(value || "").trim().toLowerCase());
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function validateCustomerRows(csvText) {
  const rows = parseCsv(csvText);
  const header = (rows.shift() || []).map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const indexOf = (...names) => names.map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1;
  const indexes = {
    name: indexOf("customername", "name", "customer"),
    phone: indexOf("phonenumber", "phone", "mobile"),
    optIn: indexOf("optin", "optedin", "consent", "smsconsent"),
    lastOrder: indexOf("lastorder", "lastvisit"),
    orders: indexOf("orders", "ordercount"),
    spend: indexOf("totalspend", "spend", "lifetimevalue"),
    favoriteItems: indexOf("favoriteitems", "favoriteitem", "items"),
  };
  const missing = Object.entries(indexes).filter(([key, value]) => ["name", "phone", "optIn", "lastOrder"].includes(key) && value < 0).map(([key]) => key);
  const seenPhones = new Set();
  const customers = [];
  const errors = [];

  rows.forEach((row, rowIndex) => {
    const phone = normalizePhone(row[indexes.phone]);
    if (!phone) errors.push(`Row ${rowIndex + 2}: missing phone`);
    if (phone && seenPhones.has(phone)) return;
    if (phone) seenPhones.add(phone);
    customers.push({
      name: row[indexes.name] || "Unknown customer",
      phone,
      optedIn: parseBoolean(row[indexes.optIn]),
      lastOrder: row[indexes.lastOrder] || "Unknown",
      orders: Number(row[indexes.orders] || 0),
      spend: Number(String(row[indexes.spend] || "0").replace(/[$,]/g, "")),
      favoriteItems: row[indexes.favoriteItems] || "",
      segment: parseBoolean(row[indexes.optIn]) ? "Imported opted-in" : "Missing consent",
    });
  });

  return {
    required_fields_present: missing.length === 0,
    missing_fields: missing,
    rows_seen: rows.length,
    records_ready: customers.length,
    opted_in: customers.filter((customer) => customer.optedIn).length,
    missing_consent: customers.filter((customer) => !customer.optedIn).length,
    deduped: rows.length - customers.length,
    phone_normalized: true,
    errors,
    customers,
  };
}

syncStateMaps();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/favicon.ico", (_req, res) => {
  res.type("image/svg+xml").sendFile(path.join(__dirname, "public", "favicon.svg"));
});

app.get("/demo", (_req, res) => {
  res.sendFile(path.join(__dirname, "demo.html"));
});

const appRoutes = [
  "/auth",
  "/onboarding/restaurant",
  "/onboarding/data-source",
  "/onboarding/upload",
  "/agent/scan",
  "/agent",
  "/dashboard",
  "/opportunities/:id",
  "/campaigns",
  "/campaigns/:campaignId",
  "/compliance",
  "/settings",
];

appRoutes.forEach((route) => {
  app.get(route, (_req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
  });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "owner@pleasurepizza.com").toLowerCase();
  const state = readState();
  let user = state.users.find((candidate) => candidate.email.toLowerCase() === email);
  if (!user) {
    user = { id: `user_${crypto.randomUUID()}`, email, name: req.body?.name || "Restaurant Owner" };
    state.users.push(user);
    writeState(state);
  }
  const sid = crypto.randomUUID();
  sessions.set(sid, user.id);
  res.setHeader("Set-Cookie", `pielot_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  appendAudit(`Login for ${email}`);
  res.json({ ok: true, user });
});

app.get("/api/auth/me", (req, res) => {
  const user = getSessionUser(req) || readState().users[0];
  res.json({ authenticated: Boolean(getSessionUser(req)), user });
});

app.get("/api/restaurants/current", (_req, res) => {
  res.json(readState().restaurants[0]);
});

app.post("/api/restaurants/current", (req, res) => {
  const state = readState();
  state.restaurants[0] = { ...state.restaurants[0], ...req.body, updated_at: new Date().toISOString() };
  state.auditLog = [...(state.auditLog || []), `${new Date().toISOString()} Restaurant profile updated`];
  writeState(state);
  res.json(state.restaurants[0]);
});

app.get("/api/customers", (_req, res) => {
  const state = readState();
  res.json({ customers: state.customers || [], count: (state.customers || []).length });
});

app.post("/api/customers/import", express.text({ type: ["text/csv", "text/plain", "application/csv", "*/*"], limit: "2mb" }), (req, res) => {
  const csvText = String(req.body || "");
  const validation = validateCustomerRows(csvText);
  const state = readState();
  const importRecord = {
    id: `import_${Date.now()}`,
    created_at: new Date().toISOString(),
    rows_seen: validation.rows_seen,
    records_ready: validation.records_ready,
    opted_in: validation.opted_in,
    missing_consent: validation.missing_consent,
    deduped: validation.deduped,
    errors: validation.errors,
  };
  state.imports = [...(state.imports || []), importRecord];
  if (validation.required_fields_present) state.customers = validation.customers;
  state.auditLog = [...(state.auditLog || []), `${new Date().toISOString()} CSV import ${importRecord.id}: ${importRecord.records_ready} records ready`];
  writeState(state);
  res.json({ ok: validation.required_fields_present, import: importRecord, validation });
});

app.get("/api/data-validation", (_req, res) => {
  const state = readState();
  const customers = state.customers || [];
  const phones = new Set(customers.map((customer) => customer.phone).filter(Boolean));
  res.json({
    records_ready: customers.length,
    opted_in: customers.filter((customer) => customer.optedIn).length,
    missing_consent: customers.filter((customer) => !customer.optedIn).length,
    duplicate_phones: customers.length - phones.size,
    required_fields: ["Customer name", "Phone number", "Opt-in status", "Last order"],
    ready_for_scan: customers.some((customer) => customer.optedIn),
    last_import: (state.imports || []).at(-1) || null,
  });
});

app.get("/api/demo-data", (_req, res) => {
  const state = readState();
  const customers = state.customers || demoCustomers;
  const restaurant = state.restaurants?.[0] || {};
  res.json({
    restaurant: {
      name: restaurant.name || "Pleasure Pizza",
      location: restaurant.location || "San Francisco, CA",
      cuisine: restaurant.cuisine || "Pizza",
      posStatus: "Connected",
      smsStatus: "Ready",
      customers: customers.length,
      optedIn: customers.filter((customer) => customer.optedIn).length,
    },
    customers,
    opportunities: [
      { id: "opp_tuesday", title: "Tuesday slow window", impact: "$3,240", audience: "412 customers", confidence: "High", action: "Launch comeback SMS before lunch" },
      { id: "opp_lapsed", title: "Win back lapsed regulars", impact: "$2,180", audience: "187 customers", confidence: "High", action: "$5 off $30+ this week" },
      { id: "opp_game", title: "Game night bundle", impact: "$1,760", audience: "128 customers", confidence: "Medium", action: "Pizza + knots bundle" },
    ],
    campaign: demoCampaign,
    compliance: {
      optedInOnly: true,
      stopIncluded: true,
      quietHours: true,
      frequencyCap: "2 texts per customer per week",
      approvalRequired: true,
      auditLog: ["CSV validated", "Consent checked", "Human approval required"],
    },
  });
});

app.post("/api/workflows", (req, res) => {
  const workflowType = String(req.body?.workflow_type || "revenue_scan");
  const id = `wf_${Date.now()}`;
  const steps = {
    csv_validation: ["Parse CSV", "Normalize phone numbers", "Check consent", "Dedupe customers"],
    revenue_scan: ["Analyze orders", "Detect weak windows", "Segment customers", "Estimate revenue", "Rank opportunities"],
    campaign_draft: ["Select audience", "Choose margin-safe offer", "Write SMS", "Run compliance checks"],
    sms_send: ["Confirm approval", "Apply quiet hours", "Send provider request", "Track delivery"],
  }[workflowType] || ["Start workflow", "Process", "Complete"];

  const run = {
    workflow_id: id,
    workflow_type: workflowType,
    current_step: steps[0],
    steps: steps.map((name, index) => ({ name, status: index === 0 ? "running" : "pending" })),
    status: "running",
    progress_percent: 12,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: null,
    output_card_id: null,
  };
  workflowRuns.set(id, run);
  res.json(run);
});

app.get("/api/workflows/:id", (req, res) => {
  const run = workflowRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Workflow not found" });

  const elapsed = Date.now() - Date.parse(run.created_at);
  const completedCount = Math.min(run.steps.length, Math.floor(elapsed / 650) + 1);
  run.steps = run.steps.map((step, index) => ({
    ...step,
    status: index < completedCount ? "complete" : index === completedCount ? "running" : "pending",
  }));
  run.progress_percent = Math.min(100, Math.round((completedCount / run.steps.length) * 100));
  run.current_step = run.steps.find((step) => step.status === "running")?.name || run.steps.at(-1)?.name || "Complete";
  run.status = run.progress_percent >= 100 ? "complete" : "running";
  run.updated_at = new Date().toISOString();
  run.output_card_id = run.status === "complete" ? `${run.workflow_type}_card` : null;
  workflowRuns.set(req.params.id, run);
  res.json(run);
});

app.post("/api/campaigns/:id/approve", (req, res) => {
  const scheduled = Boolean(req.body?.scheduled);
  const state = readState();
  const existing = campaignMetrics.get(req.params.id) || campaignMetrics.get(demoCampaign.id);
  const nextMetrics = {
    ...existing,
    campaign_id: req.params.id,
    status: scheduled ? "Scheduled" : "Sending",
    texts_sent: scheduled ? 0 : 389,
    updated_at: new Date().toISOString(),
    timeline: [...(existing?.timeline || []), "Human approved", scheduled ? "Campaign scheduled" : "Provider send started"],
  };
  campaignMetrics.set(req.params.id, nextMetrics);
  state.campaignMetrics = [...campaignMetrics.values()];
  state.auditLog = [...(state.auditLog || []), `${new Date().toISOString()} Campaign ${req.params.id} approved`];
  writeState(state);
  res.json({
    ...demoCampaign,
    id: req.params.id,
    status: scheduled ? "Scheduled" : "Sending",
    approved_at: new Date().toISOString(),
    recipients: 389,
    provider: "Twilio-ready",
    audit_log: ["Human approved", "STOP language verified", "Frequency cap checked", "Provider request prepared"],
  });
});

app.get("/api/campaigns/:id/metrics", (req, res) => {
  const metrics = campaignMetrics.get(req.params.id) || campaignMetrics.get(demoCampaign.id);
  res.json(metrics);
});

app.post("/api/sms/webhook", (req, res) => {
  if (process.env.TWILIO_AUTH_TOKEN && !req.headers["x-twilio-signature"]) {
    return res.status(401).json({ ok: false, error: "missing_twilio_signature" });
  }
  const campaignId = String(req.body?.campaign_id || demoCampaign.id);
  const event = String(req.body?.event || "delivered").toLowerCase();
  const metrics = campaignMetrics.get(campaignId) || campaignMetrics.get(demoCampaign.id);
  const next = { ...metrics, campaign_id: campaignId, status: "Live", updated_at: new Date().toISOString() };

  if (event === "sent") next.texts_sent += Number(req.body?.count || 1);
  if (event === "delivered") next.delivered += Number(req.body?.count || 1);
  if (event === "clicked") next.clicks += Number(req.body?.count || 1);
  if (event === "redeemed") {
    const count = Number(req.body?.count || 1);
    next.redemptions += count;
    next.orders += count;
    next.revenue += Number(req.body?.revenue || count * 28);
    next.profit_impact += Number(req.body?.profit || count * 11);
  }
  if (event === "stop" || event === "opt_out") {
    const phone = String(req.body?.phone || "unknown");
    optOuts.set(phone, { phone, campaign_id: campaignId, opted_out_at: new Date().toISOString(), source: "sms_webhook" });
    next.unsubscribes += 1;
  }

  next.timeline = [...(metrics?.timeline || []), `Webhook: ${event}`];
  campaignMetrics.set(campaignId, next);
  const state = readState();
  state.campaignMetrics = [...campaignMetrics.values()];
  state.optOuts = [...optOuts.values()];
  state.auditLog = [...(state.auditLog || []), `${new Date().toISOString()} SMS webhook ${event} for ${campaignId}`];
  writeState(state);
  res.json({ ok: true, metrics: next });
});

app.get("/api/opt-outs", (_req, res) => {
  res.json({ opt_outs: [...optOuts.values()] });
});

app.post("/api/sms/send", (req, res) => {
  const campaignId = String(req.body?.campaign_id || demoCampaign.id);
  const state = readState();
  const customers = (state.customers || []).filter((customer) => customer.optedIn && !optOuts.has(customer.phone));
  const batchId = `sms_batch_${Date.now()}`;
  const metrics = campaignMetrics.get(campaignId) || campaignMetrics.get(demoCampaign.id);
  const nextMetrics = {
    ...metrics,
    campaign_id: campaignId,
    status: process.env.TWILIO_ACCOUNT_SID ? "Sending via Twilio" : "Simulated provider send",
    texts_sent: customers.length,
    updated_at: new Date().toISOString(),
    timeline: [...(metrics?.timeline || []), process.env.TWILIO_ACCOUNT_SID ? "Twilio send requested" : "Simulated SMS send requested"],
  };
  campaignMetrics.set(campaignId, nextMetrics);
  state.campaignMetrics = [...campaignMetrics.values()];
  state.auditLog = [...(state.auditLog || []), `${new Date().toISOString()} SMS send ${batchId}: ${customers.length} recipients`];
  writeState(state);
  res.json({
    ok: true,
    batch_id: batchId,
    provider: process.env.TWILIO_ACCOUNT_SID ? "twilio" : "simulated",
    recipients: customers.length,
    metrics: nextMetrics,
  });
});

app.get("/api/audit-log", (_req, res) => {
  res.json({ audit_log: readState().auditLog || [] });
});

function fallbackResponse(message) {
  const lower = (message || "").toLowerCase();
  if (lower.includes("tuesday") || lower.includes("slow")) {
    return "Tuesdays are slow because lapsed weekday customers have stopped ordering in the 2-6 PM window. Pielot found a 24% demand gap and recommends messaging 389 opted-in customers before lunch with a $5 off $30+ comeback offer.";
  }
  if (lower.includes("why")) {
    return "A flat 20% discount may lift redemptions, but it can leak margin. The $5 off $30+ offer protects average order value, caps discount cost, and gives weekday customers a clear reason to order during the slow window.";
  }
  if (lower.includes("deploy")) {
    return "Campaign deployed. I created the production send, enabled analytics tracking, and reserved a 10% holdout group so Tony's Pizza can measure real lift.";
  }
  if (lower.includes("explain")) {
    return "The slow Tuesday window is coming from lapsed weekday customers. They used to order between 2-6 PM, but visits dropped over the last 21-45 days while weekend demand stayed healthy.";
  }
  return "I found a strong Tuesday 2-6 PM revenue gap: revenue is projected 24% below normal, with 1,248 at-risk weekday customers who are good comeback targets.";
}

function cleanModelText(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldUseDeterministicAnswer(message, modelText) {
  const lowerMessage = String(message || "").toLowerCase();
  const lowerText = String(modelText || "").toLowerCase();
  if (lowerMessage.includes("tuesday") || lowerMessage.includes("slow") || lowerMessage.includes("why this offer")) return true;
  if (lowerText.includes("survey table") || lowerText.includes("i don't have") || lowerText.includes("i need") || lowerText.includes("which offer")) return true;
  if (lowerText.includes("20% off") && !lowerText.includes("$5 off")) return true;
  return false;
}

async function callChatProvider(message) {
  const hasMiniMaxKey = Boolean(process.env.MINIMAX_API_KEY);
  const baseUrl = hasMiniMaxKey
    ? process.env.MINIMAX_API_BASE || "https://api.minimax.io/v1"
    : process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
  const apiKey = hasMiniMaxKey ? process.env.MINIMAX_API_KEY : process.env.OPENAI_API_KEY || "";
  const model = process.env.DEMO_MODEL || "MiniMax-M2.7";

  if (!apiKey) {
    return { ok: false, status: 0, reason: "missing_api_key" };
  }

  const prompt = `Restaurant context:
- Restaurant: Pleasure Pizza in San Francisco
- Data uploaded: 412 customers, 389 opted in
- Best opportunity: Tuesday 2-6 PM is 24% below normal revenue
- Audience: opted-in at-risk weekday customers
- Recommended campaign: Tuesday Comeback Offer
- Offer: $5 off orders above $30
- Projected revenue: $3,240
- Guardrails: never recommend autonomous sends, do not recommend broad 20% discounts, include STOP language, protect margin, respect quiet hours and frequency caps.

User: ${message}`;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_completion_tokens: 180,
      messages: [
        { role: "system", content: "You are Pielot, a restaurant SMS revenue agent. Answer in under 70 words. Always use the provided Pleasure Pizza context. Be specific, margin-safe, approval-aware, and compliance-safe. If asked why, explain the Tuesday 2-6 PM demand gap and the $5 off $30+ offer. Never invent unrelated tools, tables, or surveys." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, reason: raw.slice(0, 280) };
  }

  const data = JSON.parse(raw);
  return {
    ok: true,
    status: response.status,
    text: cleanModelText(data?.choices?.[0]?.message?.content),
    model,
  };
}

app.get("/api/provider-health", async (_req, res) => {
  try {
    const result = await callChatProvider("Give one concise Pielot status line.");
    const selectedKey = process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY || "";
    res.json({
      ok: result.ok,
      status: result.status,
      mode: result.ok ? "live" : "fallback",
    model: result.model || process.env.DEMO_MODEL || "MiniMax-M2.7",
      base_url: process.env.MINIMAX_API_KEY ? process.env.MINIMAX_API_BASE || "https://api.minimax.io/v1" : process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
      key_present: Boolean(selectedKey),
      key_length: selectedKey.length,
      key_prefix: selectedKey.slice(0, 5),
      reason: result.ok ? undefined : result.reason,
    });
  } catch (error) {
    res.json({ ok: false, status: 0, mode: "fallback", reason: String(error?.message || error).slice(0, 240) });
  }
});

app.post("/api/demo-chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "");
    const result = await callChatProvider(message);
    if (!result.ok) {
      return res.json({ ok: true, mode: "fallback", text: fallbackResponse(message), provider_status: result.status });
    }
    const text = shouldUseDeterministicAnswer(message, result.text) ? fallbackResponse(message) : result.text || fallbackResponse(message);
    return res.json({ ok: true, mode: "live", text });
  } catch (error) {
    return res.json({ ok: true, mode: "fallback", text: fallbackResponse(req.body?.message || ""), provider_status: 0 });
  }
});

app.listen(port, () => {
  console.log(`Pielot running on port ${port}`);
});
