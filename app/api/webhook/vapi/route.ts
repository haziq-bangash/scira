import { NextRequest, NextResponse } from 'next/server';
import { webSearchTool } from '@/lib/tools/web-search';
import { xSearchTool } from '@/lib/tools/x-search';
import { generateUUID } from 'three/src/math/MathUtils.js';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message } = body;

    // Vapi sends function call details in message.functionCall
    if (message?.type === 'function-call') {
      const { functionCall } = message;
      const { name, parameters } = functionCall;

      console.log(`[Vapi Webhook] Tool called: ${name}`, parameters);

      let result: any;

      // Route to your existing tool implementations
      switch (name) {
        case 'web_search': {
          const { queries } = parameters;
          // Execute your existing web search tool
          const tool = webSearchTool();
          if (!tool || !tool.execute) {
            result = { error: 'Web search tool not available' };
            break;
          }
          result = await tool.execute({ queries }, { toolCallId: generateUUID(), messages: [] });
          console.log(result)
          break;
        }

        case 'x_search': {
          const { queries, includeXHandles, excludeXHandles } = parameters;
          // Execute your existing X search tool
          const tool = xSearchTool();
          if (!tool || !tool.execute) {
            result = { error: 'X search tool not available' };
            break;
          }
          result = await tool.execute(
            {
              queries,
              includeXHandles,
              excludeXHandles,
            },
            {
              toolCallId: generateUUID(),
              messages: [],
            },
          );
          break;
        }

        default:
          result = { error: `Unknown tool: ${name}` };
      }

      // Return result in Vapi's expected format
      return NextResponse.json({
        result: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    return NextResponse.json({ message: 'No function call to process' });
  } catch (error) {
    console.error('[Vapi Webhook] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
