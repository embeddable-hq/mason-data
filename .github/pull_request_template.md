<!-- Thanks. CONTRIBUTING.md has the detail; this is the short form. -->

**What changes, and why** (one paragraph; the measurement or the case, if there is one):

**The test that fails without it**: `scripts/fails-without.ts <base commit> <test file>` output, or why none is possible.

- [ ] `npm run check` is green
- [ ] `npm run test:integration` is green, where the change touches the copy, the stream, the listener or an answer
- [ ] generated text regenerated with `UPDATE_FIXTURE=1 npm test`, not edited (if it changed)
- [ ] an error a person meets says the way out
