import { describe, expect, it } from "vitest";
import { sameAgentRoutePlaceholder } from "./AgentDetail";

const AGENT_ID = "6f1f2c1e-1111-4222-8333-444455556666";
const maya = { id: AGENT_ID, companyId: "company-a", name: "Maya", urlKey: "maya" };

describe("sameAgentRoutePlaceholder", () => {
  it("keeps the agent while its UUID route canonicalizes to the URL key", () => {
    expect(sameAgentRoutePlaceholder(maya, "maya", "company-a")).toBe(maya);
  });

  it("keeps the agent while the company of its UUID route resolves", () => {
    expect(sameAgentRoutePlaceholder(maya, AGENT_ID, "company-a")).toBe(maya);
  });

  it("keeps the agent while no company is known yet", () => {
    expect(sameAgentRoutePlaceholder(maya, AGENT_ID, undefined)).toBe(maya);
  });

  it("does not show a different agent while the new route loads", () => {
    expect(sameAgentRoutePlaceholder(maya, "nora", "company-a")).toBeUndefined();
  });

  it("does not show another company's agent that shares the URL key", () => {
    expect(sameAgentRoutePlaceholder(maya, "maya", "company-b")).toBeUndefined();
  });

  it("has nothing to keep before the first read", () => {
    expect(sameAgentRoutePlaceholder(undefined, "maya", "company-a")).toBeUndefined();
  });
});
