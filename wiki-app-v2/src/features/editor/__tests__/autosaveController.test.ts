import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import { AutosaveController, type PendingSave } from "../autosaveController.js";

const pending = (content: string, expectedUpdatedAt = new Date("2026-01-01T00:00:00Z")): PendingSave => ({
  content,
  title: undefined,
  titleProvided: false,
  expectedUpdatedAt,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () =>
  new Promise<void>((resolve) => {
    // Enough microtask turns for an await chain to complete.
    for (let i = 0; i < 10; i++) queueMicrotask(() => {});
    queueMicrotask(resolve);
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("AutosaveController", () => {
  it("debounces scheduleSave into a single save and reports saved", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ updatedAt: "2026-01-01T00:00:01Z" });
    const states: string[] = [];
    const savedAt: Date[] = [];
    const controller = new AutosaveController("b1", save, {
      onSaved: (d) => savedAt.push(d),
      onConflict: vi.fn(),
      onStateChange: (s) => states.push(s),
    });

    controller.scheduleSave(pending("one"));
    await vi.advanceTimersByTimeAsync(1200);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toMatchObject({ content: "one" });
    expect(savedAt[0]?.toISOString()).toBe("2026-01-01T00:00:01.000Z");
    expect(states).toEqual(["dirty", "saving", "saved"]);
  });

  it("does not drop an edit that arrives while a save is in flight (race regression)", async () => {
    vi.useFakeTimers();
    const d1 = deferred<{ updatedAt: string }>();
    const save = vi
      .fn<(b: string, p: PendingSave) => Promise<{ updatedAt: string }>>()
      .mockImplementationOnce(() => d1.promise)
      .mockResolvedValueOnce({ updatedAt: "2026-01-01T00:00:02Z" });
    const states: string[] = [];
    const controller = new AutosaveController("b1", save, {
      onSaved: vi.fn(),
      onConflict: vi.fn(),
      onStateChange: (s) => states.push(s),
    });

    // First edit debounces then starts a save that stays in flight.
    controller.scheduleSave(pending("one"));
    await vi.advanceTimersByTimeAsync(1200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("saving");

    // Second edit lands while the first save is still in flight.
    controller.scheduleSave(pending("two"));
    expect(states.at(-1)).toBe("dirty");

    // The in-flight save completes — it must NOT wipe the newer "two" payload.
    d1.resolve({ updatedAt: "2026-01-01T00:00:01Z" });
    await settle();

    expect(save).toHaveBeenCalledTimes(1); // still only the first save
    expect(controller.queued).toMatchObject({ content: "two" });
    expect(states.at(-1)).toBe("dirty");

    // The pending debounce then flushes the newer payload.
    await vi.advanceTimersByTimeAsync(1200);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toMatchObject({ content: "two" });
  });

  it("saveNow during an in-flight save flushes the replacement promptly", async () => {
    vi.useFakeTimers();
    const d1 = deferred<{ updatedAt: string }>();
    const save = vi
      .fn<(b: string, p: PendingSave) => Promise<{ updatedAt: string }>>()
      .mockImplementationOnce(() => d1.promise)
      .mockResolvedValueOnce({ updatedAt: "2026-01-01T00:00:02Z" });
    const controller = new AutosaveController("b1", save, {
      onSaved: vi.fn(),
      onConflict: vi.fn(),
      onStateChange: vi.fn(),
    });

    controller.saveNow(pending("one"));
    await settle();
    controller.saveNow(pending("two"));
    d1.resolve({ updatedAt: "2026-01-01T00:00:01Z" });
    await settle();

    // The replacement was saved right after the in-flight save, with no timer
    // needed and nothing left queued.
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toMatchObject({ content: "two" });
    expect(controller.queued).toBeNull();
  });

  it("409 surfaces a hard conflict and never retries", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValue(new ApiError(409, {}));
    const onConflict = vi.fn();
    const states: string[] = [];
    const controller = new AutosaveController("b1", save, {
      onSaved: vi.fn(),
      onConflict,
      onStateChange: (s) => states.push(s),
    });

    controller.saveNow(pending("one"));
    await settle();

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["saving", "conflict"]);
    // No retry — advancing time far past the backoff must not re-call save.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure with backoff without dropping the edit", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValueOnce({ updatedAt: "2026-01-01T00:00:03Z" });
    const states: string[] = [];
    const controller = new AutosaveController("b1", save, {
      onSaved: vi.fn(),
      onConflict: vi.fn(),
      onStateChange: (s) => states.push(s),
    });

    controller.saveNow(pending("one"));
    await settle();
    expect(states.at(-1)).toBe("offline");

    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(states.at(-1)).toBe("offline");
    expect(save).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(states.at(-1)).toBe("saved");
    expect(save).toHaveBeenCalledTimes(3);
    // The payload survived the failures.
    expect(save.mock.calls[2]![1]).toMatchObject({ content: "one" });
  });

  it("dispose cancels the retry timer but keeps queued work for the caller", () => {
    vi.useFakeTimers();
    const controller = new AutosaveController("b1", vi.fn(), {
      onSaved: vi.fn(),
      onConflict: vi.fn(),
      onStateChange: vi.fn(),
    });
    controller.scheduleSave(pending("one"));
    controller.dispose();
    expect(controller.queued).toMatchObject({ content: "one" });

    // No save happens after dispose.
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
