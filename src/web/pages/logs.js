/**
 * THE LOGS PAGE (#logs): not built yet — docs/OBSERVABILITY.md "Pages" says what it shows and reads. A page
 * module (src/web/app.js has the contract): `page.create(ctx)` returns its reads, its view and its actions.
 */
import { placeholder } from "../shared.js";

export const page = {
  id: "logs",
  title: "Logs",
  create() {
    return {
      reads: () => [],
      actions: {},
      view: () => ({ logs: placeholder("The sync's events and the run's log", "mason logs --events") }),
    };
  },
};
