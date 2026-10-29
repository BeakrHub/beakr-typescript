import { describe, expect, it } from "vitest";
import {
  BeakrError,
  errorFromResponse,
  NotFoundError,
  ServerError,
  UnexpectedResponseError,
} from "../src/index.js";
import { client, mockFetch } from "./helpers.js";

// Root cause: errorFromResponse used a body that is not JSON as the message,
// so a client pointed at a wrong base URL (a web app, a proxy, a server that
// is not Beakr) threw the whole HTML page as the error; a 200 HTML page was
// returned to the caller as a string where an object was expected.

const PAGE = `<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: 404</p>
        <p>Message: File not found.</p>
    </body>
</html>
`;

function html(page: string, status: number): Response {
  return new Response(page, { status, headers: { "content-type": "text/html" } });
}

describe("responses that are not JSON", () => {
  it("names an HTML error page by its title instead of printing it", () => {
    const error = errorFromResponse(404, new Headers({ "content-type": "text/html" }), PAGE, "Not Found", Date.now(), "https://wrong.test");
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).not.toContain("<html");
    expect(error.message).toContain(
      'The server answered with an HTML page ("Error response"), not a Beakr API response (called https://wrong.test)',
    );
    expect(error.fix).toContain("BEAKR_BASE_URL");
    expect(error.message).toContain("To fix: Check the API URL");
    expect(error.body).toBe(PAGE);
  });

  it("says to retry a gateway page when the URL is right", () => {
    const error = errorFromResponse(502, new Headers(), "<html><title>502 Bad Gateway</title></html>");
    expect(error).toBeInstanceOf(ServerError);
    expect(error.message).toContain('("502 Bad Gateway")');
    expect(error.fix).toContain("retry shortly");
  });

  it("cuts other text to one short line", () => {
    const error = errorFromResponse(503, new Headers(), `upstream connect error\n${"x".repeat(1000)}`);
    expect(error.message.startsWith("upstream connect error x")).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual(200);
    expect(error.message).not.toContain("\n");
  });

  it("throws a typed error for a 404 page through the client", async () => {
    const { fetch } = mockFetch([html(PAGE, 404)]);
    const { beakr } = client(fetch);
    const error = await beakr.projects.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as Error).message).not.toContain("<html");
    expect((error as Error).message).toContain("(called https://api.example.test)");
  });

  it("throws UnexpectedResponseError for a 200 HTML page instead of returning it", async () => {
    const { fetch } = mockFetch([html("<html><head><title>Beakr</title></head></html>", 200)]);
    const { beakr } = client(fetch);
    const error = await beakr.projects.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error).toBeInstanceOf(BeakrError);
    expect((error as UnexpectedResponseError).status).toBe(200);
    expect((error as UnexpectedResponseError).code).toBe("unexpected_response");
    expect((error as Error).message).toContain('The server answered with an HTML page ("Beakr")');
  });

  it("never names a user name, password or query of the base URL", () => {
    // Security review: a base URL with credentials in it printed them.
    const error = errorFromResponse(404, new Headers(), PAGE, "", Date.now(), "https://ada:s3cret@wrong.test:8443/api?token=abc");
    expect(error.message).toContain("(called https://wrong.test:8443/api)");
    expect(error.message).not.toContain("s3cret");
    expect(error.message).not.toContain("token");
  });

  it("removes control characters from a title or excerpt", () => {
    // Security review: the server's text is printed to a terminal; an ANSI
    // escape sequence in it must not reach it.
    const page = "<html><title>Hi\u001b[2J\u001b]0;owned\u0007 there\u202e</title></html>";
    const error = errorFromResponse(404, new Headers(), page);
    expect(error.message).toContain('("Hi[2J]0;owned there")');
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f\u202e]/);
    const plain = errorFromResponse(503, new Headers(), "down\u001b[31m now");
    expect(plain.message).toBe("down[31m now");
  });

  it("searches only the start of a huge body for the title", () => {
    // Security review: the unbounded pattern scanned the whole body.
    const late = `<html>${" ".repeat(5000)}<title>Late</title></html>`;
    expect(errorFromResponse(404, new Headers(), late).message).toContain("answered with an HTML page, not a Beakr API response");
    const huge = `<html><title>${"x".repeat(5_000_000)}`;
    expect(errorFromResponse(404, new Headers(), huge).message).not.toContain("x".repeat(100));
  });
});
