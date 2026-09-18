// electron/backend/moss/approval-broker.test.ts
//
// Unit tests for the approval bridge between the async agent loop and the
// renderer's approve/deny click. Pure logic, no Electron.

import { describe, expect, it } from "vitest";

import { ApprovalBroker } from "./approval-broker";

describe("ApprovalBroker", () => {
  it("denies requests registered after cancellation", async () => {
    const broker = new ApprovalBroker();
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request("late", controller.signal)).resolves.toMatchObject({ approved: false });
    expect(broker.pendingCallId()).toBeUndefined();
  });

  it("releases an active wait immediately on cancellation", async () => {
    const broker = new ApprovalBroker();
    const controller = new AbortController();
    const pending = broker.request("active", controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(broker.pendingCallId()).toBeUndefined();
  });
  it("resolves a pending request with approval", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("call-1");
    broker.resolve("call-1", { approved: true, comment: "Reviewed" });
    await expect(pending).resolves.toEqual({ approved: true, comment: "Reviewed" });
  });

  it("resolves a pending request with denial", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("call-1");
    broker.resolve("call-1", { approved: false, comment: "Wrong target" });
    await expect(pending).resolves.toEqual({ approved: false, comment: "Wrong target" });
  });

  it("routes decisions to the matching call id independently", async () => {
    const broker = new ApprovalBroker();
    const a = broker.request("a");
    const b = broker.request("b");
    broker.resolve("b", { approved: true });
    broker.resolve("a", { approved: false });
    await expect(a).resolves.toEqual({ approved: false });
    await expect(b).resolves.toEqual({ approved: true });
  });

  it("denies everything still pending on denyAll", async () => {
    const broker = new ApprovalBroker();
    const a = broker.request("a");
    const b = broker.request("b");
    broker.denyAll();
    await expect(a).resolves.toEqual({ approved: false });
    await expect(b).resolves.toEqual({ approved: false });
  });

  it("ignores resolve for an unknown call id", async () => {
    const broker = new ApprovalBroker();
    expect(() => broker.resolve("missing", { approved: true })).not.toThrow();
    // A real pending request still works afterward.
    const pending = broker.request("real");
    broker.resolve("real", { approved: true });
    await expect(pending).resolves.toEqual({ approved: true });
  });

  it("treats a second resolve for the same call id as a no-op", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("a");
    broker.resolve("a", { approved: true });
    expect(() => broker.resolve("a", { approved: false })).not.toThrow();
    await expect(pending).resolves.toEqual({ approved: true });
  });

  it("treats resolve after denyAll as a no-op", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request("a");
    broker.denyAll();
    expect(() => broker.resolve("a", { approved: true })).not.toThrow();
    await expect(pending).resolves.toEqual({ approved: false });
  });
});
