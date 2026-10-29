/**
 * Beakr inside a product with ten customers: the worked example, end to end.
 *
 * The TypeScript companion of "Worked example: ten customers" in the Beakr
 * developer docs (docs/developers/guides/example-multi-tenant.md in
 * beakr-engine) and of multi_tenant_product.py beside this file.
 *
 * One shared "General" project (product documentation every customer may
 * read) and one project per customer. Each customer's users are external
 * users in a label (a group) attached to their customer's project and to
 * General, so a user reads both and nothing else. The backend holds the
 * service-account key; each user session gets a short-lived token.
 *
 * Run with BEAKR_SERVICE_KEY and ANTHROPIC_API_KEY set, from a directory
 * holding docs/general/ and docs/customers/<customer id>/. BEAKR_BASE_URL (or
 * BEAKR_API_URL) points it at another API than production. It has no top-level
 * await, so it runs the same in an ESM ("type": "module") or CommonJS project:
 *
 *   npx tsx examples/multi-tenant-product.ts setup
 *   npx tsx examples/multi-tenant-product.ts ask cust_001 user-8812 "How do I rotate our SSO cert?"
 *   npx tsx examples/multi-tenant-product.ts check
 *   npx tsx examples/multi-tenant-product.ts offboard cust_010
 *
 * Ids Beakr returns are kept in tenants.json here; a product keeps them in its
 * own database.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Beakr, BeakrError, NotFoundError, resultText, sourceWhere, type SourceRecord } from "@beakr/sdk";

/** Your own customer ids. Beakr never needs to understand them. */
const CUSTOMERS = Array.from({ length: 10 }, (_, n) => `cust_${String(n + 1).padStart(3, "0")}`);

/** What each user's token may do: read projects and Knowledge, research, run Beakr's agent. */
const USER_SCOPES = ["projects:read", "kb:read", "agent:run", "conversations:read"];

const STORE = "tenants.json";
const MODEL = "claude-opus-5";

interface Customer {
  projectId: string;
  labelId: string;
}
interface User {
  customerId: string;
  beakrUserId: string;
}
interface Store {
  generalProjectId: string | null;
  customers: Record<string, Customer>;
  users: Record<string, User>;
}

function loadStore(): Store {
  if (existsSync(STORE)) return JSON.parse(readFileSync(STORE, "utf8")) as Store;
  return { generalProjectId: null, customers: {}, users: {} };
}

function saveStore(store: Store): void {
  writeFileSync(STORE, JSON.stringify(store, null, 2));
}

/** The backend's client, with the service-account key. Never sent to a browser. */
function backendClient(): Beakr {
  return new Beakr({ apiKey: process.env.BEAKR_SERVICE_KEY, clientName: "acme-assist-backend" });
}

// -- 1. One-time setup ---------------------------------------------------------

async function setup(backend: Beakr, store: Store): Promise<void> {
  const steps = CUSTOMERS.length + 1;
  if (store.generalProjectId === null) {
    progress(1, steps, "General: creating the shared project");
    const general = await backend.projects.create({
      name: "General",
      description: "Product documentation every customer reads",
    });
    store.generalProjectId = general.id;
    saveStore(store);
    await uploadAndWait(backend, "docs/general", general.id);
  } else {
    progress(1, steps, "General: already set up");
  }
  const generalId = store.generalProjectId;

  for (const [index, customerId] of CUSTOMERS.entries()) {
    if (store.customers[customerId]) {
      progress(index + 2, steps, `${customerId}: already set up`);
      continue;
    }
    progress(index + 2, steps, `${customerId}: creating project and label`);
    const project = await backend.projects.create({
      name: `Customer ${customerId}`,
      tags: [`customer:${customerId}`],
    });
    const label = await backend.labels.create({ name: `customer:${customerId}` });
    // A label gives its members read access to every project attached to it.
    await backend.labels.attachProject(label.id, { project_id: project.id });
    await backend.labels.attachProject(label.id, { project_id: generalId });
    store.customers[customerId] = { projectId: project.id, labelId: label.id };
    saveStore(store);
    await uploadAndWait(backend, join("docs/customers", customerId), project.id);
  }
  console.log(`done: ${Object.keys(store.customers).length} customers set up, ids in ${STORE}`);
}

