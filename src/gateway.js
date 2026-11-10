import { randomBytes } from "node:crypto";

export function createGateway() {
  let mode = "healthy";

  return {
    mode() {
      return mode;
    },
    setMode(next) {
      if (next !== "healthy" && next !== "down") {
        throw new Error("payment gateway mode must be healthy or down");
      }
      mode = next;
    },
    async charge({ orderId, amountCents }) {
      if (mode === "down") {
        const error = new Error(`Payment gateway refused capture for ${orderId} (${amountCents} cents).`);
        error.code = "GATEWAY_DOWN";
        throw error;
      }
      return { providerRef: `pay_${randomBytes(4).toString("hex")}` };
    },
  };
}
