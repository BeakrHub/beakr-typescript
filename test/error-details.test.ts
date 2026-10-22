import { describe, expect, it } from "vitest";
import {
  errorFromResponse,
  PermissionDeniedError,
  PersonReviewRequiredError,
  RateLimitError,
  ValidationError,
} from "../src/errors.js";

// The server's envelope carries structured context in `error.details` (SPEC-117);
// older servers put it beside `code`. Both must reach the typed error.
describe("error.details", () => {
  it("exposes validation field errors from details", () => {
    const errors = [
      { loc: ["body", "name"], msg: "Field required", type: "missing" },
      { loc: ["body", "size"], msg: "Input should be greater than 0", type: "greater_than" },
    ];
    const error = errorFromResponse(422, new Headers(), {
      detail: errors,
      error: { code: "validation_error", message: "Field required", details: { errors }, request_id: "r1" },
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toEqual({ errors });
    expect(error.requestId).toBe("r1");
  });

  it("reads required_scope from details first, then the envelope", () => {
    const fromDetails = errorFromResponse(403, new Headers(), {
      error: { code: "insufficient_scope", message: "m", details: { required_scope: "kb:write" } },
    }) as PermissionDeniedError;
    expect(fromDetails.requiredScope).toBe("kb:write");
    const legacy = errorFromResponse(403, new Headers(), {
      error: { code: "insufficient_scope", message: "m", required_scope: "kb:read" },
    }) as PermissionDeniedError;
    expect(legacy.requiredScope).toBe("kb:read");
    expect(legacy.details).toEqual({});
  });

  it("types a person-only refusal as PersonReviewRequiredError", () => {
    const error = errorFromResponse(403, new Headers(), {
      error: {
        code: "person_review_required",
        message: "A person must accept proposals in this project.",
        fix: "Ask a person to accept it in Beakr.",
      },
    });
    expect(error).toBeInstanceOf(PersonReviewRequiredError);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.code).toBe("person_review_required");
    expect(error.fix).toBe("Ask a person to accept it in Beakr.");
    const other = errorFromResponse(403, new Headers(), { error: { code: "insufficient_scope", message: "m" } });
    expect(other).not.toBeInstanceOf(PersonReviewRequiredError);
  });

  it("defaults details to an empty object for legacy bodies", () => {
    expect(errorFromResponse(404, new Headers(), { detail: "Not found" }).details).toEqual({});
  });
});

describe("quota refusals", () => {
  // Root cause (proof run): a 429 quota_exceeded said only "Uploads limit
  // reached"; the limit, window and reset the server sent in error.details,
  // and its error.fix, never reached the person reading the error.
  it("say the limit, its window, when it resets and how to fix it", () => {
    const error = errorFromResponse(
      429,
      new Headers(),
      {
        error: {
          code: "quota_exceeded",
          message: "Uploads limit reached",
          fix: "Wait for the window to reset, or ask an admin to raise the limit.",
          details: { resource: "uploads", current: 10, limit: 10, window: "day", resets_at: "2026-10-14T00:00:00Z" },
        },
      },
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.fix).toBe("Wait for the window to reset, or ask an admin to raise the limit.");
    expect(error.message).toContain("(10 of 10 uploads per day; resets 2026-10-14T00:00:00Z)");
    expect(error.message).toContain("To fix: Wait for the window to reset");
  });
});
