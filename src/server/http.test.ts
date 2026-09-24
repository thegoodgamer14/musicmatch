import { describe, expect, it } from "vitest";
import { COPY } from "./copy";
import { authorizeUrl, failureRedirect, messageErrorBody } from "./http";

describe("authorizeUrl", () => {
  it("sends the api key and this app's callback to Last.fm", () => {
    const url = new URL(authorizeUrl("http://localhost:3000", "abc123"));
    expect(url.origin).toBe("https://www.last.fm");
    expect(url.pathname).toBe("/api/auth/");
    expect(url.searchParams.get("api_key")).toBe("abc123");
    expect(url.searchParams.get("cb")).toBe("http://localhost:3000/api/auth/callback");
    expect(url.searchParams.get("token")).toBeNull();
  });

  it("does not add a desktop token, so Last.fm can return to the callback", () => {
    const url = new URL(authorizeUrl("http://localhost:3000/", "abc123"));
    expect(url.searchParams.get("api_key")).toBe("abc123");
    expect(url.searchParams.get("token")).toBeNull();
    expect(url.searchParams.get("cb")).toBe("http://localhost:3000/api/auth/callback");
    expect([...url.searchParams.keys()]).toEqual(["api_key", "cb"]);
  });
});

describe("failureRedirect", () => {
  it("returns each auth failure to the sign-in screen", () => {
    expect(failureRedirect("denied")).toBe("/?error=denied");
    expect(failureRedirect("rejected")).toBe("/?error=rejected");
    expect(failureRedirect("unreachable")).toBe("/?error=unreachable");
  });
});

describe("messageErrorBody", () => {
  it("returns the exact empty and too-long copy", () => {
    expect(messageErrorBody("empty")).toEqual({ error: COPY.emptyMessage });
    expect(messageErrorBody("too_long")).toEqual({ error: COPY.tooLong });
    expect(messageErrorBody("empty").error).toBe("Write a message first.");
    expect(messageErrorBody("too_long").error).toBe("Messages can be at most 500 characters.");
  });
});
