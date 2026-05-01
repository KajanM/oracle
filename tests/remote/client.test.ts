import { describe, expect, it } from "vitest";
import { formatRemoteErrorMessage } from "../../src/remote/client.js";

describe("remote client error formatting", () => {
  it("surfaces socket details when Node reports an empty aggregate message", () => {
    const first = Object.assign(new Error(""), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "::1",
      port: 7333,
    });
    const second = Object.assign(new Error(""), {
      code: "ETIMEDOUT",
      syscall: "connect",
      address: "100.85.201.62",
      port: 7333,
    });

    const message = formatRemoteErrorMessage(new AggregateError([first, second], ""));

    expect(message).toContain("ECONNREFUSED");
    expect(message).toContain("address=::1");
    expect(message).toContain("ETIMEDOUT");
    expect(message).toContain("address=100.85.201.62");
    expect(message).toContain("port=7333");
  });
});
