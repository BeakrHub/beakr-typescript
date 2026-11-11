/**
 * Project isolation: one server-side session per client, its helpers and
 * refusals. Every client sends an `X-Beakr-Session` id; the server keys a
 * person's session on it, so auto-lock, the cross-project guard and the read
 * trail apply to an SDK script as to an agent. `sessions.start` opens a fresh
 * one for a block of work. The Python SDK's tests/test_project_isolation.py
 * pins the same behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  Beakr,
  ConflictError,
  CrossProjectOwnerRequiredError,
  CrossProjectWriteRefusedError,
  PermissionDeniedError,
  SessionEndedError,
  SessionLockedToProjectError,
  SessionReadOnlyError,
  SessionRequiredError,
  crossProjectHold,
} from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const PHARMA_A = { id: "pa", name: "Pharma A" };
const PHARMA_B = { id: "pb", name: "Pharma B" };

function session(extra: Record<string, unknown> = {}) {
  return {
    id: "s1",
    status: "active",
    mode: "auto_lock",
    agent_session_id: "conv-1",
    lock_state: "open",
    write_project: null,
    touched_projects: [],
    read_projects: [],
    write_projects: [],
    ...extra,
  };
}

/** As the engine sends it: the extras beside code in `detail` and in `error.details`. */
function refusal(status: number, code: string, message: string, extras: Record<string, unknown> = {}) {
  return json(
    {
      detail: { code, message, fix: "Start a new session.", ...extras },
      error: { code, message, fix: "Start a new session.", details: extras },
    },
    status,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the X-Beakr-Session id", () => {
  it("is made once per client and sent on every request", async () => {
    vi.stubEnv("BEAKR_SESSION", "");
    const { fetch, calls } = mockFetch([json({}), json({}), json({})]);
    const { beakr } = client(fetch);
    await beakr.me.get();
    await beakr.me.get();
    const first = calls[0]!.headers["x-beakr-session"];
    expect(first).toMatch(/^sdk-typescript-[0-9a-f]{32}$/);
    expect(calls[1]!.headers["x-beakr-session"]).toBe(first);
    const { beakr: other } = client(fetch);
    await other.me.get();
    expect(calls[2]!.headers["x-beakr-session"]).not.toBe(first);
  });

  it("is the caller's `session`, else BEAKR_SESSION; an empty one sends none", async () => {
    vi.stubEnv("BEAKR_SESSION", "env-session");
    const { fetch, calls } = mockFetch([json({}), json({}), json({})]);
    await client(fetch).beakr.me.get();
    await client(fetch, { session: "cc-123" }).beakr.me.get();
    await client(fetch, { session: "" }).beakr.me.get();
    expect(calls.map((c) => c.headers["x-beakr-session"])).toEqual(["env-session", "cc-123", undefined]);
  });

  it("is kept by a session's scoped client", async () => {
    const { fetch, calls } = mockFetch([
      json({ ...session(), token: { token: "bk_st_1", expires_at: new Date(Date.now() + 3_600_000).toISOString() } }, 201),
      json({}),
    ]);
    const { beakr } = client(fetch, { session: "conv-9" });
    const scoped = await beakr.sessions.create({ read: ["p1"] });
    await scoped.client.me.get();
    expect(calls[1]!.headers["x-beakr-session"]).toBe("conv-9");
    expect(calls[1]!.headers.authorization).toBe("Bearer bk_st_1");
  });
});

