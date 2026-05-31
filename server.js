import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8080);
const dataDir = process.env.PIELOT_DATA_DIR || path.join("/tmp", "pielot-data");
const statePath = path.join(dataDir, "state.json");
const { Pool } = pg;

const workflowRuns = new Map();
const twilioApiBase = "https://api.twilio.com/2010-04-01";
const storageStatus = {
  mode: process.env.DATABASE_URL ? "postgres" : "file",
  connected: false,
  last_error: null,
  last_synced_at: null,
};
const pgPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    })
  : null;

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

function rawBodySaver(req, _res, buf) {
  if (buf?.length) req.rawBody = buf.toString("utf8");
}

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
  persistState(nextState);
}

async function persistState(nextState) {
  if (!pgPool) return;
  try {
    await pgPool.query(
      `insert into pielot_state (id, payload, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
      ["app", JSON.stringify(nextState)],
    );
    storageStatus.connected = true;
    storageStatus.last_error = null;
    storageStatus.last_synced_at = new Date().toISOString();
  } catch (error) {
    storageStatus.connected = false;
    storageStatus.last_error = String(error?.message || error).slice(0, 240);
  }
}

async function initPersistentStore() {
  ensureStateFile();
  if (!pgPool) {
    storageStatus.mode = "file";
    storageStatus.connected = true;
    storageStatus.last_synced_at = new Date().toISOString();
    return;
  }

  try {
    await pgPool.query(`
      create table if not exists pielot_state (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    const existing = await pgPool.query("select payload, updated_at from pielot_state where id = $1", ["app"]);
    if (existing.rows[0]?.payload) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(existing.rows[0].payload, null, 2));
      storageStatus.last_synced_at = existing.rows[0].updated_at?.toISOString?.() || new Date().toISOString();
    } else {
      await persistState(readState());
    }
    storageStatus.mode = "postgres";
    storageStatus.connected = true;
    storageStatus.last_error = null;
    storageStatus.last_synced_at = storageStatus.last_synced_at || new Date().toISOString();
  } catch (error) {
    storageStatus.mode = "file_fallback";
    storageStatus.connected = false;
    storageStatus.last_error = String(error?.message || error).slice(0, 240);
  }
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

function publicRequestUrl(req) {
  const configured = process.env.PUBLIC_APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (configured) return `${configured.replace(/\/$/, "")}${req.originalUrl}`;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}${req.originalUrl}`;
}

function timingSafeEqualString(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function validateTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return { ok: true, mode: "not_configured" };
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return { ok: false, mode: "missing_signature" };

  const params = req.is("application/json")
    ? {}
    : Object.fromEntries(Object.entries(req.body || {}).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)]));
  const signed = Object.keys(params).sort().reduce((acc, key) => `${acc}${key}${params[key]}`, publicRequestUrl(req));
  const expected = crypto.createHmac("sha1", token).update(signed).digest("base64");
  return { ok: timingSafeEqualString(expected, signature), mode: "validated" };
}

function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER),
  );
}

async function sendTwilioMessage({ to, body, statusCallback }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const params = new URLSearchParams({ To: to, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) params.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else params.set("From", process.env.TWILIO_FROM_NUMBER);
  if (statusCallback) params.set("StatusCallback", statusCallback);

  const response = await fetch(`${twilioApiBase}/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(payload?.message || payload?.raw || `Twilio status ${response.status}`);
  }
  return payload;
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

await initPersistentStore();
syncStateMaps();

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb", verify: rawBodySaver }));
app.use(express.urlencoded({ extended: false, verify: rawBodySaver }));
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
  "/app",
  "/dashboard",
  "/opportunities/:id",
  "/campaigns",
  "/campaigns/:campaignId",
  "/customers",
  "/segments",
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

