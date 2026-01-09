# Rovo AI - Copilot Instructions

## Project Overview

**Rovo** is an agentic research platform - an AI-powered search engine that uses Vercel AI SDK with multi-model support (xAI Grok, Anthropic Claude, Google Gemini, OpenAI GPT) to find, analyze, and cite information from the live web. Built with Next.js 16 (canary), TypeScript, Drizzle ORM, and Better Auth.

## Architecture & Key Patterns

### 1. Search Groups System

The core abstraction is **Search Groups** (`lib/utils.ts`):
- `web` - General web search (Exa/Tavily/Parallel)
- `x` - X/Twitter search
- `academic` - Academic papers
- `youtube`, `reddit` - Platform-specific
- `extreme` - Multi-step deep research
- `chat` - Direct LLM conversation
- `stocks`, `crypto`, `code`, `connectors` - Domain-specific

**Pattern**: Each group dynamically loads appropriate tools. Check `getSearchGroups()` and `SearchGroupId` type in `lib/utils.ts`.

### 2. Tool Architecture

Tools are in `lib/tools/` using Vercel AI SDK's `tool()` function:

```typescript
export const exampleTool = tool({
  description: 'Clear description for LLM',
  parameters: z.object({ ... }),
  execute: async (params) => { ... }
});
```

**Critical**: Some tools accept optional `dataStream?: UIMessageStreamWriter<ChatMessage>` for streaming intermediate updates to the UI (e.g., `webSearchTool`, `xSearchTool`, `extremeSearchTool`).

**Export pattern**: All tools exported from `lib/tools/index.ts` for centralized imports.

### 3. AI Route Pattern (`app/api/search/route.ts`)

The main search API route (`POST /api/search`) follows this pattern:

1. **Authentication & Rate Limiting** - Check auth, Pro status, usage limits
2. **Tool Selection** - Conditionally include tools based on search group, auth status, and Pro subscription
3. **Stream Context** - Create resumable stream using `createResumableStreamContext()` for pause/resume
4. **Model Invocation** - Call `streamText()` with:
   - Custom provider from `ai/providers.ts` (e.g., `rovo.languageModel('rovo-default')`)
   - System prompt with custom instructions
   - Pruned message history
   - Dynamic tools array
   - Model-specific parameters (`maxTokens`, `temperature`, reasoning settings)
5. **Response Streaming** - Stream with `createUIMessageStream()` for real-time UI updates
6. **Post-Processing** - Save chat/messages in background using `after()` from `next/server`

### 4. AI Provider Configuration (`ai/providers.ts`)

**Custom provider setup**:
- `rovo` is a `customProvider` with 40+ models mapped to underlying providers
- Models use middleware for extracting reasoning (e.g., `<think>` tags)
- Functions: `requiresAuthentication()`, `requiresProSubscription()`, `getModelParameters()`
- **Critical**: Use `getModelParameters()` to get model-specific settings (reasoning, maxTokens)

### 5. Database Layer (Drizzle ORM)

**Schema**: `lib/db/schema.ts` defines all tables
- `user`, `session`, `account`, `verification` - Auth (Better Auth)
- `chat`, `message` - Core chat data
- `customInstructions`, `userPreferences` - User settings
- `extremeSearchUsage`, `messageUsage` - Usage tracking
- `stripeSubscription` - Subscription management
- `lookout` - Background monitoring jobs

**Queries**: All database operations in `lib/db/queries.ts`
- Use `getReadReplica()` for reads (supports read replicas)
- Use `db` for writes
- Export specific query functions (no generic "findOne" pattern)

**Migration**: Run `npm run db:push` (via Drizzle Kit)

### 6. Authentication (Better Auth)

**Setup**: `lib/auth.ts` configures Better Auth with:
- Drizzle adapter
- Social providers (GitHub, Google, Twitter)
- Subscription plugins (Polar, Stripe)
- Email verification

**Usage in components**:
```typescript
const { data: user, isLoading } = useUser(); // Client-side hook
const user = await getCurrentUser(); // Server action (comprehensive)
const user = await getLightweightUser(); // Server action (fast auth check)
```

**Pattern**: Use `getLightweightUser()` for auth checks, `getCurrentUser()` for full user data with Pro status.

### 7. Caching Strategy (`lib/performance-cache.ts`, `lib/user-data-server.ts`)

**Multi-layer caching**:
- Upstash Redis for serverless caching
- In-memory LRU cache as fallback
- Usage counters cached with TTL

**Pattern**: 
```typescript
const data = await getCachedUserPreferencesByUserId(userId); // Auto-cached
await clearUserPreferencesCache(userId); // Explicit invalidation
```

**Important**: Always invalidate caches after mutations (see webhook handlers in `lib/auth.ts`).

### 8. Client State Management

**Primary pattern**: React hooks + React Query (TanStack Query)
- `contexts/user-context.tsx` - Global user state with `useUser()`
- Server actions wrapped in React Query for caching (see `hooks/use-usage-data.tsx`)
- Local state for UI (forms, dialogs) using React hooks

