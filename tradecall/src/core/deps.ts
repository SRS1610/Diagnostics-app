import type { Mailer } from "../lib/mail";
import type { Provider } from "../providers/types";

/** Everything with an outside-world side effect, injectable for tests. */
export interface Deps {
  provider: Provider;
  mailer: Mailer | null;
  now: () => Date;
}
