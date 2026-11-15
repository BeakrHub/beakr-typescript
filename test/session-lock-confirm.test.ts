/**
 * Confirm before entering a locked project (engine `max/lock-confirm`): a held
 * call is a `SessionLockConfirmError` naming the project, what entering costs
 * and the id to confirm, and `beakr.confirmingLock(id)` repeats it with
 * `X-Beakr-Confirm-Lock`. The Python SDK's tests/test_session_lock_confirm.py
 * pins the same behaviour.
 */
import { describe, expect, it } from "vitest";
import { CONFIRM_LOCK_HEADER, ConflictError, SessionLockConfirmError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const A = "4dd25154-0d80-44ab-b4c2-167319bfacb4";
const B = "8b2f6c10-3d4e-4f5a-9b6c-7d8e9f0a1b2c";
const MESSAGE =
  "Heads-up: Partner A is siloed. Reading it limits this session's writes to Partner A, " +
  "so it can no longer write to Chemistry (written earlier in this session). To go in, " +
  `repeat this call with confirm_lock="${A}"; or ask the user, or start a new session ` +
  "for Partner A.";
const FIX = `Repeat this call with confirm_lock="${A}" (over HTTP, send X-Beakr-Confirm-Lock: ${A}).`;
const COST = "can no longer write to Chemistry (written earlier in this session)";
const HEADER = CONFIRM_LOCK_HEADER.toLowerCase();

function held(envelopeExtras = true) {
  const extras = { session_id: "s1", project: { id: A, name: "Partner A" }, cost: COST, confirm_lock: A };
  const base = { code: "session_lock_confirm", message: MESSAGE, fix: FIX };
  return json({ detail: { ...base, ...extras }, error: envelopeExtras ? { ...base, ...extras } : base }, 409);
}

describe("lock confirm", () => {
  it("a held call throws the error naming the project, cost and id", async () => {
    const { fetch } = mockFetch([held()]);
    const error = await client(fetch).beakr.me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionLockConfirmError);
    expect(error).toBeInstanceOf(ConflictError);
    const held_ = error as SessionLockConfirmError;
    expect(held_.status).toBe(409);
    expect(held_.code).toBe("session_lock_confirm");
    expect(held_.fix).toBe(FIX);
    expect(held_.project).toEqual({ id: A, name: "Partner A" });
    expect([held_.projectId, held_.projectName]).toEqual([A, "Partner A"]);
    expect(held_.cost).toBe(COST);
    expect(held_.confirmLock).toBe(A);
    expect(held_.sessionId).toBe("s1");
  });

  it("reads the extras from detail when the envelope lacks them", async () => {
    const { fetch } = mockFetch([held(false)]);
    const error = (await client(fetch).beakr.me.get().catch((e: unknown) => e)) as SessionLockConfirmError;
    expect(error.confirmLock).toBe(A);
    expect(error.cost).toBe(COST);
  });

  it("confirmingLock sends the header on that client only, same session", async () => {
    const ok = () => json({});
    const { fetch, calls } = mockFetch([ok(), ok(), ok(), ok()]);
    const { beakr } = client(fetch);
    await beakr.me.get();
    const confirming = beakr.confirmingLock(A);
    await confirming.me.get();
    await confirming.confirmingLock(B).me.get();
    await beakr.me.get();
    expect(calls.map((c) => c.headers[HEADER])).toEqual([undefined, A, `${A},${B}`, undefined]);
    expect(new Set(calls.map((c) => c.headers["x-beakr-session"])).size).toBe(1);
  });

  it("the confirmed retry goes in", async () => {
    const answer = (call: { headers: Record<string, string> }) =>
      call.headers[HEADER] === A ? json({ id: "u1" }) : held();
    const { fetch } = mockFetch([answer, answer]);
    const { beakr } = client(fetch);
    const error = (await beakr.me.get().catch((e: unknown) => e)) as SessionLockConfirmError;
    expect(await beakr.confirmingLock(error.confirmLock!).me.get()).toEqual({ id: "u1" });
  });
});
