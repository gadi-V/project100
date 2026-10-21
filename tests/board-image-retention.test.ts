import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20261021133000_board_image/migration.sql",
  "utf8",
);

describe("BoardImage uploader deletion", () => {
  it("keeps the image row and stores uploaderId as null when the uploader is deleted", () => {
    const model = schema.slice(schema.indexOf("model BoardImage"), schema.indexOf("model ChatChannel"));

    expect(model).toContain("uploaderId  String?");
    expect(model).toContain("uploader    User?");
    expect(model).toContain("onDelete: SetNull");
    expect(model).not.toContain("onDelete: Restrict");

    expect(migration).toContain('"uploaderId" TEXT,');
    expect(migration).not.toContain('"uploaderId" TEXT NOT NULL');
    expect(migration).toContain(
      'FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE',
    );
    expect(migration).not.toContain("ON DELETE RESTRICT");
  });
});
