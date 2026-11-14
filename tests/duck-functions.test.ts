/**
 * The functions the DuckDB endpoint computes in JavaScript where DuckDB's answer differs from Postgres's
 * (src/duck/functions.ts, src/duck/to-char.ts, the rewrite's SIMILAR TO): each answer here is Postgres 18's own, read from
 * it (tests/integration/duck-oracle.itest.ts and duck-to-char.itest.ts hold every one to a live Postgres; this file pins
 * them offline).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { arrayText, floatNumericText, initcap, jsonArrayLength, jsonBuild, jsonbContains, jsonbExists, jsonElements, jsonGet, jsonMembers, jsonValue, pgCase, stringToArray } from "../src/duck/functions.ts";
import { strftimeTemplate, toCharNumber, toCharTime } from "../src/duck/to-char.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import { caseMappingOf, type CaseMapping } from "../src/duck/collation.ts";
import { giveTurns, masonCalls, similarToRe2 } from "../src/duck/rewrite.ts";
import { parseSql, stopParser } from "../src/api/postgres/parser.ts";
import { deparseSync } from "pgsql-deparser";
import { padDecimals } from "../src/duck/types.ts";

test("json reads: json keeps the document's text, jsonb writes it canonically; a duplicate key reads its last value", () => {
  assert.equal(jsonGet('{"a":1,"a":2}', [{ key: "a" }], false, false), "2");
  assert.equal(jsonGet('{"a": [1,  2]}', [{ key: "a" }], false, false), "[1,  2]");
  assert.equal(jsonGet('{"a": [1,  2]}', [{ key: "a" }], true, false), "[1, 2]");
  // a number's digits as written (DuckDB's json_extract answers 7.0)
  assert.equal(jsonGet('{"n": 7.00}', [{ key: "n" }], true, true), "7.00");
  assert.equal(jsonGet('{"n": 1e2}', [{ key: "n" }], true, true), "100");
  assert.equal(jsonGet('{"n": 1e2}', [{ key: "n" }], false, true), "1e2");
  // ->> of a text key on an array is NULL; a #> path element indexes an array, from the end when negative
  assert.equal(jsonGet("[1,2]", [{ key: "0" }], false, true), null);
  assert.equal(jsonGet("[1,2]", [{ either: "-1" }], true, true), "2");
  assert.equal(jsonGet('{"s": "x\\"y"}', [{ key: "s" }], true, true), 'x"y');
  assert.equal(jsonGet('{"s": null}', [{ key: "s" }], true, true), null);
  assert.equal(jsonGet('{"s": null}', [{ key: "s" }], true, false), "null");
  assert.deepEqual(jsonElements('[7.00, "a", null, {"b":1}]', true, true), ["7.00", "a", null, '{"b": 1}']);
  assert.deepEqual(jsonMembers('{"bb": 1, "a": [2]}', true, false), [["a", "[2]"], ["bb", "1"]]);
  assert.throws(() => jsonElements('{"a":1}', true, false), /cannot extract elements from an object/);
});

test("json writes: json_build_object's spacing, a timestamp in ISO 8601, NULL as null", () => {
  assert.equal(jsonBuild("o:sssr", ["s", "paid", "a", "0.01"]), '{"s" : "paid", "a" : 0.01}');
  assert.equal(jsonBuild("a:rs", ["1", "a"]), '[1, "a"]');
  assert.equal(jsonBuild("v:r", [null]), null);
  assert.equal(jsonBuild("a:nn", ["NaN", "1.5"]), '["NaN", 1.5]');
  assert.equal(jsonValue("z", "2026-10-23 23:05:21+00"), '"2026-10-23T23:05:21+00:00"');
  assert.equal(jsonValue("z", "2026-01-01 11:00:00.5+05:30"), '"2026-01-01T11:00:00.5+05:30"');
  assert.equal(jsonValue("t", "2026-01-01 11:00:00"), '"2026-01-01T11:00:00"');
  assert.equal(jsonValue("k", '{"b":1,  "a":2}'), '{"a": 2, "b": 1}');
  assert.throws(() => jsonBuild("o:ss", [null, "x"]), /key must not be null/);
});

/**
 * UPPER, LOWER AND INITCAP UNDER EACH CASE MAPPING (issue 406), as Postgres 18 answered them under the collation named
 * (postgres:18, glibc 2.41's en_US.utf8 and C.utf8, ICU 76, its builtin pg_c_utf8 and pg_unicode_fast): each row the
 * input, then upper, lower and initcap. The same strings, over every code point of the BMP and the SMP but the CJK and
 * Hangul blocks, differed only in letters added in Unicode 17 (Mason gap unicode-16-case).
 */
