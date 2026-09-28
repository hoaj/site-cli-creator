// FIXED TEMPLATE FILE. PROTOTYPE — stubbed; the real one is tempo-log-hours' browser()
// with launchPersistentContext(~/.yousee/profile, { channel: "chrome" }), sniffing
// the bearer from site.tokenRequest and saving {bearer, cookie, customerId} 0600.
import { Failure, note } from "./result";

export type Session = { bearer: string; cookie: string; customerId: string };

export async function loadSession(): Promise<Session> {
  // real: read ~/.yousee/session.json; missing → refreshSession()
  return { bearer: "Bearer <cached>", cookie: "<cached>", customerId: "<from JWT claim>" };
}

export async function refreshSession(): Promise<Session> {
  // real: 1) headless profile → sniff token; 2) still logged out → headed login (10 min wait)
  if (process.env.PROTO_SCENARIO === "session") {
    note("would open Chrome for login here (headed, tool-owned profile)");
    throw new Failure("session", "Not logged in to Mit YouSee.");
  }
  return loadSession();
}

export async function login() {
  note("PROTOTYPE: would open Chrome at site.loginUrl with ~/.yousee/profile and wait for the bearer");
  return { loggedIn: true, stateDir: "~/.yousee" };
}
