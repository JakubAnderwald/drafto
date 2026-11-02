import { NextResponse } from "next/server";
import { getBuildCommit } from "@/lib/build-info";

export function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    commit: getBuildCommit(),
  });
}