/** One progress line per setup step, so a long run never looks hung. */
function progress(step: number, total: number, message: string): void {
  console.log(`[${step}/${total}] ${message}`);
}

/**
 * Upload a folder as one batch (subfolders become folders) and wait until its
 * files are indexed: one job for the whole batch.
 */
async function uploadAndWait(backend: Beakr, folder: string, projectId: string): Promise<void> {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    console.log(`      no ${folder}/ here; nothing to upload`);
    return;
  }
  console.log(`      uploading ${folder}/`);
  const batch = await backend.uploads.uploadMany(folder, { projectId });
  console.log("      waiting for indexing (a minute or so)");
  await backend.jobs.wait(batch, { raiseOnFailure: true });
}

// -- 2. A user signs in to your product ----------------------------------------

async function sessionToken(
  backend: Beakr,
  store: Store,
  customerId: string,
  userId: string,
): Promise<string> {
  const customer = store.customers[customerId];
  if (!customer) throw new Error(`unknown customer ${customerId}`);
  const user = await backend.externalUsers.create({
    external_id: userId,
    metadata: { customer_id: customerId },
  });
  // Every time, not only when the user was just created: adding a member is
  // idempotent, and this keeps a recreated group or a lost store consistent.
  await backend.labels.addMember(customer.labelId, { user_id: user.user_id });
  store.users[userId] = { customerId, beakrUserId: user.user_id };
  saveStore(store);
  const minted = await backend.endUserTokens.mint({
    externalUserId: user.user_id,
    scopes: USER_SCOPES,
    ttlSeconds: 1800,
  });
  return minted.token;
}

// -- 3a. Your own agent, with Beakr as tools -----------------------------------

const SYSTEM =
  "You answer questions for one customer of Acme Assist. Use the tools to look " +
  "things up in their knowledge base before answering, and say where an answer " +
  "came from. If the knowledge base does not say, say so.";

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_knowledge",
    description:
      "Search the knowledge base this user can read: their company's pages and the " +
      "shared product documentation. Returns matching passages with page titles.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for." } },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description: "Read one knowledge-base page in full, with its sources, by its title.",
    input_schema: {
      type: "object",
      properties: { page: { type: "string", description: "The page title." } },
      required: ["page"],
    },
  },
  {
    name: "research",
    description:
      "A researched, cited answer to a question across the knowledge base and documents. " +
      "Slower (5 to 45 seconds); use it for questions that need several sources.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];

/** Run one tool as the user (their token), answering its text and whether it failed. */
async function runTool(
  userBeakr: Beakr,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  try {
    if (name === "search_knowledge") {
      const hits = await userBeakr.knowledge.command("grep", {
        query: String(args.query),
        mode: "semantic",
      });
      return { text: resultText(hits), isError: false };
    }
    if (name === "read_page") {
      const page = await userBeakr.knowledge.command("cat", { page: String(args.page) });
      return { text: resultText(page), isError: false };
    }
    if (name === "research") {
      const result = (await userBeakr.knowledge.research(String(args.question))) as {
        text: string;
        citations: SourceRecord[];
      };
      const cited = result.citations.map((source) => `- ${sourceWhere(source)}`);
      return { text: [result.text, ...cited].join("\n"), isError: false };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  } catch (error) {
    // Give the refusal back to the model as text; it can try another way.
    if (error instanceof BeakrError) return { text: error.message, isError: true };
    throw error;
  }
}

async function answerWithOwnAgent(userToken: string, question: string): Promise<string> {
  const userBeakr = new Beakr({ apiKey: userToken });
  const claude = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: question }];
  for (;;) {
    const response = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      // If Claude declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const { text, isError } = await runTool(
        userBeakr,
        block.name,
        block.input as Record<string, unknown>,
      );
      results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
}

