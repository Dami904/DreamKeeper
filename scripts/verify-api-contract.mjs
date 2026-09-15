// Live API-contract snapshot check.
//
// DreamKeeper's whole methodology has been "verify against the real KeeperHub
// API, never trust an assumed schema" — this script turns that one-time manual
// discipline into a repeatable, automated check. It asserts the exact field
// names LiveKeeperHubTransport depends on (packages/core/src/keeperhub/
// live-transport.ts) still exist on real KeeperHub responses. If KeeperHub
// ever renames one of these fields, this script fails loudly here instead of
// the change silently breaking a live run.
//
// Requires a real KEEPERHUB_API_KEY — not part of the zero-secret `pnpm test`
// suite. Run with: pnpm live:verify-contract
//
// Every call below is either `simulate: true` (no broadcast), a pure read, or
// a sign-and-hold immediately followed by a cancel (nothing ever reaches the
// chain) — this script spends no gas and moves no value.

import { randomUUID } from "node:crypto";

const endpoint = process.env.KEEPERHUB_MCP_URL || "https://app.keeperhub.com/mcp";
const apiKey = process.env.KEEPERHUB_API_KEY;
if (!apiKey) {
  console.error("KEEPERHUB_API_KEY not set — run with: pnpm live:verify-contract");
  process.exit(1);
}

const wallet = "0x9219AB851CD5Fea9Bf65B9ABF0De929315185D76";
const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const tempoToken = "0x20c0000000000000000000000000000000000000";

let sessionId;
let failures = 0;

function headers() {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

async function rawPost(body) {
  const res = await fetch(endpoint, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, headers: res.headers, data: json };
}

async function initSession() {
  const res = await rawPost({
    jsonrpc: "2.0",
    id: `init_${randomUUID()}`,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dreamkeeper-contract-check", version: "0.1.0" } },
  });
  if (res.status === 401 || res.status === 403) {
    console.error("KeeperHub rejected the API key at initialize.");
    process.exit(1);
  }
  sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    console.error("No Mcp-Session-Id header returned.");
    process.exit(1);
  }
  await rawPost({ jsonrpc: "2.0", method: "notifications/initialized" });
}

function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; } } }
  }
  return undefined;
}

async function callTool(name, args) {
  const res = await rawPost({ jsonrpc: "2.0", id: `call_${randomUUID()}`, method: "tools/call", params: { name, arguments: args } });
  const text = res.data?.result?.content?.[0]?.text;
  const parsed = typeof text === "string" ? extractJson(text) : undefined;
  return { status: res.status, text, parsed };
}

function assertFields(label, obj, fields) {
  const missing = fields.filter((f) => obj == null || !(f in obj));
  if (missing.length > 0) {
    console.error(`FAIL  ${label}: missing field(s) [${missing.join(", ")}] — got keys [${obj ? Object.keys(obj).join(", ") : "none"}]`);
    failures++;
  } else {
    console.log(`OK    ${label}: [${fields.join(", ")}] all present`);
  }
}

async function main() {
  await initSession();
  console.log("Session established.\n");

  // 1. execute_transfer — simulate response shape
  const transfer = await callTool("execute_transfer", {
    chain_id: "84532",
    to_address: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
    amount: "0.000001",
    simulate: true,
  });
  assertFields("execute_transfer (simulate)", transfer.parsed, ["success", "status", "gasEstimate", "wouldRevert"]);

  // 2. execute_contract_call — simulate response shape
  const contractCall = await callTool("execute_contract_call", {
    contract_address: usdc,
    chain_id: "84532",
    function_name: "approve",
    function_args: JSON.stringify([wallet, "1"]),
    simulate: true,
  });
  assertFields("execute_contract_call (simulate)", contractCall.parsed, ["success", "status", "gasEstimate", "wouldRevert"]);

  // 3. execute_check_and_execute — condition-not-met response shape
  const cae = await callTool("execute_check_and_execute", {
    contract_address: usdc,
    chain_id: "84532",
    function_name: "totalSupply",
    condition: { operator: "gt", value: "999999999999999999999999999" },
    action: { contract_address: wallet, function_name: "noop" },
    simulate: true,
  }).catch(() => ({ parsed: undefined }));
  assertFields("execute_check_and_execute (condition not met)", cae.parsed, ["success", "executed", "conditionResult"]);

  // 4. get_spending_limits — read shape
  const limits = await callTool("get_spending_limits", {});
  assertFields("get_spending_limits", limits.parsed, ["effectiveDailyCapWei", "effectiveDailySolanaCapLamports", "usingDefaultDailyCap", "usingDefaultDailySolanaCap"]);

  // 5. tempo_sign_and_hold + tempo_cancel_hold — hold shape, then clean up
  const hold = await callTool("tempo_sign_and_hold", {
    network: "tempo-testnet",
    tokenConfig: JSON.stringify({ mode: "custom", customToken: { address: tempoToken, symbol: "pathUSD" } }),
    amount: "1",
    recipientAddress: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
    memo: "contract-check",
  });
  assertFields("tempo_sign_and_hold", hold.parsed, ["success", "paymentId", "status", "chainId"]);
  if (hold.parsed?.paymentId) {
    const cancel = await callTool("tempo_cancel_hold", { paymentId: hold.parsed.paymentId });
    assertFields("tempo_cancel_hold", cancel.parsed, ["ok", "status"]);
  } else {
    console.error("SKIP  tempo_cancel_hold: no paymentId from previous step, nothing to clean up");
  }

  // 6. execute_protocol_action — synchronous read shape
  const protocolRead = await callTool("execute_protocol_action", {
    actionType: "chronicle/eth-usd-read",
    idempotency_key: `contract_check_${Date.now()}`,
    params: { network: "1" },
  });
  assertFields("execute_protocol_action (read)", protocolRead.parsed, ["success", "result", "addressLink"]);

  console.log(`\n${failures === 0 ? "ALL CONTRACT CHECKS PASSED" : `${failures} CONTRACT CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Contract check failed with an uncaught error:", err);
  process.exit(1);
});