const POSTGRES_18_CASE: Record<string, { mapping: CaseMapping; rows: Array<[string, string, string, string]> }> = {
  "C": { mapping: "ascii", rows: [
    ["straße", "STRAßE", "straße", "StraßE"],
    ["İstanbul", "İSTANBUL", "İstanbul", "İStanbul"],
    ["ıi Iİ", "ıI Iİ", "ıi iİ", "ıI Iİ"],
    ["ǅemal ǆ Ǆ", "ǅEMAL ǆ Ǆ", "ǅemal ǆ Ǆ", "ǅEmal ǆ Ǆ"],
    ["o'hara", "O'HARA", "o'hara", "O'Hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'Neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ σοφός", "ΟΔΟΣ σοφός", "ΟΔΟΣ σοφός"],
    ["ﬁne ŉ", "ﬁNE ŉ", "ﬁne ŉ", "ﬁNe ŉ"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.World A_B X2y 1st"],
    ["élan ÉCOLE", "éLAN ÉCOLE", "élan École", "éLan ÉCole"],
    ["", "", "", ""],
    ["ǉubljana", "ǉUBLJANA", "ǉubljana", "ǉUbljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "ǈ ǋ ǲ", "ǈ ǋ ǲ", "ǈ ǋ ǲ"],
    ["ßtraße", "ßTRAßE", "ßtraße", "ßTraßE"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ΑΣ b", "ΑΣ B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can'T Won’T"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.B.C 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ ⅻ ⓐⓑ", "Ⅻ ⅻ ⓐⓑ", "Ⅻ ⅻ ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "ǰA ﬀO ᾳB", "ǰa ﬀo ᾳb", "ǰA ﬀO ᾳB"],
    ["ⴀa ა ᲐᲑ", "ⴀA ა ᲐᲑ", "ⴀa ა ᲐᲑ", "ⴀA ა ᲐᲑ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307Stanbul I\u0307X"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "en_US": { mapping: "libc", rows: [
    ["straße", "STRAßE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "istanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii", "Ii Ii"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "Ǆemal Ǆ Ǆ"],
    ["o'hara", "O'HARA", "o'hara", "O'Hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'Neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδοσ σοφός", "Οδοσ Σοφός"],
    ["ﬁne ŉ", "ﬁNE ŉ", "ﬁne ŉ", "ﬁne ŉ"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.World A_B X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "Ǉubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "Ǉ Ǌ Ǳ"],
    ["ßtraße", "ßTRAßE", "ßtraße", "ßtraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ασ b", "Ασ B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can'T Won’T"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.B.C 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "ǰA ﬀO ᾼB", "ǰa ﬀo ᾳb", "ǰa ﬀo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa Ა Აბ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307Stanbul I\u0307X"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σασ", "Σασ.Σασ"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "C.utf8": { mapping: "libc", rows: [
    ["straße", "STRAßE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "istanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii", "Ii Ii"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "Ǆemal Ǆ Ǆ"],
    ["o'hara", "O'HARA", "o'hara", "O'Hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'Neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδοσ σοφός", "Οδοσ Σοφός"],
    ["ﬁne ŉ", "ﬁNE ŉ", "ﬁne ŉ", "ﬁne ŉ"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.World A_B X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "Ǉubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "Ǉ Ǌ Ǳ"],
    ["ßtraße", "ßTRAßE", "ßtraße", "ßtraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ασ b", "Ασ B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can'T Won’T"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.B.C 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "ǰA ﬀO ᾼB", "ǰa ﬀo ᾳb", "ǰa ﬀo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa Ა Აბ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307Stanbul I\u0307X"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σασ", "Σασ.Σασ"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "pg_c_utf8": { mapping: "simple", rows: [
    ["straße", "STRAßE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "istanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii", "Ii Ii"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "Ǆemal Ǆ Ǆ"],
    ["o'hara", "O'HARA", "o'hara", "O'Hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'Neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδοσ σοφός", "Οδοσ Σοφός"],
    ["ﬁne ŉ", "ﬁNE ŉ", "ﬁne ŉ", "ﬁne ŉ"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.World A_B X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "Ǉubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "Ǉ Ǌ Ǳ"],
    ["ßtraße", "ßTRAßE", "ßtraße", "ßtraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ασ b", "Ασ B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can'T Won’T"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.B.C 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "ǰA ﬀO ᾼB", "ǰa ﬀo ᾳb", "ǰa ﬀo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa Ა Აბ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307Stanbul I\u0307X"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σασ", "Σασ.Σασ"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "pg_unicode_fast": { mapping: "full", rows: [
    ["straße", "STRASSE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "i\u0307stanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii\u0307", "Ii Ii\u0307"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "ǅemal ǅ ǅ"],
    ["o'hara", "O'HARA", "o'hara", "O'Hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'Neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδος σοφός", "Οδος Σοφός"],
    ["ﬁne ŉ", "FINE ʼN", "ﬁne ŉ", "Fine ʼN"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.World A_B X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "ǈubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "ǈ ǋ ǲ"],
    ["ßtraße", "SSTRASSE", "ßtraße", "Sstraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ας b", "Ας B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can'T Won’T"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.B.C 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "J\u030cA FFO ΑΙB", "ǰa ﬀo ᾳb", "J\u030ca Ffo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa ა Აბ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307Stanbul I\u0307X"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σας", "Σασ.Σας"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "und-x-icu": { mapping: "icu:und", rows: [
    ["straße", "STRASSE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "i\u0307stanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii\u0307", "Ii Ii\u0307"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "ǅemal ǅ ǅ"],
    ["o'hara", "O'HARA", "o'hara", "O'hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδος σοφός", "Οδος Σοφός"],
    ["ﬁne ŉ", "FINE ʼN", "ﬁne ŉ", "Fine ʼN"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.world A_b X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "ǈubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "ǈ ǋ ǲ"],
    ["ßtraße", "SSTRASSE", "ßtraße", "Sstraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ας b", "Ας B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can't Won’t"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.b.c 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "J\u030cA FFO ΑΙB", "ǰa ﬀo ᾳb", "J\u030ca Ffo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa ა Აბ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307stanbul I\u0307x"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σας", "Σασ.σας"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "tr-x-icu": { mapping: "icu:tr", rows: [
    ["straße", "STRASSE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "istanbul", "İstanbul"],
    ["ıi Iİ", "Iİ Iİ", "ıi ıi", "Ii Ii"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "ǅemal ǅ ǅ"],
    ["o'hara", "O'HARA", "o'hara", "O'hara"],
    ["o'neil mcDONALD-smith", "O'NEİL MCDONALD-SMİTH", "o'neil mcdonald-smith", "O'neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδος σοφός", "Οδος Σοφός"],
    ["ﬁne ŉ", "FINE ʼN", "ﬁne ŉ", "Fine ʼN"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.world A_b X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "ǈubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "ǈ ǋ ǲ"],
    ["ßtraße", "SSTRASSE", "ßtraße", "Sstraße"],
    ["ijs ijsland IJmuiden", "İJS İJSLAND IJMUİDEN", "ijs ijsland ıjmuiden", "İjs İjsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ας b", "Ας B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can't Won’t"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.b.c 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "J\u030cA FFO ΑΙB", "ǰa ﬀo ᾳb", "J\u030ca Ffo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa ა Აბ"],
    ["i\u0307stanbul I\u0307x", "İ\u0307STANBUL I\u0307X", "i\u0307stanbul ix", "İ\u0307stanbul Ix"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σας", "Σασ.σας"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "nl-x-icu": { mapping: "icu:nl", rows: [
    ["straße", "STRASSE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "i\u0307stanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii\u0307", "Ii Ii\u0307"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "ǅemal ǅ ǅ"],
    ["o'hara", "O'HARA", "o'hara", "O'hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδος σοφός", "Οδος Σοφός"],
    ["ﬁne ŉ", "FINE ʼN", "ﬁne ŉ", "Fine ʼN"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.world A_b X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "ǈubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "ǈ ǋ ǲ"],
    ["ßtraße", "SSTRASSE", "ßtraße", "Sstraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "IJs IJsland IJmuiden"],
    ["ΑΣ b", "ΑΣ B", "ας b", "Ας B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can't Won’t"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.b.c 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "J\u030cA FFO ΑΙB", "ǰa ﬀo ᾳb", "J\u030ca Ffo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa ა Აბ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307stanbul I\u0307x"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σας", "Σασ.σας"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "lt-x-icu": { mapping: "icu:lt", rows: [
    ["straße", "STRASSE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "i\u0307stanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii\u0307", "Ii Ii\u0307"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "ǅemal ǅ ǅ"],
    ["o'hara", "O'HARA", "o'hara", "O'hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΌΣ", "οδος σοφός", "Οδος Σοφός"],
    ["ﬁne ŉ", "FINE ʼN", "ﬁne ŉ", "Fine ʼN"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.world A_b X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "ǈubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "ǈ ǋ ǲ"],
    ["ßtraße", "SSTRASSE", "ßtraße", "Sstraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ας b", "Ας B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can't Won’t"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.b.c 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "J\u030cA FFO ΑΙB", "ǰa ﬀo ᾳb", "J\u030ca Ffo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa ა Აბ"],
    ["i\u0307stanbul I\u0307x", "ISTANBUL I\u0307X", "i\u0307stanbul i\u0307\u0307x", "I\u0307stanbul I\u0307x"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σας", "Σασ.σας"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
  "el-x-icu": { mapping: "icu:el", rows: [
    ["straße", "STRASSE", "straße", "Straße"],
    ["İstanbul", "İSTANBUL", "i\u0307stanbul", "İstanbul"],
    ["ıi Iİ", "II Iİ", "ıi ii\u0307", "Ii Ii\u0307"],
    ["ǅemal ǆ Ǆ", "ǄEMAL Ǆ Ǆ", "ǆemal ǆ ǆ", "ǅemal ǅ ǅ"],
    ["o'hara", "O'HARA", "o'hara", "O'hara"],
    ["o'neil mcDONALD-smith", "O'NEIL MCDONALD-SMITH", "o'neil mcdonald-smith", "O'neil Mcdonald-Smith"],
    ["ΟΔΟΣ σοφός", "ΟΔΟΣ ΣΟΦΟΣ", "οδος σοφός", "Οδος Σοφός"],
    ["ﬁne ŉ", "FINE ʼN", "ﬁne ŉ", "Fine ʼN"],
    ["hello.world a_b x2y 1st", "HELLO.WORLD A_B X2Y 1ST", "hello.world a_b x2y 1st", "Hello.world A_b X2y 1st"],
    ["élan ÉCOLE", "ÉLAN ÉCOLE", "élan école", "Élan École"],
    ["", "", "", ""],
    ["ǉubljana", "ǇUBLJANA", "ǉubljana", "ǈubljana"],
    ["'quoted' (paren) -dash", "'QUOTED' (PAREN) -DASH", "'quoted' (paren) -dash", "'Quoted' (Paren) -Dash"],
    ["ǈ ǋ ǲ", "Ǉ Ǌ Ǳ", "ǉ ǌ ǳ", "ǈ ǋ ǲ"],
    ["ßtraße", "SSTRASSE", "ßtraße", "Sstraße"],
    ["ijs ijsland IJmuiden", "IJS IJSLAND IJMUIDEN", "ijs ijsland ijmuiden", "Ijs Ijsland Ijmuiden"],
    ["ΑΣ b", "ΑΣ B", "ας b", "Ας B"],
    ["can't won’t", "CAN'T WON’T", "can't won’t", "Can't Won’t"],
    ["a.b.c 1.5 x:y", "A.B.C 1.5 X:Y", "a.b.c 1.5 x:y", "A.b.c 1.5 X:Y"],
    ["Ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ ⒶⒷ", "ⅻ ⅻ ⓐⓑ", "Ⅻ Ⅻ Ⓐⓑ"],
    ["ǰa ﬀo ᾳb", "J\u030cA FFO ΑΙB", "ǰa ﬀo ᾳb", "J\u030ca Ffo ᾼb"],
    ["ⴀa ა ᲐᲑ", "ႠA Ა ᲐᲑ", "ⴀa ა აბ", "Ⴀa ა Აბ"],
    ["i\u0307stanbul I\u0307x", "I\u0307STANBUL I\u0307X", "i\u0307stanbul i\u0307x", "I\u0307stanbul I\u0307x"],
    ["ΣΑΣ.ΣΑΣ", "ΣΑΣ.ΣΑΣ", "σασ.σας", "Σασ.σας"],
    ["²ab", "²AB", "²ab", "²Ab"],
  ] },
};

test("case: upper, lower and initcap are Postgres 18's under each case mapping, the input collation's (issue 406)", () => {
  for (const [collation, { mapping, rows }] of Object.entries(POSTGRES_18_CASE)) {
    for (const [s, upper, lower, title] of rows) {
      assert.equal(pgCase(s, true, mapping), upper, `upper(${JSON.stringify(s)} COLLATE "${collation}")`);
      assert.equal(pgCase(s, false, mapping), lower, `lower(${JSON.stringify(s)} COLLATE "${collation}")`);
      assert.equal(initcap(s, mapping), title, `initcap(${JSON.stringify(s)} COLLATE "${collation}")`);
    }
  }
});

test("case: ICU's per language casing and word break, as Postgres 18 answered them (Swedish's colon, POSIX's full stop, Armenian's ligature, Dutch's IJ)", () => {
  assert.equal(initcap("o'hara x:y a.b", "icu:sv"), "O'hara X:y A.b");
  assert.equal(initcap("o'hara x:y a.b", "icu:fi-FI"), "O'hara X:y A.b");
  assert.equal(initcap("o'hara x:y a.b", "icu:en-US-u-va-posix"), "O'hara X:Y A.B");
  assert.equal(initcap("o'hara x:y a.b", "icu:und"), "O'hara X:Y A.b");
  assert.equal(pgCase("և ﬓ", true, "icu:hy-AM"), "ԵՎ ՄՆ");
  assert.equal(initcap("և ﬓ", "icu:hy"), "Եվ Մն");
  assert.equal(initcap("ijs IJS ĳs Íjs ÍJ́s", "icu:nl-BE"), "IJs IJs Ĳs Íjs ÍJ́s");
  assert.equal(pgCase("istanbul ISTANBUL İı", true, "icu:az-Cyrl-AZ"), "İSTANBUL ISTANBUL İI");
  assert.equal(pgCase("istanbul ISTANBUL İı", false, "icu:tr"), "istanbul ıstanbul iı");
  assert.equal(pgCase("ΐ Ά ΆΣ όλα ΌΛΑ άι", true, "icu:el-CY"), "Ϊ Α ΑΣ ΟΛΑ ΟΛΑ ΑΪ");
  assert.equal(pgCase("i̇̀ Ì Í Ĩ Į J ìi̇", false, "icu:lt-LT"), "i̇̀ i̇̀ i̇́ i̇̃ į j ìi̇");
});

test("case: a collation's case mapping is its CTYPE's, never its order's (issue 406)", () => {
  assert.equal(caseMappingOf("c", "en_US.UTF-8", null), "libc");
  assert.equal(caseMappingOf("c", "C", null), "ascii");
  assert.equal(caseMappingOf("c", "POSIX", null), "ascii");
  // glibc's C.UTF-8 maps every letter, as en_US does (Postgres's lc_ctype_is_c is C and POSIX alone)
  assert.equal(caseMappingOf("c", "C.utf8", null), "libc");
  assert.equal(caseMappingOf("c", "tr_TR.UTF-8", null), null);
  assert.equal(caseMappingOf("c", "az_AZ", null), null);
  assert.equal(caseMappingOf("b", null, "C"), "ascii");
  assert.equal(caseMappingOf("b", null, "C.UTF-8"), "simple");
  assert.equal(caseMappingOf("b", null, "PG_UNICODE_FAST"), "full");
  assert.equal(caseMappingOf("b", null, "SOMETHING"), null);
  assert.equal(caseMappingOf("i", null, "und"), "icu:und");
  assert.equal(caseMappingOf("i", null, "und-u-kn"), "icu:und-u-kn");
  assert.equal(caseMappingOf("i", null, "tr-TR"), "icu:tr-TR");
  assert.equal(caseMappingOf("i", "de_AT", "de_AT@collation=phonebook"), "icu:de-AT");
  assert.equal(caseMappingOf("i", null, "root"), "icu:und");
  assert.equal(pgCase("ß", true, caseMappingOf("i", null, "und-u-kn")!), "SS");
});

test("an array's text is array_out's: NULL's word, an element quoted where it must be", () => {
  assert.equal(arrayText(["a", null, "b c", "", 'x"y', "NULL", "a\\b"], false), '{a,NULL,"b c","","x\\"y","NULL","a\\\\b"}');
  assert.equal(arrayText(["true", "false", null], true), "{t,f,NULL}");
  assert.equal(arrayText([], false), "{}");
});

test("SIMILAR TO's pattern as RE2's: % and _, the escape, . ^ $ themselves", () => {
  assert.equal(similarToRe2("c%@example.test", "\\"), "c.*@example\\.test");
  assert.equal(similarToRe2("a_b|(c)", "\\"), "a.b|(?:c)");
  assert.equal(similarToRe2("100#%", "#"), "100\\%");
  assert.equal(similarToRe2("[a-c]%", "\\"), "[a-c].*");
});

// issue 464: the strftime format a template is sent as (src/duck/rewrite.ts `toChar`) writes what the function writes,
// for every template strftime takes, over times at their edges (an ISO year that is not the calendar's, a leap day,
// midnight and noon, a fraction, a year under 1000 and the last day of 9999); every other template is the function's
test("issue 464: a to_char template DuckDB's strftime takes writes the function's text, and the rest are the function's", async () => {
  const times = ["2026-09-15 10:04:05", "2026-01-01 00:00:00", "2020-12-31 23:59:59.999999", "2021-01-03 08:30:00.5", "2024-02-29 13:07:09.012345",
    "2026-12-28 00:00:01", "0005-03-01 01:02:03.000001", "0999-12-31 23:59:59", "9999-12-28 12:00:00"];
  const taken = ["YYYY-MM", "YYYY-MM-DD", "Mon YYYY", "FMMonth YYYY", "Dy DD Mon", "FMDay, DDD", "FMMon/FMDy", "YYYY-MM-DD HH24:MI:SS", 'YYYY-MM-DD"T"HH24:MI:SS.US',
    "HH24:MI:SS.MS", "IYYY-IW", "YYYYMMDD", 'YYYY "100%" MM', "MM/DD/YYYY", "DD.MM.YYYY HH24:MI", '"week" IW "of" IYYY', "YYYY %m"];
  const refused = ['YYYY-"Q"Q', "Month YYYY", "Day", "FMDD", "DDth", "yyyy-mm", "MON YYYY", "mon", "TMMonth", "FXYYYY", "HH12:MI AM", "WW", "YYYY\\MM", 'YYYY"\\"MM',
    "IDDD", "J", "Y,YYY", "YY", "CC", "SSSS", "FF3", "RM", "D", "TZ", "OF", "FMYYYY"];
  for (const f of refused) assert.equal(strftimeTemplate(f, false), null, f);
  // a date's: no pattern of the time of day
  assert.equal(strftimeTemplate("YYYY-MM-DD HH24:MI", true), null);
  assert.equal(strftimeTemplate("YYYY-MM-DD", true), "%Y-%m-%d");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  try {
    for (const f of taken) {
      const spec = strftimeTemplate(f, false);
      assert.notEqual(spec, null, f);
      for (const t of times) {
        const got = (await c.runAndReadAll(`SELECT strftime(TIMESTAMP '${t}', '${spec!.replace(/'/g, "''")}')`)).getRows()[0]![0];
        assert.equal(got, toCharTime(t, f), `${f} of ${t}: strftime ${spec}`);
      }
    }
  } finally { c.closeSync(); db.closeSync(); }
});

test("to_char: Postgres's time patterns and number templates, read from Postgres 18", () => {
  assert.equal(toCharTime("2026-09-15 10:04:05", 'YYYY-"Q"Q'), "2026-Q3");
  assert.equal(toCharTime("2021-01-03 08:30:00", "IYYY-IW"), "2020-53");
  assert.equal(toCharTime("2026-09-15 10:04:05", "FMMonth YYYY"), "September 2026");
  assert.equal(toCharTime("2026-09-15 10:04:05", "Dy DD Mon"), "Tue 15 Sep");
  assert.equal(toCharTime("2026-09-15 10:04:05", "Month|"), "September|");
  assert.equal(toCharTime("2026-09-01 00:00:00", "FMDDth HH12:MI AM"), "1st 12:00 AM");
  assert.equal(toCharTime("infinity", "YYYY"), null);
  assert.equal(toCharNumber("89655199.68", "FM999,999,990.00"), "89,655,199.68");
  assert.equal(toCharNumber("0.5", "9.99"), "  .50");
  assert.equal(toCharNumber("-5", "9999PR"), "   <5>");
  assert.equal(toCharNumber("-0.5", "S9999"), "   -1");
  assert.equal(toCharNumber("12345", "999"), " ###");
  assert.equal(toCharNumber("0", "FM9.99"), "0.");
  assert.throws(() => toCharNumber("5", "9.99EEEE"), /EEEE is not supported/);
});

test("a numeric(p, s) column's text has s decimals, as Postgres writes it, whatever scale DuckDB stored", () => {
  assert.equal(padDecimals("19.99", 30), "19.990000000000000000000000000000");
  assert.equal(padDecimals("-5", 2), "-5.00");
  assert.equal(padDecimals("1.125", 2), "1.125");
  assert.equal(padDecimals("NaN", 2), "NaN");
  assert.equal(padDecimals("7", 0), "7");
});

test("a float cast to numeric writes Postgres's numeric: 15 digits (6 for a real), plainly, never a double's `.0`", () => {
  assert.deepEqual([25, -0, 20000001.279999997, 1e-7, 2e10, 1e20, NaN, -Infinity].map((x) => floatNumericText(x, false)),
    ["25", "0", "20000001.28", "0.0000001", "20000000000", "100000000000000000000", "NaN", "-Infinity"]);
  assert.deepEqual([0.1, 3.25, 123456789.123].map((x) => floatNumericText(x, true)), ["0.1", "3.25", "123457000"]);
});

test("jsonb's @> and ? as Postgres 18 answers them (DuckDB's json_contains / json_exists differ on arrays)", () => {
  // ? : an object's key, an array's string element, a string scalar itself
  assert.equal(jsonbExists('{"a": 1}', "a"), true);
  assert.equal(jsonbExists('["a", "b"]', "a"), true);
  assert.equal(jsonbExists('[1, ["a"]]', "a"), false);
  assert.equal(jsonbExists('"a"', "a"), true);
  assert.equal(jsonbExists('{"b": {"a": 1}}', "a"), false);
  // @> : nested arrays hold arrays, a top-level scalar is in an array, objects by key, numbers by value
  assert.equal(jsonbContains("[[1,2]]", "[1]"), false);
  assert.equal(jsonbContains("[[1,2]]", "[[1]]"), true);
  assert.equal(jsonbContains('["a", "b"]', '"a"'), true);
  assert.equal(jsonbContains('{"a": [1, 2]}', '{"a": 1}'), false);
  assert.equal(jsonbContains('{"a": [1, 2], "b": 3}', '{"a": [2]}'), true);
  assert.equal(jsonbContains('{"n": 1.50}', '{"n": 1.5}'), true);
  assert.equal(jsonbContains("[1, 2]", "[]"), true);
  assert.equal(jsonbContains('{"a": 1}', "[]"), false);
  assert.equal(jsonArrayLength("[1, [2, 3]]"), 2);
  assert.throws(() => jsonArrayLength('{"a": 1}'), /cannot get array length of a non-array/);
  assert.throws(() => jsonArrayLength("1"), /cannot get array length of a scalar/);
});

test("string_to_array as Postgres splits: '' is no element, a NULL delimiter splits characters, an empty one keeps it whole", () => {
  assert.deepEqual(stringToArray("", ",", null), []);
  assert.deepEqual(stringToArray("a,b,,c", ",", null), ["a", "b", "", "c"]);
  assert.deepEqual(stringToArray("abc", null, null), ["a", "b", "c"]);
  assert.deepEqual(stringToArray("abc", "", null), ["abc"]);
  assert.deepEqual(stringToArray("a,x,b", ",", "x"), ["a", null, "b"]);
});

// EVERY VECTOR PASSES THROUGH THE TURN (src/duck/rewrite.ts `giveTurns`; what it does is tests/duck-executor-starve.test.ts)
after(() => stopParser());
const S = "getvariable('__mason_session')";
const turned = async (select: string): Promise<string> => {
  const tree = (await parseSql(`SELECT ${select} FROM t`)).stmts?.[0]?.stmt;
  giveTurns(tree);
  return deparseSync(tree as never, { pretty: false }).replace(/^SELECT /, "").replace(/ FROM t$/, "");
};
test("the turn is taken by a call that reads a column, on its cheapest argument that may be repeated", async () => {
  assert.equal(await turned(`__mason_f(${S}, a, 'k')`), `__mason_f(__mason_turn(${S}, a), a, 'k')`);
  // the whole argument, or `f(a + b)` under GROUP BY a + b would not bind
  assert.equal(await turned(`__mason_f(${S}, a + b)`), `__mason_f(__mason_turn(${S}, a + b), a + b)`);
  assert.equal(await turned(`__mason_f(${S}, lower(a) || b, c)`), `__mason_f(__mason_turn(${S}, c), lower(a) || b, c)`);
  assert.equal(await turned(`__mason_f(${S}, sum(a))`), `__mason_f(__mason_turn(${S}, sum(a)), sum(a))`);
  // a parameter beside a column is typed by it (run prepared in tests/duck-wire.test.ts)
  assert.equal(await turned(`__mason_f(${S}, a = $1)`), `__mason_f(__mason_turn(${S}, a = $1), a = $1)`);
});
test("the turn is not taken over an argument that must not run twice, or by a call DuckDB folds", async () => {
  assert.equal(await turned(`__mason_f(${S}, 'k', 1)`), `__mason_f(${S}, 'k', 1)`);
  assert.equal(await turned(`__mason_f(${S}, $1)`), `__mason_f(${S}, $1)`);
  assert.equal(await turned(`__mason_f(${S}, (SELECT max(a) FROM u))`), `__mason_f(${S}, (SELECT max(a) FROM u))`);
  assert.equal(await turned(`__mason_f(${S}, sum(a) OVER ())`), `__mason_f(${S}, sum(a) OVER ())`);
  assert.equal(await turned(`__mason_f(${S}, unnest(a))`), `__mason_f(${S}, unnest(a))`);
  assert.equal(await turned(`__mason_f(${S}, t.*)`), `__mason_f(${S}, t.*)`);
  // a call of no session is no Mason function's call, and a function of Postgres's is left alone
  assert.equal(await turned("__mason_f(a), lower(a)"), "__mason_f(a), lower(a)");
});
test("a call over a Mason call relies on the turn of the call inside it, so nothing is computed twice", async () => {
  assert.equal(await turned(`__mason_f(${S}, __mason_g(${S}, a))`), `__mason_f(${S}, __mason_g(__mason_turn(${S}, a), a))`);
  // another argument of its own is a turn of its own, one hop more and no call more
  assert.equal(await turned(`__mason_f(${S}, __mason_g(${S}, a), b)`), `__mason_f(__mason_turn(${S}, b), __mason_g(__mason_turn(${S}, a), a), b)`);
});
test("the turn is no function a statement says it calls: a statement that calls none is not cancelled as if it did", async () => {
  const tree = (await parseSql(`SELECT __mason_turn(${S}, a), __mason_f(${S}, a) FROM t`)).stmts?.[0]?.stmt;
  assert.deepEqual(masonCalls(tree), ["__mason_f"]);
});
