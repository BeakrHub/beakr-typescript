import { describe, expectTypeOf, it } from "vitest";
import type { Beakr } from "../src/index.js";

// Root cause (sandbox e2e 2026-10-27, D4): these methods were declared to
// return `JsonObject` or `unknown` although the contract types their responses,
// so a strict consumer got no field checking (`p.id` was `unknown` from
// `knowledge.proposals.iter()`). `npm run typecheck` checks these assertions;
// the test bodies only need to exist for vitest.
type Resolved<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;
type Yielded<F> = F extends (...args: never[]) => AsyncGenerator<infer T> ? T : never;

describe("responses are typed from the contract", () => {
  it("runs", () => {
    expectTypeOf<Resolved<Beakr["runs"]["start"]>["run_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Resolved<Beakr["runs"]["start"]>["thread_id"]>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<Resolved<Beakr["runs"]["get"]>["answer"]>["raw_text"]>().toEqualTypeOf<string>();
    expectTypeOf<Yielded<Beakr["runs"]["iterThreads"]>["thread_id"]>().toEqualTypeOf<string>();
  });

  it("knowledge", () => {
    expectTypeOf<Resolved<Beakr["knowledge"]["research"]>["text"]>().toEqualTypeOf<string>();
    expectTypeOf<Resolved<Beakr["knowledge"]["documents"]>>().toEqualTypeOf<
      Resolved<Beakr["knowledge"]["documentsSearch"]>
    >();
    expectTypeOf<Yielded<Beakr["knowledge"]["proposals"]["iter"]>["id"]>().toEqualTypeOf<string>();
  });

  it("conversations and context", () => {
    expectTypeOf<Resolved<Beakr["conversations"]["import"]>["conversation_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Resolved<Beakr["conversations"]["list"]>["data"][number]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Yielded<Beakr["conversations"]["iter"]>["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Resolved<Beakr["engine"]["context"]>["content"]>().toEqualTypeOf<string>();
  });

  it("uploads and skill proposals", () => {
    expectTypeOf<Resolved<Beakr["uploads"]["upload"]>["artifact"]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Resolved<Beakr["uploads"]["batchStatus"]>["batch_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Yielded<Beakr["skills"]["proposals"]["iter"]>["id"]>().toEqualTypeOf<string>();
  });
});
