import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8080);

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

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
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

app.get("/api/demo-data", (_req, res) => {
  res.json({
    restaurant: {
      name: "Pleasure Pizza",
      location: "San Francisco, CA",
      cuisine: "Pizza",
      posStatus: "Connected",
      smsStatus: "Ready",
      customers: 412,
      optedIn: 389,
    },
    customers: demoCustomers,
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

function fallbackResponse(message) {
  const lower = (message || "").toLowerCase();
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

  const prompt = `You are Pielot, an AI revenue copilot for local restaurants. Keep responses under 80 words, practical, and ROI-focused.\nUser: ${message}`;
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
        { role: "system", content: "You are Pielot, a restaurant revenue strategist. Answer in under 70 words. Be specific, operational, and profit-aware." },
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
    const text = result.text || fallbackResponse(message);
    return res.json({ ok: true, mode: "live", text });
  } catch (error) {
    return res.json({ ok: true, mode: "fallback", text: fallbackResponse(req.body?.message || ""), provider_status: 0 });
  }
});

app.listen(port, () => {
  console.log(`Pielot running on port ${port}`);
});