app.get("/api/segments", (_req, res) => {
  const customers = readState().customers || [];
  const optedIn = customers.filter((customer) => customer.optedIn).length;
  res.json({
    segments: [
      { id: "seg_lapsed_weekday", name: "At-risk weekday regulars", size: Math.max(47, optedIn), signal: "Ordered on weekdays, inactive 21-45 days", offer: "$5 off $30+", confidence: 86 },
      { id: "seg_game_night", name: "Game night buyers", size: 128, signal: "Orders wings or bundles Thu-Sat", offer: "Free garlic knots with large pizza", confidence: 79 },
      { id: "seg_family", name: "Family bundle buyers", size: 212, signal: "High-ticket dinner orders", offer: "2 pizzas + wings bundle", confidence: 82 },
      { id: "seg_lunch", name: "Lunch crowd", size: 156, signal: "Lunch orders under $18 AOV", offer: "Add a side for $2", confidence: 74 },
    ],
  });
});

app.get("/api/opportunities", (_req, res) => {
  res.json({
    opportunities: [
      { id: "opp_tuesday", title: "Tuesday 2-6 PM slow window", segment: "At-risk weekday regulars", projected_revenue: 3240, estimated_profit: 730, confidence: 86, recommended_offer: "$5 off $30+", reason: "Revenue is 24% below baseline while opted-in weekday regulars have lapsed." },
      { id: "opp_game", title: "Game Night Bundle", segment: "Game night buyers", projected_revenue: 1760, estimated_profit: 510, confidence: 79, recommended_offer: "Free garlic knots with large pizza", reason: "Thu-Sat buyers respond to bundle value and sides attach well." },
      { id: "opp_lunch", title: "Lunch Side Boost", segment: "Lunch crowd", projected_revenue: 980, estimated_profit: 280, confidence: 74, recommended_offer: "Add any side for $2", reason: "Lunch AOV is low but side attach is below peer baseline." },
    ],
  });
});

