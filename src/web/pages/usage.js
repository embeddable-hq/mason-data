/**
 * THE USAGE PAGE (#usage): not built yet — docs/OBSERVABILITY.md "Pages" says what it shows and reads. A page
 * module (src/web/app.js has the contract): `page.create(ctx)` returns its reads, its view and its actions.
 */
import { placeholder } from "../shared.js";

export const page = {
  id: "usage",
  title: "Usage",
  create() {
    return {
      reads: () => [],
      actions: {},
      view: () => ({ usage: placeholder("The statements, the copy's size and its use over time", "mason usage") }),
    };
  },
};
