#!/usr/bin/env node

/**
 * Simple MCP Server for Smithery deployment
 * Based on working patterns from successful Smithery servers
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { promises as fs } from "fs";
import path from "path";
import { glob } from "glob";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Gemini Codebase Analyzer Schema
const GeminiCodebaseAnalyzerSchema = z.object({
  projectPath: z.string().min(1).describe("Absolute path to the project directory to analyze"),
  question: z.string().min(1).max(2000).describe("Your question about the codebase"),
  geminiApiKey: z.string().min(1).optional().describe("Your Gemini API key (can be set via environment)")
});

// Create the server
const server = new Server({
  name: "gemini-mcp-server",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
});

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "gemini_codebase_analyzer",
        description: "Analyze any codebase with Gemini AI - scans all project files and provides comprehensive analysis, architecture insights, bug detection, and answers to specific questions about the code.",
        inputSchema: zodToJsonSchema(GeminiCodebaseAnalyzerSchema),
      },
    ],
  };
});

// Tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "gemini_codebase_analyzer":
      try {
        const params = GeminiCodebaseAnalyzerSchema.parse(request.params.arguments);
        
        // Use API key from environment (Smithery config) or from params
        const apiKey = process.env.GEMINI_API_KEY || params.geminiApiKey;
        
        if (!apiKey) {
          throw new Error("Gemini API key is required. Get your key from https://makersuite.google.com/app/apikey");
        }

        // Validate project path exists
        const stats = await fs.stat(params.projectPath);
        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${params.projectPath}`);
        }

        // Prepare project context
        const fullContext = await prepareFullContext(params.projectPath);
        
        if (fullContext.length === 0) {
          throw new Error("No readable files found in the project directory");
        }

        // Initialize Gemini AI
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const systemPrompt = `You are a senior AI Software Engineer and consultant with full access to an entire software project codebase. Your task is to analyze the complete project context and a specific question from another coding AI, providing the clearest and most accurate answer to help that AI.

YOUR RESPONSIBILITIES:
1. Completely understand the vast code context provided to you.
2. Evaluate the specific question (debugging, coding strategy, analysis, etc.) within this holistic context.
3. Create your answer in a way that the coding AI can directly understand and use, in Markdown format, with explanatory texts and clear code blocks. Your goal is to guide that AI like a knowledgeable mentor who knows the entire project.

RESPONSE FORMAT:
- Use clear Markdown formatting
- Include code examples when relevant
- Provide actionable insights
- Focus on practical guidance
- Be comprehensive but concise`;

        // Create the mega prompt
        const megaPrompt = `${systemPrompt}

PROJECT CONTEXT:
${fullContext}

CODING AI QUESTION:
${params.question}`;

        // Send to Gemini AI
        const result = await model.generateContent(megaPrompt);
        const response = await result.response;
        const analysis = response.text();

        const filesProcessed = fullContext.split('--- File:').length - 1;

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Codebase Analysis Results

## Project: ${params.projectPath}

**Question:** ${params.question}

**Files Processed:** ${filesProcessed}  
**Total Characters:** ${fullContext.length.toLocaleString()}

---

## Analysis

${analysis}

---

*Analysis powered by Gemini 2.0 Flash*`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# Gemini Codebase Analysis - Error

**Error:** ${error instanceof Error ? error.message : String(error)}

### Troubleshooting Tips:
- Verify the project path exists and is accessible
- Ensure your Gemini API key is valid
- Check that the project directory contains readable files
- Try with a smaller project or more specific question

*For support, check your API key at: https://makersuite.google.com/app/apikey*`,
            },
          ],
          isError: true,
        };
      }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// Helper function to prepare full context
async function prepareFullContext(projectPath: string): Promise<string> {
  try {
    let gitignoreRules: string[] = [];
    
    // Read .gitignore file if it exists
    try {
      const gitignorePath = path.join(projectPath, '.gitignore');
      const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
      gitignoreRules = gitignoreContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    } catch (error) {
      // No .gitignore file, continue
    }

    // Scan all files in the project
    const files = await glob('**/*', {
      cwd: projectPath,
      ignore: [
        ...gitignoreRules,
        'node_modules/**',
        '.git/**',
        '*.log',
        '.env*',
        'dist/**',
        'build/**',
        '*.map',
        '*.lock',
        '.cache/**',
        'coverage/**'
      ],
      nodir: true
    });

    let fullContext = '';

    // Read each file and combine content
    for (const file of files) {
      try {
        const filePath = path.join(projectPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        fullContext += `--- File: ${file} ---\n`;
        fullContext += content;
        fullContext += '\n\n';
      } catch (error) {
        // Skip binary files or unreadable files
        continue;
      }
    }

    return fullContext;
  } catch (error) {
    throw new Error(`Failed to prepare project context: ${error}`);
  }
}

// Smithery export pattern
export default function({ sessionId, config }: { sessionId: string, config: any }) {
  return server;
}

// Start the server for direct execution (when run as standalone script)
if (typeof require !== 'undefined' && require.main === module) {
  (async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Gemini MCP Server running on stdio");
  })().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}