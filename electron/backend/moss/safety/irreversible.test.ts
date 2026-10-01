import { describe, expect, it } from "vitest";

import { resolvePermission } from "../permission";
import { labelsNameIrreversibleAction, namesIrreversibleAction } from "./irreversible";

describe("irreversible actions", () => {
  it("recognizes purchases, payments, and other final actions", () => {
    for (const label of ["Place order", "Order now", "Order", "Buy now", "Make payment", "Pay with PayPal", "Checkout", "Check out", "Transfer funds", "Book this room", "Book", "Post", "Post comment", "Delete account", "Send"]) {
      expect(namesIrreversibleAction(label)).toBe(true);
    }
    for (const label of ["Next page", "Reviews", "Posts", "Settings", "Search", "Cancel", "Order history", "Sort order", "Address book", "Post code", "Bookmarks"]) {
      expect(namesIrreversibleAction(label)).toBe(false);
    }
  });

  it("checks labels only, so typed text and URLs do not trigger it", () => {
    expect(labelsNameIrreversibleAction({ element: "Place order button", ref: "e4" })).toBe(true);
    expect(labelsNameIrreversibleAction({ fields: [{ name: "Confirm purchase", value: "yes" }] })).toBe(true);
    expect(labelsNameIrreversibleAction({ element: "Search box", text: "how to remove stains and send parcels" })).toBe(false);
    expect(labelsNameIrreversibleAction({ url: "https://example.com/how-to-remove-rust" })).toBe(false);
  });

  it("makes the built-in browser click and ignored-flag MCP clicks ask for final actions", () => {
    expect(resolvePermission({ name: "browser_click", autoApprove: true, args: { name: "Buy now" } })).toMatchObject({ action: "prompt", risk: "destructive" });
    expect(resolvePermission({ name: "mcp__playwright__browser_click", autoApprove: true, checkIrreversible: true, args: { element: "Make payment", ref: "e1" } }))
      .toMatchObject({ action: "prompt", risk: "destructive" });
    expect(resolvePermission({ name: "mcp__playwright__browser_navigate", autoApprove: true, checkIrreversible: true, args: { url: "https://example.com/remove-stains" } }))
      .toMatchObject({ action: "run" });
  });
});

describe("page navigation by MCP browser tools", () => {
  const navigate = (url: string) => resolvePermission({ name: "mcp__playwright__browser_navigate", autoApprove: true, networkRead: true, checkIrreversible: true, args: { url } });

  it("runs public web pages and asks before local files, scripts, and local addresses", () => {
    expect(navigate("https://www.dpreview.com/reviews/x").action).toBe("run");
    for (const url of ["http://localhost./", "http://foo.local./", "http://foo.internal./", "http://intranet/", "http://router:8080/", "http://[fec0::1]/", "file:///C:/Users/me/.ssh/id_rsa", "javascript:alert(1)", "data:text/html,<script>1</script>", "http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1/", "http://localhost:3000", "http://[::1]/", "http://10.0.0.5/admin"]) {
      expect(navigate(url)).toMatchObject({ action: "prompt", rule: expect.stringContaining("not a public web page") });
    }
  });
});