import { describe, expect, it } from "vitest";
import { normalizeName, songKey } from "./song-key";

describe("songKey", () => {
  it("normalizes case and whitespace and ignores nothing about punctuation", () => {
    expect(normalizeName("  Let   It\tBe ")).toBe("let it be");
    expect(songKey(" The Beatles ", "  Let   It  Be ")).toBe(
      "the beatles\u001flet it be",
    );
    expect(songKey("THE BEATLES", "let it be")).toBe(
      songKey("the beatles", "let it be"),
    );
    expect(songKey("Journey", "Don't Stop")).not.toBe(
      songKey("Journey", "Dont Stop"),
    );
  });

  it("applies NFKC before lowercasing", () => {
    expect(songKey("ﬁle", "Ａ")).toBe(songKey("file", "A"));
  });
});
