import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  OWNERSHIP_DECLARATION_CONTEXT_SQL,
  ownershipDeclarationContextBinds,
  ownershipDeclarationBlockers,
  type OwnershipDeclarationContext,
} from "../src/ownership-declaration.ts";

test("self-declaration refuses all recorded ownership history and direct contrary evidence only", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE entity_relations(kind TEXT,from_ref TEXT,to_ref TEXT,status TEXT)");
  db.exec(`CREATE TABLE accounts(id TEXT,role TEXT,status TEXT);
  CREATE TABLE current_account_mappings(account_id TEXT,source_account_id TEXT,status TEXT);
  INSERT INTO accounts VALUES('card','card-statement','provider-local');
  INSERT INTO current_account_mappings VALUES('card','sa','provider-local');`);
  const refs = ["card-settlement:one", "balance:11", "parse_run:1", "account_mapping:map"];
  const binds = ownershipDeclarationContextBinds("card", "sa", refs, "liable_party");
  const context = () =>
    db.query(OWNERSHIP_DECLARATION_CONTEXT_SQL).get(...binds) as OwnershipDeclarationContext;
  const add = (kind: string, from: string, to: string, status = "accepted") =>
    db.query("INSERT INTO entity_relations VALUES(?,?,?,?)").run(kind, from, to, status);
  expect(ownershipDeclarationBlockers(context())).toEqual([]);
  db.exec("UPDATE accounts SET status='aggregate'");
  expect(ownershipDeclarationBlockers(context())).toEqual(["single_account_scope_unconfirmed"]);
  db.exec("UPDATE accounts SET status='provider-local'");
  add("liable_party", "unrelated", "party:other");
  add("same_account", "card", "unrelated");
  add("contradicts", "unrelated", "balance:99");
  expect(ownershipDeclarationBlockers(context())).toEqual([]);
  for (const role of ["liable_party", "beneficial_owner"]) {
    for (const account of ["card", "account:card"]) {
      add(role, account, "party:other", "rejected");
      expect(ownershipDeclarationBlockers(context())).toEqual(["ownership_claims_require_review"]);
    }
  }
  expect(context().ownership_claims).toBe(4);
  for (const ref of ["card", "account:card", "source_account:sa", ...refs]) {
    for (const reverse of [false, true]) {
      add("contradicts", reverse ? "unrelated" : ref, reverse ? ref : "unrelated", "rejected");
    }
  }
  expect(context().contrary_claims).toBe(14);
  expect(ownershipDeclarationBlockers(context())).toEqual([
    "ownership_claims_require_review",
    "contrary_evidence_recorded",
  ]);
});
