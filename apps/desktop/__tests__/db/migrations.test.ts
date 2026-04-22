import { migrations } from "@/db/migrations";

describe("WatermelonDB Migrations", () => {
  it("is validated", () => {
    expect(migrations).toBeDefined();
    expect(migrations.validated).toBe(true);
  });

  it("has sortedMigrations array", () => {
    expect(migrations.sortedMigrations).toBeInstanceOf(Array);
    expect(migrations.sortedMigrations.length).toBeGreaterThan(0);
  });

  it("has migration to version 2", () => {
    const v2 = migrations.sortedMigrations.find((m) => m.toVersion === 2);
    expect(v2).toBeDefined();
    expect(v2!.steps).toBeInstanceOf(Array);
    expect(v2!.steps.length).toBeGreaterThan(0);
  });

  it("version 2 adds local_uri and upload_status columns to attachments", () => {
    const v2 = migrations.sortedMigrations.find((m) => m.toVersion === 2);
    expect(v2).toBeDefined();
    const step = v2!.steps[0] as { type: string; table: string; columns: { name: string }[] };
    expect(step.type).toBe("add_columns");
    expect(step.table).toBe("attachments");

    const columnNames = step.columns.map((c) => c.name);
    expect(columnNames).toContain("local_uri");
    expect(columnNames).toContain("upload_status");
  });

  it("has migration to version 3", () => {
    const v3 = migrations.sortedMigrations.find((m) => m.toVersion === 3);
    expect(v3).toBeDefined();
    expect(v3!.steps).toBeInstanceOf(Array);
    expect(v3!.steps.length).toBeGreaterThan(0);
  });

  it("version 3 adds upload_error column to attachments", () => {
    const v3 = migrations.sortedMigrations.find((m) => m.toVersion === 3);
    expect(v3).toBeDefined();
    const step = v3!.steps[0] as { type: string; table: string; columns: { name: string }[] };
    expect(step.type).toBe("add_columns");
    expect(step.table).toBe("attachments");

    const columnNames = step.columns.map((c) => c.name);
    expect(columnNames).toContain("upload_error");
  });

  it("has correct version range", () => {
    expect(migrations.minVersion).toBe(1);
    expect(migrations.maxVersion).toBe(3);
  });
});
