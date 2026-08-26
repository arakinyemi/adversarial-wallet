import { afterEach, describe, expect, test } from "vitest";
import { getSessionPin, isUnlocked, lock, subscribe, unlock } from "./session-lock";

afterEach(() => lock());

describe("session lock", () => {
  test("starts locked", () => {
    expect(isUnlocked()).toBe(false);
    expect(getSessionPin()).toBeNull();
  });

  test("unlock caches the pin, lock clears it", () => {
    unlock("483920");
    expect(isUnlocked()).toBe(true);
    expect(getSessionPin()).toBe("483920");
    lock();
    expect(isUnlocked()).toBe(false);
    expect(getSessionPin()).toBeNull();
  });

  test("subscribers are notified on lock and unlock", () => {
    let hits = 0;
    const unsub = subscribe(() => hits++);
    unlock("111111");
    lock();
    expect(hits).toBe(2);
    unsub();
    unlock("222222");
    expect(hits).toBe(2);
  });
});