describe("sessions.start", () => {
  it("opens a fresh session whose client sends its id, and ends it", async () => {
    const { fetch, calls } = mockFetch([
      json(session(), 201),
      json({}),
      json({}),
      json(session({ lock_state: "locked" })),
      json(session({ status: "ended" })),
    ]);
    const { beakr } = client(fetch, { session: "parent" });
    const s = await beakr.sessions.start({ label: "nightly import" });
    expect(s).toBeInstanceOf(AgentSession);
    expect(s.client).toBeInstanceOf(Beakr);
    const fresh = s.agentSessionId;
    expect(fresh).toMatch(/^sdk-typescript-[0-9a-f]{32}$/);
    expect(calls[0]!.body).toEqual({ agent_session_id: fresh, label: "nightly import", client_name: "sdk-typescript" });
    expect(s.id).toBe("s1");
    await s.client.me.get();
    await beakr.me.get();
    // The session's client sends the fresh id with the same credential; the
    // client that started it keeps its own id.
    expect(calls[1]!.headers["x-beakr-session"]).toBe(fresh);
    expect(calls[1]!.headers.authorization).toBe("Bearer bk_live_test");
    expect(calls[2]!.headers["x-beakr-session"]).toBe("parent");
    expect((await s.current()).lock_state).toBe("locked");
    expect(calls[3]!.headers["x-beakr-session"]).toBe(fresh);
    await s.end();
    expect(new URL(calls[4]!.url).pathname).toBe("/v1/sessions/s1/end");
  });

  it("within() ends the session even when the work throws", async () => {
    const { fetch, calls } = mockFetch([json(session(), 201), json(session({ status: "ended" }))]);
    const { beakr } = client(fetch);
    await expect(
      beakr.sessions.within({}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(new URL(calls[1]!.url).pathname).toBe("/v1/sessions/s1/end");
  });

  it("only labels the writes on a server without sessions per conversation", async () => {
    const { fetch, calls } = mockFetch([refusal(422, "feature_not_enabled", "Not enabled."), json({})]);
    const { beakr } = client(fetch);
    const result = await beakr.sessions.within({}, async (s) => {
      expect(s.session).toBeUndefined();
      await s.client.me.get();
      return s.agentSessionId;
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["x-beakr-session"]).toBe(result);
  });
});

describe("sessions.end", () => {
  it("ends the current session without an id", async () => {
    const { fetch, calls } = mockFetch([json(session({ id: "s9" })), json(session({ id: "s9", status: "ended" }))]);
    const { beakr } = client(fetch);
    const ended = await beakr.sessions.end();
    expect(ended.status).toBe("ended");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/sessions/current");
    expect(new URL(calls[1]!.url).pathname).toBe("/v1/sessions/s9/end");
  });
});

describe("refusals", () => {
  async function refused(reply: Response): Promise<unknown> {
    const { fetch } = mockFetch([reply]);
    return client(fetch).beakr.knowledge.write("add_fact", { rationale: "r" }).catch((error: unknown) => error);
  }

  it("an ended session id is a SessionEndedError", async () => {
    const error = await refused(refusal(409, "session_ended", "This session has ended."));
    expect(error).toBeInstanceOf(SessionEndedError);
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("a read-only session names the projects it read", async () => {
    const error = (await refused(
      refusal(403, "session_read_only", "This session read Pharma A and Pharma B, so it is read-only.", {
        session_id: "s1",
        touched_projects: [PHARMA_A, PHARMA_B],
      }),
    )) as SessionReadOnlyError;
    expect(error).toBeInstanceOf(SessionReadOnlyError);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.sessionId).toBe("s1");
    expect(error.touchedProjects).toEqual([PHARMA_A, PHARMA_B]);
    expect(error.projectNames).toEqual(["Pharma A", "Pharma B"]);
    expect(error.message).toContain("Pharma A and Pharma B");
  });

  it("a locked session names its project and the refused one", async () => {
    const error = (await refused(
      refusal(403, "session_locked_to_project", "This session reads and writes Pharma A, so it cannot write Pharma B.", {
        session_id: "s1",
        write_project: PHARMA_A,
        refused_projects: [PHARMA_B],
      }),
    )) as SessionLockedToProjectError;
    expect(error).toBeInstanceOf(SessionLockedToProjectError);
    expect(error.writeProject).toEqual(PHARMA_A);
    expect(error.refusedProjects).toEqual([PHARMA_B]);
  });

  it("a write outside a session is a SessionRequiredError", async () => {
    const error = await refused(refusal(403, "session_required", "Your organization requires agents to write in a session."));
    expect(error).toBeInstanceOf(SessionRequiredError);
  });

  it("the cross-project guard's refusals are typed", async () => {
    const via = { ...PHARMA_A, via: ["cited", "read_in_session"] };
    const error = (await refused(
      refusal(403, "cross_project_write_refused", "Pharma B does not accept content from other projects.", {
        project: PHARMA_B,
        other_projects: [via],
      }),
    )) as CrossProjectWriteRefusedError;
    expect(error).toBeInstanceOf(CrossProjectWriteRefusedError);
    expect(error.project).toEqual(PHARMA_B);
    expect(error.otherProjects).toEqual([via]);
    expect(error.projectNames).toEqual(["Pharma A"]);
    const owner = await refused(refusal(403, "cross_project_owner_required", "Only an owner or admin of Pharma B."));
    expect(owner).toBeInstanceOf(CrossProjectOwnerRequiredError);
  });
});

describe("a held write", () => {
  it("is a normal result that says why it waits", async () => {
    const hold = {
      reason: "Content from Pharma A (cited).",
      projects: [{ ...PHARMA_A, via: ["cited"] }],
      approver: "owner_or_admin",
      project: PHARMA_B,
    };
    const { fetch } = mockFetch([
      json({
        content: [{ type: "text", text: "Staged." }],
        outcome: { status: "ok", approval_state: "pending" },
        proposal_id: "p1",
        proposal: { id: "p1", cross_project_hold: hold },
      }),
      json({ id: "p1", cross_project_hold: hold, needs_project_admin_to_accept: true }),
    ]);
    const { beakr } = client(fetch);
    const result = await beakr.knowledge.write("add_fact", { rationale: "r" });
    const proposal = await beakr.knowledge.proposals.get("p1");
    expect(crossProjectHold(result)).toEqual(hold);
    expect(crossProjectHold(proposal)).toEqual(hold);
    expect(crossProjectHold({ id: "p2", cross_project_hold: null })).toBeUndefined();
    expect(crossProjectHold(undefined)).toBeUndefined();
  });
});
