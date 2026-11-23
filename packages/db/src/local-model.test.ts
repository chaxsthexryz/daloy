import { describe, expect, it } from "vitest";
import { isLocalModel } from "./ai-settings";

describe("isLocalModel", () => {
  it("treats Ollama and servers on this machine as local, so they get the short prompt", () => {
    expect(isLocalModel({ provider: "ollama", baseUrl: "https://ollama.example.com" })).toBe(true);
    expect(isLocalModel({ provider: "openai", baseUrl: "http://localhost:1234/v1" })).toBe(true);
    expect(isLocalModel({ provider: "openai", baseUrl: "http://host.docker.internal:8080" })).toBe(true);
    expect(isLocalModel({ provider: "openai", baseUrl: "not a url" })).toBe(true);
  });

  it("treats hosted providers as hosted", () => {
    expect(isLocalModel({ provider: "openai", baseUrl: "https://api.deepseek.com" })).toBe(false);
    expect(isLocalModel({ provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" })).toBe(false);
  });
});
