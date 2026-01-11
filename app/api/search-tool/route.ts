import { NextRequest, NextResponse } from "next/server";
import { webSearchTool } from "@/lib/tools/web-search";
import { xSearchTool } from "@/lib/tools/x-search";
import { generateUUID } from "three/src/math/MathUtils.js";

export async function POST(req: NextRequest) {
  try {
    const { toolName, parameters } = await req.json();

    console.log(`[Search Tool API] Executing ${toolName}`, parameters);

    let result: any;

    switch (toolName) {
      case "web_search": {
        const { queries, maxResults, topics, quality } = parameters;
        const tool = webSearchTool();
        if (!tool || !tool.execute) {
          return NextResponse.json(
            { error: "Web search tool not available" },
            { status: 500 }
          );
        }
        result = await tool.execute(
          { 
            queries,
            maxResults: maxResults || undefined,
            topics: topics || undefined,
            quality: quality || undefined,
          },
          {
            toolCallId: generateUUID(),
            messages: [],
          }
        );
        break;
      }

      case "x_search": {
        const { queries, includeXHandles, excludeXHandles, numResults, dateRange } = parameters;
        const tool = xSearchTool();
        if (!tool || !tool.execute) {
          return NextResponse.json(
            { error: "X search tool not available" },
            { status: 500 }
          );
        }
        result = await tool.execute(
          { 
            queries, 
            includeXHandles: includeXHandles || undefined,
            excludeXHandles: excludeXHandles || undefined,
            startDate: dateRange?.startDate || undefined,
            endDate: dateRange?.endDate || undefined,
          },
          {
            toolCallId: generateUUID(),
            messages: [],
          }
        );
        break;
      }

      default:
        console.error(`[Search Tool API] Unknown tool: ${toolName}`);
        return NextResponse.json(
          { error: `Unknown tool: ${toolName}` },
          { status: 400 }
        );
    }

    console.log(`[Search Tool API] ${toolName} completed successfully`);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("[Search Tool API] Error:", error);
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Internal server error",
        success: false 
      },
      { status: 500 }
    );
  }
}
