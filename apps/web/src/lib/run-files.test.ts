import { describe, expect, it } from "vitest";
import { fileRefs, fileSize } from "./run-files";

const ref = { id: "a1", name: "id.png", type: "png", size: 2048 };

describe("fileRefs", () => {
  it("collects refs from every field that holds them", () => {
    expect(fileRefs({ name: "Ana", photo: [ref], tags: ["x"], empty: [] })).toEqual([ref]);
  });
  it("ignores other payloads", () => {
    for (const p of [null, undefined, "x", 3, [], { a: [{ id: 1 }] }]) expect(fileRefs(p)).toEqual([]);
  });
});

describe("fileSize", () => {
  it("uses B, KB and MB", () => {
    expect([fileSize(500), fileSize(2048), fileSize(3 * 1024 * 1024)]).toEqual(["500 B", "2 KB", "3.0 MB"]);
  });
});