// -- 3b. Beakr's own agent ---------------------------------------------------------

/**
 * Ask Beakr's agent as the user. With no projectId the run reads everything
 * the user can: their customer's project and General. The answer cites by
 * readable reference, (memo.pdf › p. 7), and sources says where each cited
 * document lives.
 */
async function answerWithBeakrAgent(userToken: string, question: string): Promise<string> {
  const userBeakr = new Beakr({ apiKey: userToken });
  const { text, sources } = await userBeakr.runs.answer({ question });
  const cited = sources.map((source) => `- ${sourceWhere(source)}`);
  return [text, ...cited].join("\n");
}

// -- 4. Isolation: A cannot see B, both see General ---------------------------------

async function checkIsolation(backend: Beakr, store: Store): Promise<void> {
  const [a, b] = [CUSTOMERS[0]!, CUSTOMERS[1]!];
  const customerA = store.customers[a]!;
  const customerB = store.customers[b]!;
  const userA = new Beakr({ apiKey: await sessionToken(backend, store, a, `demo-user-${a}`) });
  const visible = new Set((await userA.projects.list()).data.map((project) => project.id));
  if (!visible.has(store.generalProjectId ?? "") || !visible.has(customerA.projectId)) {
    throw new Error("customer A's user should see General and A");
  }
  if (visible.has(customerB.projectId)) throw new Error("customer A's user sees customer B");
  try {
    await userA.projects.get(customerB.projectId);
    throw new Error("customer A's user could read customer B's project");
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  console.log("ok: customer A's user sees General and A only");
}

// -- 5. Interview someone to fill a gap ---------------------------------------------

/** Make an interview link; deliver `url` yourself (Beakr sends nothing). */
async function interviewForCustomer(backend: Beakr, recipient: string) {
  return backend.interviews.createLink("How your team approves purchase orders", {
    goal: "Learn the purchase-order approval steps so the assistant can answer them",
    questions: ["Who approves orders above the team limit?", "What happens on rejection?"],
    recipient: { name: recipient },
  });
}

/** Once finished, send the interview into the customer's project. True when sent. */
async function fileInterview(
  backend: Beakr,
  store: Store,
  customerId: string,
  linkId: string,
): Promise<boolean> {
  const result = await backend.interviews.linkResult(linkId);
  if (result.status !== "completed") return false;
  await backend.interviews.sendToProjects(linkId, [store.customers[customerId]!.projectId]);
  return true;
}

// -- 6. Offboarding a customer ------------------------------------------------------

/**
 * Delete the customer's users (their personal data goes with them), the group,
 * and archive the project. Archiving is reversible; projects.delete deletes the
 * project permanently.
 */
async function offboard(backend: Beakr, store: Store, customerId: string): Promise<void> {
  const customer = store.customers[customerId];
  if (!customer) return;
  for (const [userId, user] of Object.entries(store.users)) {
    if (user.customerId !== customerId) continue;
    await backend.externalUsers.delete(user.beakrUserId);
    delete store.users[userId];
  }
  await backend.labels.delete(customer.labelId);
  await backend.projects.update(customer.projectId, { status: "archived" });
  delete store.customers[customerId];
  saveStore(store);
}

async function main(argv: string[]): Promise<void> {
  const store = loadStore();
  const backend = backendClient();
  const [command = "setup", ...rest] = argv;
  if (command === "setup") await setup(backend, store);
  else if (command === "ask") {
    const [customerId, userId, question] = rest as [string, string, string];
    const token = await sessionToken(backend, store, customerId, userId);
    console.log(await answerWithOwnAgent(token, question));
    console.log("---");
    console.log(await answerWithBeakrAgent(token, question));
  } else if (command === "check") await checkIsolation(backend, store);
  else if (command === "offboard") await offboard(backend, store, rest[0]!);
  else throw new Error(`unknown command ${command}`);
}

export { answerWithBeakrAgent, answerWithOwnAgent, fileInterview, interviewForCustomer, sessionToken };

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