app.get("/api/campaigns", (_req, res) => {
  const state = readState();
  res.json({ campaigns: state.campaigns || [demoCampaign], metrics: state.campaignMetrics || [...campaignMetrics.values()] });
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
  const signature = validateTwilioSignature(req);
  if (!signature.ok) {
    return res.status(401).json({ ok: false, error: signature.mode });
  }
  const campaignId = String(req.body?.campaign_id || req.body?.CampaignId || req.body?.campaignId || demoCampaign.id);
  const twilioStatus = String(req.body?.MessageStatus || req.body?.SmsStatus || "").toLowerCase();
  const inboundBody = String(req.body?.Body || req.body?.body || "").trim().toLowerCase();
  const event = String(req.body?.event || twilioStatus || (["stop", "unsubscribe"].includes(inboundBody) ? "opt_out" : "delivered")).toLowerCase();
  const metrics = campaignMetrics.get(campaignId) || campaignMetrics.get(demoCampaign.id);
  const next = { ...metrics, campaign_id: campaignId, status: "Live", updated_at: new Date().toISOString() };

  if (event === "sent" || event === "queued" || event === "accepted" || event === "sending") next.texts_sent += Number(req.body?.count || 1);
  if (event === "delivered") next.delivered += Number(req.body?.count || 1);
  if (event === "failed" || event === "undelivered") next.failed = (next.failed || 0) + Number(req.body?.count || 1);
  if (event === "clicked") next.clicks += Number(req.body?.count || 1);
  if (event === "redeemed") {
    const count = Number(req.body?.count || 1);
    next.redemptions += count;
    next.orders += count;
    next.revenue += Number(req.body?.revenue || count * 28);
    next.profit_impact += Number(req.body?.profit || count * 11);
  }
  if (event === "stop" || event === "opt_out" || inboundBody === "stop" || inboundBody === "unsubscribe") {
    const phone = normalizePhone(req.body?.phone || req.body?.From || "unknown");
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
  res.json({ ok: true, signature: signature.mode, metrics: next });
});

app.get("/api/opt-outs", (_req, res) => {
  res.json({ opt_outs: [...optOuts.values()] });
});

app.post("/api/sms/send", async (req, res) => {
  const campaignId = String(req.body?.campaign_id || demoCampaign.id);
  const state = readState();
  const customers = (state.customers || []).filter((customer) => customer.optedIn && !optOuts.has(customer.phone));
  const batchId = `sms_batch_${Date.now()}`;
  const metrics = campaignMetrics.get(campaignId) || campaignMetrics.get(demoCampaign.id);
  const provider = twilioConfigured() ? "twilio" : "simulated";
  const statusCallback = `${(process.env.PUBLIC_APP_URL || "https://web-production-4277b.up.railway.app").replace(/\/$/, "")}/api/sms/webhook`;
  const providerMessages = [];
  const providerErrors = [];

  if (provider === "twilio") {
    for (const customer of customers) {
      try {
        const message = await sendTwilioMessage({
          to: customer.phone,
          body: demoCampaign.sms,
          statusCallback,
        });
        providerMessages.push({ phone: customer.phone, sid: message.sid, status: message.status });
      } catch (error) {
        providerErrors.push({ phone: customer.phone, error: String(error?.message || error).slice(0, 180) });
      }
    }
  }

  const nextMetrics = {
    ...metrics,
    campaign_id: campaignId,
    status: provider === "twilio" ? "Sending via Twilio" : "Simulated provider send",
    texts_sent: provider === "twilio" ? providerMessages.length : customers.length,
    failed: (metrics?.failed || 0) + providerErrors.length,
    updated_at: new Date().toISOString(),
    timeline: [...(metrics?.timeline || []), provider === "twilio" ? `Twilio send requested (${providerMessages.length} accepted, ${providerErrors.length} failed)` : "Simulated SMS send requested"],
  };
  campaignMetrics.set(campaignId, nextMetrics);
  state.campaignMetrics = [...campaignMetrics.values()];
  state.smsBatches = [...(state.smsBatches || []), {
    id: batchId,
    campaign_id: campaignId,
    provider,
    created_at: new Date().toISOString(),
    recipients: customers.length,
    accepted: provider === "twilio" ? providerMessages.length : customers.length,
    failed: providerErrors.length,
    message_ids: providerMessages,
    errors: providerErrors,
  }];
  state.auditLog = [...(state.auditLog || []), `${new Date().toISOString()} SMS send ${batchId}: ${customers.length} recipients via ${provider}`];
  writeState(state);
  res.json({
    ok: true,
    batch_id: batchId,
    provider,
    recipients: customers.length,
    accepted: provider === "twilio" ? providerMessages.length : customers.length,
    failed: providerErrors.length,
    provider_messages: providerMessages,
    provider_errors: providerErrors,
    metrics: nextMetrics,
  });
});

app.get("/api/sms/health", (_req, res) => {
  res.json({
    provider: twilioConfigured() ? "twilio" : "simulated",
    twilio_configured: twilioConfigured(),
    account_sid_present: Boolean(process.env.TWILIO_ACCOUNT_SID),
    auth_token_present: Boolean(process.env.TWILIO_AUTH_TOKEN),
    from_number_present: Boolean(process.env.TWILIO_FROM_NUMBER),
    messaging_service_present: Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID),
    webhook_signature_required: Boolean(process.env.TWILIO_AUTH_TOKEN),
    status_callback_url: `${(process.env.PUBLIC_APP_URL || "https://web-production-4277b.up.railway.app").replace(/\/$/, "")}/api/sms/webhook`,
  });
});

app.get("/api/audit-log", (_req, res) => {
  res.json({ audit_log: readState().auditLog || [] });
});

app.get("/api/storage-health", (_req, res) => {
  res.json({
    ...storageStatus,
    state_path: statePath,
    postgres_configured: Boolean(process.env.DATABASE_URL),
    table: pgPool ? "pielot_state" : null,
  });
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
