/**
 * THE QUERIES PAGE (#queries): not built yet — docs/OBSERVABILITY.md "Pages" says what it shows and reads. A page
 * module (src/web/app.js has the contract): `page.create(ctx)` returns its reads, its view and its actions.
 */
import { placeholder } from "../shared.js";

export const page = {
  id: "queries",
  title: "Queries",
  create() {
    return {
      reads: () => [],
      actions: {},
      view: () => ({ queries: placeholder("The statements running now and the request log", "mason logs --requests") }),
    };
  },
};
