# mcp-ts-template: Developer Guide & Architectural Standards

**Effective Date:** 2025-06-15

This document mandates the development practices, architectural patterns, and operational procedures for projects based on the `mcp-ts-template`. It is the authoritative guide for ensuring code quality, consistency, and maintainability. All development must adhere to these standards.

## I. Core Architectural Principles

Our architecture is built on a clear separation of concerns, ensuring that code is modular, testable, and easy to understand.

### 1. Logic Throws, Handlers Catch

This is the cornerstone of our error-handling strategy.

- **Core Logic (`logic.ts`)**: This layer is responsible for business logic only. It should be pure and self-contained. If an error occurs (e.g., failed validation, API error), it **must `throw` a structured `McpError`**. Logic files **must not** contain `try...catch` blocks for formatting final responses.
- **Handlers (`registration.ts`, Transports)**: This layer is responsible for invoking core logic and managing communication protocols. It **must** wrap all calls to the logic layer in a `try...catch` block. This is the only place where errors are caught, processed by the `ErrorHandler`, and formatted into a final `CallToolResult` or HTTP response.

### 2. Structured, Traceable Operations

Every operation must be traceable from start to finish through structured logging and context propagation.

- **`RequestContext`**: Every significant operation must begin by creating a `RequestContext` using `requestContextService.createRequestContext()`. This context, containing a unique `requestId`, must be passed down through all subsequent function calls.
- **`Logger`**: All logging must be done through the centralized `logger` singleton, and every log call must include the current `RequestContext`.

## II. Tool Development Workflow

This section defines the mandatory workflow for creating and modifying tools.

### A. File and Directory Structure

Each tool must reside in its own directory within `src/mcp-server/tools/` and follow this structure:

- **`toolName/`**
  - **`index.ts`**: A barrel file that exports only the `register...` function from `registration.ts`.
  - **`logic.ts`**: Contains the core business logic. It **must** define and export the tool's Zod input schema, all inferred TypeScript types (input and output), and the main logic function.
  - **`registration.ts`**: Registers the tool with the MCP server. It imports from `logic.ts` and implements the "Handler" role described in our core principles.

### B. The Authoritative Pattern: `echoTool`

The refactored `echoTool` serves as the canonical example for all tool development.

**Step 1: Define Schema and Logic (`logic.ts`)**

The `logic.ts` file defines the "what" and "how" of the tool. It is self-contained and throws errors when it cannot fulfill its contract.

```typescript
/**
 * @fileoverview Defines the core logic, schemas, and types for the `echo_message` tool.
 * @module src/mcp-server/tools/echoTool/logic
 */
import { z } from "zod";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema
export const EchoToolInputSchema = z.object({
  message: z
    .string()
    .min(1, "Message cannot be empty.")
    .max(1000, "Message cannot exceed 1000 characters.")
    .describe("The message to echo back."),
  // ... other fields with .describe()
});

// 2. Define and export TypeScript types
export type EchoToolInput = z.infer<typeof EchoToolInputSchema>;
export interface EchoToolResponse {
  originalMessage: string;
  formattedMessage: string;
  repeatedMessage: string;
  // ... other fields
}

/**
 * 3. Implement and export the core logic
 * @param params - The validated input parameters for the echo tool.
 * @param context - The request context, used for logging and tracing the operation.
 * @returns A promise that resolves with an object containing the processed response data.
 */
export async function echoToolLogic(
  params: EchoToolInput,
  context: RequestContext,
): Promise<EchoToolResponse> {
  logger.debug("Processing echo message logic...", { ...context });
  // ... business logic ...
  // On success, RETURN a structured output object
  return {
    /* ... success data ... */
  };
}
```

**Step 2: Register the Tool and Handle Errors (`registration.ts`)**

The `registration.ts` file wires the logic into the MCP server and handles all outcomes.

```typescript
/**
 * @fileoverview Handles the registration of the `echo_message` tool.
 * @module src/mcp-server/tools/echoTool/registration
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
} from "../../../utils/index.js";
// 1. Import everything from the logic file
import { EchoToolInput, EchoToolInputSchema, echoToolLogic } from "./logic.js";

/**
 * Registers the 'echo_message' tool with the provided MCP server instance.
 * @param server - The MCP server instance to register the tool with.
 */
export const registerEchoTool = async (server: McpServer): Promise<void> => {
  const toolName = "echo_message";
  const toolDescription =
    "Echoes a message back with optional formatting and repetition.";

  server.tool(
    toolName,
    toolDescription,
    EchoToolInputSchema.shape,
    async (params: EchoToolInput, mcpContext: any): Promise<CallToolResult> => {
      const handlerContext = requestContextService.createRequestContext({
        /* ... */
      });

      try {
        // 2. Invoke the core logic
        const result = await echoToolLogic(params, handlerContext);

        // 3. Format the SUCCESS response
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        // 4. CATCH any error thrown by the logic
        const handledError = ErrorHandler.handleError(error, {
          /* ... */
        });

        // 5. Format the ERROR response
        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(/* ... */);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: mcpError.code,
                  message: mcpError.message,
                  details: mcpError.details,
                },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
};
```

## III. Resource Development Workflow

The process for creating Resources is similar to Tools, focusing on data retrieval.

- **File Structure**: Same as tools, but under `src/mcp-server/resources/`.
- **Registration**: Use `server.resource(registrationName, template, metadata, handler)`. The handler receives URI parameters and must return a `{ contents: [{ uri, blob, mimeType }] }` object.

## IV. Integrating External Services

For interacting with external APIs (databases, etc.), use singleton provider classes.

- **Encapsulation**: Each service provider (e.g., `src/services/llm-providers/openRouterProvider.ts`) should manage its own client, configuration, and API logic.
- **Singleton Pattern**: Use a singleton to share one instance across the application (e.g., `src/services/supabase/supabaseClient.ts`).
- **Usage**: Import the singleton instance into your tool's `logic.ts` file to use it.

## V. Code Quality and Documentation

- **JSDoc**: Every file must start with a `@fileoverview` and `@module` block. All exported functions and types must have clear, concise JSDoc comments explaining their purpose.
- **Clarity Over Brevity**: Write self-documenting code with meaningful variable and function names.
- **Immutability**: Prefer functional approaches and immutable data structures where possible to avoid side effects.
- **Formatting**: All code must be formatted using Prettier (`npm run format`) before committing.

## VI. Security Mandates

- **Input Sanitization**: All inputs from external sources (tool arguments, API responses) must be treated as untrusted. Use the `sanitization` utilities where appropriate.
- **Secrets Management**: All secrets (API keys, auth keys) **must** be loaded from environment variables via the `config` module. Never hardcode secrets.
- **Authentication & Authorization**:
  - The server supports `jwt` (dev) and `oauth` (prod) modes via `MCP_AUTH_MODE`.
  - Protect tools by checking scopes. Use the `withRequiredScopes(["scope:read"])` utility inside your tool handler.
- **Rate Limiting**: Protect against abuse by using the centralized `rateLimiter`.

This guide is the single source of truth for development standards. All code reviews will be conducted against these principles.
