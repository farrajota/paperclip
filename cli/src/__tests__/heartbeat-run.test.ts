import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatRun } from "../commands/heartbeat-run.js";
import { resolveCommandContext } from "../commands/client/common.js";

const mocks = vi.hoisted(() => ({
  formatterAcquisitionFails: false,
  contextApi: {
    get: vi.fn(),
    post: vi.fn(),
  },
  resolveCommandContext: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({
  get getCLIAdapter() {
    if (mocks.formatterAcquisitionFails) {
      throw new Error("formatter registry acquisition failed");
    }
    return () => {
      if (mocks.formatterAcquisitionFails) {
        throw new Error("formatter registry acquisition failed");
      }
      return undefined;
    };
  },
}));

vi.mock("../commands/client/common.js", () => ({
  resolveCommandContext: mocks.resolveCommandContext,
}));

describe("heartbeatRun", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.formatterAcquisitionFails = false;
    mocks.contextApi.get.mockReset().mockResolvedValue({
      id: "agent-1",
      name: "Agent",
      adapterType: "claude_local",
    });
    mocks.contextApi.post.mockReset().mockResolvedValue({ id: "run-1", status: "running" });
    mocks.resolveCommandContext.mockReset().mockReturnValue({ api: mocks.contextApi });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.formatterAcquisitionFails = false;
  });

  it("rejects formatter acquisition before resolving context or issuing heartbeat requests", async () => {
    mocks.formatterAcquisitionFails = true;

    await expect(heartbeatRun({
      agentId: "agent-1",
      source: "on_demand",
      trigger: "manual",
      timeoutMs: "1000",
    })).rejects.toThrow("formatter registry acquisition failed");

    expect(resolveCommandContext).not.toHaveBeenCalled();
    expect(mocks.contextApi.get).not.toHaveBeenCalled();
    expect(mocks.contextApi.post).not.toHaveBeenCalled();
  });
});
