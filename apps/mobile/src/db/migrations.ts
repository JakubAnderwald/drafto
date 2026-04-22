import { schemaMigrations, addColumns } from "@nozbe/watermelondb/Schema/migrations";

export const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 3,
      steps: [
        addColumns({
          table: "attachments",
          columns: [{ name: "upload_error", type: "string", isOptional: true }],
        }),
      ],
    },
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: "attachments",
          columns: [
            { name: "local_uri", type: "string", isOptional: true },
            { name: "upload_status", type: "string" },
          ],
        }),
      ],
    },
  ],
});
