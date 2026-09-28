// PROTOTYPE ONLY — fake site responses so the envelope can be seen offline.
import type { Operation } from "./operation";

const data: Record<string, unknown> = {
  getCustomer: { data: { getCustomer: { id: "C-1", name: "Test Kunde", customerType: "residential" } } },
  listFtpdProducts: { data: { listFtpdProducts: [
    { id: "P-1", name: "Bredbånd 1000/1000", status: "active", startDate: "2024-03-01",
      productPrice: [{ priceType: "recurring", price: { valueIncludingTaxRounded: 399 } }] },
    { id: "P-2", name: "TV Mellem", status: "active", startDate: "2023-11-15",
      productPrice: [{ priceType: "recurring", price: { valueIncludingTaxRounded: 329 } }] },
  ] } },
};

export function fake(op: Operation, scenario: string) {
  if (scenario === "session") return { status: 401, body: null };
  if (scenario === "network") return { status: 503, body: null };
  if (scenario === "gqlerror" && op.name === "listFtpdProducts")
    return { status: 200, body: { errors: [{ message: 'Cannot query field "productPrice" on type "Product".', extensions: { code: "GRAPHQL_VALIDATION_FAILED" }, path: ["listFtpdProducts"] }] } };
  if (scenario === "drift" && op.name === "listFtpdProducts") {
    const d = structuredClone(data.listFtpdProducts) as any;
    d.data.listFtpdProducts[0].status = { code: "ACTIVE" }; // site changed status to an object
    return { status: 200, body: d };
  }
  return { status: 200, body: data[op.name] ?? { data: {} } };
}