**Chat state**: `components/chat-state.ts` uses `useReducer` for complex chat interactions.

### 9. Environment Variables

**Server**: Validated via `env/server.ts` using `@t3-oss/env-nextjs`
- All API keys defined with `z.string().min(1)`
- Fails fast on startup if missing

**Client**: Validated via `env/client.ts`

**Pattern**: Import from `@/env/server` or `@/env/client`, never `process.env` directly.

## Development Workflows

### Setup & Running

```bash
npm ci                      # Install dependencies
npm run dev                 # Start dev server (uses Turbopack)
npm run build              # Production build
npm run lint               # ESLint
npm run fix                # Prettier format
```

**Docker**:
```bash
docker compose up          # Run full stack
```

### Database

```bash
npx drizzle-kit generate   # Generate migration from schema
npx drizzle-kit migrate    # Apply migrations
npx drizzle-kit studio     # Open Drizzle Studio (DB GUI)
```

**Pattern**: Use SQL files `create_indexes.sql` and `reindex_tables.sql` for custom indexes.

### Testing New Tools

1. Create tool in `lib/tools/new-tool.ts`
2. Export from `lib/tools/index.ts`
3. Import in `app/api/search/route.ts`
4. Add to tools array conditionally based on search group
5. Test streaming behavior if using `dataStream` parameter

## Critical Project-Specific Patterns

### 1. Message Streaming

**Pattern**: Tools that perform external API calls should use `dataStream` to send incremental updates:

```typescript
export function myTool(dataStream?: UIMessageStreamWriter<ChatMessage>) {
  return tool({
    execute: async (params) => {
      dataStream?.writeMessageAnnotation({
        type: 'status',
        status: { type: 'in_progress', message: 'Searching...' }
      });
      
      const result = await externalAPI();
      
      dataStream?.writeMessageAnnotation({
        type: 'sources',
        sources: result.sources
      });
      
      return result;
    }
  });
}
```

### 2. Pro Feature Gating

**Always check** for Pro features:
```typescript
if (requiresProSubscription(selectedModel) && !isProUser) {
  throw new ChatSDKError('subscription:pro_required', 'This model requires Pro');
}
```

### 3. Usage Limits

**Track usage** via:
- `incrementMessageUsage(userId)` - Count messages
- `incrementExtremeSearchUsage(userId)` - Count extreme searches
- Check limits: `getMessageCount(userId)`, `getExtremeSearchCount(userId)`
- Constants in `lib/constants.ts` (e.g., `SEARCH_LIMITS`)

### 4. Error Handling

Use `ChatSDKError` from `lib/errors.ts` with specific codes:
- `rate_limit:too_many_requests`
- `subscription:pro_required`
- `auth:required`
- `bad_request:database`

**Client handling**: Errors displayed via toast (Sonner)

### 5. Custom Instructions

**Feature**: Users can add custom instructions that augment system prompts
- Stored in `customInstructions` table
- Retrieved via `getCachedCustomInstructionsByUserId(userId)`
- Appended to system message in chat routes

### 6. Connectors System

**Feature**: Search across Google Drive, Notion, OneDrive
- Implementation: `lib/connectors.tsx` (React Server Components for UI)
- API: `createConnection()`, `listUserConnections()`, `manualSync()`
- Tool: `createConnectorsSearchTool(userId, connections)` (dynamic tool generation)
- **Requires**: Pro subscription + authentication

### 7. Lookout (Background Monitoring)

**Feature**: Periodic search jobs that monitor topics
- Stored in `lookout` table with cron expressions
- Executed via QStash (Upstash)
- Route: `app/api/lookout/route.ts`

## Key Files Reference

- `app/api/search/route.ts` - Main chat/search API endpoint
- `ai/providers.ts` - Model provider configuration
- `lib/tools/index.ts` - All available tools
- `lib/utils.ts` - Search groups and utilities
- `lib/db/schema.ts` - Database schema
- `lib/auth.ts` - Authentication config
- `components/chat-interface.tsx` - Main chat UI component
- `app/actions.ts` - Server actions for client use

## Common Tasks

**Add a new AI tool**: Create in `lib/tools/`, export from index, import in search route
**Add a new search group**: Update `SearchGroupId` type and `getSearchGroups()` in `lib/utils.ts`
**Modify authentication**: Edit `lib/auth.ts` (Better Auth config)
**Change database schema**: Edit `lib/db/schema.ts`, run `drizzle-kit generate`
**Add API integration**: Store key in `env/server.ts`, use in tool execution

## Deployment

- **Platform**: Vercel (optimized for)
- **Database**: PostgreSQL (via DATABASE_URL)
- **Redis**: Upstash Redis (REDIS_URL)
- **Environment**: All env vars from `env/server.ts` must be set

**Deploy button** in README auto-configures Vercel with required env vars.
