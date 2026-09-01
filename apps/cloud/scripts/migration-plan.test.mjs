import { describe, expect, it } from "vitest";

import { validateMigrationPlan } from "./migration-plan.mjs";

const files = ["0000_foundation.sql", "0001_auth.sql", "0002_commands.sql"];

describe("migration plan", () => {
  it("accepts an applied prefix", () => {
    expect(() =>
      validateMigrationPlan(files, [
        { name: "0000_foundation.sql", sha256: "a" },
        { name: "0001_auth.sql", sha256: "b" },
      ]),
    ).not.toThrow();
  });

  it("accepts an additive repair that sorts after an applied migration", () => {
    const repairFiles = [
      "0008_connector_pairing.sql",
      "0008a_security_definer_acl.sql",
      "0009_publication.sql",
    ];
    expect(() =>
      validateMigrationPlan(repairFiles, [
        { name: "0008_connector_pairing.sql", sha256: "a" },
      ]),
    ).not.toThrow();
  });

  it("rejects a pending migration that sorts before an applied migration", () => {
    expect(() =>
      validateMigrationPlan(files, [
        { name: "0000_foundation.sql", sha256: "a" },
        { name: "0002_commands.sql", sha256: "c" },
      ]),
    ).toThrow(
      "Pending migration 0001_auth.sql sorts before applied migration 0002_commands.sql",
    );
  });

  it("rejects a database migration missing from the checkout", () => {
    expect(() =>
      validateMigrationPlan(files, [{ name: "0003_future.sql", sha256: "d" }]),
    ).toThrow("Database migration 0003_future.sql is not present");
  });
});
