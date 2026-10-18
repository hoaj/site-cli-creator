// Fake data and the GraphQL schema of the fixture "shop account" site.
// Every name, number and id here is invented.

import { GraphQLFailure, type Schema } from "./graphql";

export type Subscription = {
  id: string;
  name: string;
  status: "active" | "terminated" | "pending";
  startDate: string | null;
  price: number | null;
  currency: string;
  features: { code: string; label: string }[];
};

export type Invoice = {
  id: string;
  number: string;
  issuedAt: string;
  dueDate: string | null;
  amountDKK: number;
  status: "paid" | "open";
  pdfUrl: string | null;
  lines: { text: string; amountDKK: number; period: { from: string; to: string } | null }[];
};

export type Note = { id: string; text: string; createdAt: string };

/** The one test user. `username`/`password` are what /login accepts. */
export const USER = {
  username: "test",
  password: "test",
  accountRef: "acc_7f3a91",
  personRef: "per_19c2e4",
  customerId: "C-48213307",
  cpr: "0101901234",
  email: "test.testesen@example.dk",
};

export const ACCOUNT = {
  id: "A-55102",
  customerId: USER.customerId,
  name: "Test Testesen",
  email: USER.email as string | null,
  phone: null as string | null,
  createdAt: "2019-04-02T09:15:00Z",
};

export const SUBSCRIPTIONS: Subscription[] = [
  {
    id: "S-1001",
    name: "Bredbånd 1000/1000",
    status: "active",
    startDate: "2024-03-01",
    price: 399,
    currency: "DKK",
    features: [
      { code: "wifi6", label: "WiFi 6 router" },
      { code: "static-ip", label: "Fast IP-adresse" },
    ],
  },
  { id: "S-1002", name: "TV Mellempakke", status: "active", startDate: "2023-11-15", price: 329.5, currency: "DKK", features: [] },
  { id: "S-1003", name: "Streaming-tillæg", status: "active", startDate: null, price: null, currency: "DKK", features: [] },
  {
    id: "S-0904",
    name: "Mobil 20 GB",
    status: "terminated",
    startDate: "2021-06-01",
    price: 129,
    currency: "DKK",
    features: [{ code: "eu-roaming", label: "Roaming i EU" }],
  },
];

export const INVOICES: Invoice[] = [
  {
    id: "INV-2024-0311",
    number: "88120311",
    issuedAt: "2024-10-01",
    dueDate: "2024-10-15",
    amountDKK: 728.5,
    status: "open",
    pdfUrl: null,
    lines: [
      { text: "Bredbånd 1000/1000", amountDKK: 399, period: { from: "2024-10-01", to: "2024-10-31" } },
      { text: "TV Mellempakke", amountDKK: 329.5, period: { from: "2024-10-01", to: "2024-10-31" } },
    ],
  },
  {
    id: "INV-2024-0287",
    number: "88110287",
    issuedAt: "2024-09-01",
    dueDate: null,
    amountDKK: 857.5,
    status: "paid",
    pdfUrl: "/api/invoices/INV-2024-0287/pdf",
    lines: [
      { text: "Bredbånd 1000/1000", amountDKK: 399, period: { from: "2024-09-01", to: "2024-09-30" } },
      { text: "TV Mellempakke", amountDKK: 329.5, period: { from: "2024-09-01", to: "2024-09-30" } },
      { text: "Gebyr for papirfaktura", amountDKK: 129, period: null },
    ],
  },
];

export type Store = { notes: Note[] };

export function newStore(): Store {
  return { notes: [{ id: "N-1", text: "Kunden ønsker opkald efter kl. 16", createdAt: "2024-08-20T12:00:00Z" }] };
}

/** What a resolver knows about the caller: the logged-in customer, or none for `auth: "none"`. */
export type GraphQLContext = { store: Store; customerId: string | null };

/**
 * Builds the schema. `withoutPrice` models the "graphql-validation" drift (the field was
 * removed); `noteArg` is the name addNote takes the note under ("body" in the "write-shape" drift).
 */
export function buildSchema(opts: { withoutPrice: boolean; noteArg: "text" | "body" }): Schema<GraphQLContext> {
  const subscription: Schema<GraphQLContext>["types"][string] = {
    id: { type: "ID" },
    name: { type: "String" },
    status: { type: "String" },
    startDate: { type: "String" },
    price: { type: "Float" },
    currency: { type: "String" },
    features: { type: "Feature" },
  };
  if (opts.withoutPrice) delete subscription.price;

  const requireAccount = (accountId: unknown) => {
    if (accountId !== ACCOUNT.id) throw new GraphQLFailure("Account not found.", "NOT_FOUND");
  };

  return {
    query: "Query",
    mutation: "Mutation",
    types: {
      Query: {
        getAccount: {
          type: "Account",
          args: { customerId: "ID" },
          resolve: (_p, args, ctx) => {
            // Logged-in callers must name their own customer; the public mode serves the demo account.
            if (ctx.customerId !== null && args.customerId !== ctx.customerId)
              throw new GraphQLFailure("Customer does not belong to this session.", "FORBIDDEN");
            return ACCOUNT;
          },
        },
        listSubscriptions: {
          type: "Subscription",
          args: { accountId: "ID!" },
          resolve: (_p, args) => {
            requireAccount(args.accountId);
            return SUBSCRIPTIONS;
          },
        },
      },
      Mutation: {
        addNote: {
          type: "Note",
          args: { accountId: "ID!", [opts.noteArg]: "String!" },
          resolve: (_p, args, ctx) => {
            requireAccount(args.accountId);
            const raw = args[opts.noteArg];
            const text = typeof raw === "string" ? raw.trim() : "";
            if (!text || text.length > 500) throw new GraphQLFailure("Note text must be 1-500 characters.", "BAD_USER_INPUT");
            const note = { id: `N-${ctx.store.notes.length + 1}`, text, createdAt: new Date().toISOString() };
            ctx.store.notes.push(note);
            return note;
          },
        },
      },
      Account: {
        id: { type: "ID" },
        customerId: { type: "ID" },
        name: { type: "String" },
        email: { type: "String" },
        phone: { type: "String" },
        createdAt: { type: "String" },
        notes: { type: "Note", resolve: (_p, _a, ctx) => ctx.store.notes },
      },
      Subscription: subscription,
      Feature: { code: { type: "String" }, label: { type: "String" } },
      Note: { id: { type: "ID" }, text: { type: "String" }, createdAt: { type: "String" } },
    },
  };
}
