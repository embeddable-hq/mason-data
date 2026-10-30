<!-- Thanks. CONTRIBUTING.md has the detail; this is the short form. -->

**What changes, and why** (one paragraph; the measurement or the case, if there is one):

**The test that fails without it**: `scripts/fails-without.ts <base commit> <test file>` output, run once on the final tree, or why none is possible.

- [ ] CI is green on the last commit
- [ ] generated text regenerated with `UPDATE_FIXTURE=1 npm test`, not edited (if it changed)
- [ ] an error a person meets says the way out
