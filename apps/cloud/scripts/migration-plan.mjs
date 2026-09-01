export function validateMigrationPlan(migrationFiles, appliedMigrations) {
  const localNames = new Set(migrationFiles);
  const appliedNames = appliedMigrations.map(({ name }) => name).sort();

  for (const name of appliedNames) {
    if (!localNames.has(name)) {
      throw new Error(
        `Database migration ${name} is not present in this checkout`,
      );
    }
  }

  const maximumApplied = appliedNames.at(-1);
  if (maximumApplied) {
    const outOfOrderPending = migrationFiles.find(
      (name) => !appliedNames.includes(name) && name < maximumApplied,
    );
    if (outOfOrderPending) {
      throw new Error(
        `Pending migration ${outOfOrderPending} sorts before applied migration ${maximumApplied}`,
      );
    }
  }
}
