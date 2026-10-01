import type { Mailer } from "./email";
import type { Telephony } from "./telephony";

/** Everything with a side effect outside the database, injectable for tests. */
export interface Deps {
  telephony: Telephony;
  mailer: Mailer | null;
  now: () => Date;
}
