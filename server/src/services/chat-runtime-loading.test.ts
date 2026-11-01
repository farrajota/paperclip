import { afterEach, describe, expect, it, vi } from "vitest";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function loadChatRuntime() {
  // Tests must cross the real ESM module-loading boundary to prove laziness.
  return await import("./chat-runtime.js");
}

afterEach(() => {
  vi.doUnmock("./chat-sdk-runtime.js");
  vi.doUnmock("./voice/voice-runtime.js");
  vi.resetModules();
});

describe("ChatRuntime optional SDK module boundary", () => {
  it("keeps voice registry operations available when the SDK module cannot load", async () => {
    vi.doMock("./chat-sdk-runtime.js", () => {
      throw new Error("optional SDK module unavailable");
    });
    vi.doMock("./voice/voice-runtime.js", () => ({
      createVoiceRuntime: ({ endpointId }: { endpointId: string }) => ({
        endpointId,
        shutdown: vi.fn(async () => undefined),
      }),
    }));

    const { ChatRuntime } = await loadChatRuntime();
    const registry = new ChatRuntime();
    const voice = await registry.replaceVoiceEndpoint({
      companyId: "company-1",
      endpointId: "voice-1",
      userName: "Voice",
      persistence: {} as never,
    });

    expect(registry.get("voice-1")).toBe(voice);
    expect(registry.list()).toEqual([voice]);
    await expect(
      registry.replaceEndpoint({ endpointId: "sdk-1" } as never),
    ).rejects.toThrow("There was an error when mocking a module");
    expect(registry.get("voice-1")).toBe(voice);
    expect(await registry.removeEndpoint("voice-1")).toBe(true);
  });

  it("reports the first SDK import failure and still permits unrelated endpoint progress", async () => {
    vi.doMock("./chat-sdk-runtime.js", () => {
      throw new Error("SDK import failed");
    });
    vi.doMock("./voice/voice-runtime.js", () => ({
      createVoiceRuntime: ({ endpointId }: { endpointId: string }) => ({
        endpointId,
        shutdown: vi.fn(async () => undefined),
      }),
    }));

    const { ChatRuntime } = await loadChatRuntime();
    const registry = new ChatRuntime();
    const failedReplacement = registry.replaceEndpoint({ endpointId: "sdk-1" } as never);
    await expect(failedReplacement).rejects.toThrow(
      "There was an error when mocking a module",
    );
    const voice = await registry.replaceVoiceEndpoint({
      companyId: "company-1",
      endpointId: "voice-1",
      userName: "Voice",
      persistence: {} as never,
    });
    expect(registry.get("voice-1")).toBe(voice);
  });

  it.each(["supersession", "removal", "shutdown"] as const)(
    "does not construct an SDK endpoint after a held import is invalidated by %s",
    async (invalidation) => {
      const importEntered = deferred<void>();
      const importGate = deferred<void>();
      const factory = vi.fn(() => ({
        endpointId: "sdk-1",
        shutdown: vi.fn(async () => undefined),
      }));
      vi.doMock("./chat-sdk-runtime.js", async () => {
        // This signal proves the queued replacement entered import() before invalidation.
        importEntered.resolve();
        await importGate.promise;
        return { createChatSdkEndpointRuntime: factory };
      });
      vi.doMock("./voice/voice-runtime.js", () => ({
        createVoiceRuntime: ({ endpointId }: { endpointId: string }) => ({
          endpointId,
          shutdown: vi.fn(async () => undefined),
        }),
      }));

      const { ChatRuntime } = await loadChatRuntime();
      const registry = new ChatRuntime();
      const invalidated = registry.replaceEndpoint({ endpointId: "sdk-1" } as never);
      const expectedRejection = expect(invalidated).rejects.toThrow(
        invalidation === "shutdown"
          ? "Chat SDK runtime is shutting down"
          : "superseded",
      );
      const pendingOperations: Promise<unknown>[] = [
        invalidated,
        expectedRejection,
      ];
      let followupOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let unrelatedOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;

      try {
        await importEntered.promise;

        if (invalidation === "supersession") {
          followupOutcome = Promise.allSettled([
            registry.replaceEndpoint({ endpointId: "sdk-1" } as never),
          ]);
        } else if (invalidation === "removal") {
          followupOutcome = Promise.allSettled([
            registry.removeEndpoint("sdk-1"),
          ]);
        } else {
          followupOutcome = Promise.allSettled([registry.shutdown()]);
          const blockedReplacement = registry.replaceVoiceEndpoint({
            companyId: "company-1",
            endpointId: "voice-1",
            userName: "Voice",
            persistence: {} as never,
          });
          const blockedReplacementRejection = expect(
            blockedReplacement,
          ).rejects.toThrow("Chat runtime is shutting down");
          pendingOperations.push(blockedReplacement, blockedReplacementRejection);
          await blockedReplacementRejection;
        }

        if (invalidation !== "shutdown") {
          const unrelated = registry.replaceVoiceEndpoint({
            companyId: "company-1",
            endpointId: "voice-1",
            userName: "Voice",
            persistence: {} as never,
          });
          unrelatedOutcome = Promise.allSettled([unrelated]);
          const unrelatedRuntime = await unrelated;
          expect(registry.get("voice-1")).toBe(unrelatedRuntime);
        }
      } finally {
        importGate.resolve();
        await Promise.allSettled(pendingOperations);
        await followupOutcome;
        await unrelatedOutcome;
      }

      await expectedRejection;
      const [followup] = await followupOutcome!;
      expect(followup?.status).toBe("fulfilled");
      if (followup?.status === "fulfilled") {
        if (invalidation === "supersession") {
          expect(followup.value).toMatchObject({ endpointId: "sdk-1" });
          expect(registry.get("sdk-1")).toBe(followup.value);
          expect(factory).toHaveBeenCalledTimes(1);
        } else if (invalidation === "removal") {
          expect(followup.value).toBe(false);
          expect(registry.get("sdk-1")).toBeNull();
          expect(factory).not.toHaveBeenCalled();
        } else {
          expect(followup.value).toBeUndefined();
          expect(registry.get("sdk-1")).toBeNull();
          expect(registry.list()).toEqual([]);
          expect(factory).not.toHaveBeenCalled();
        }
      }
    },
  );
});
