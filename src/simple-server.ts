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

// Security: Restricted paths for safety
const DANGEROUS_PATHS = [
  '/etc', '/usr/bin', '/bin', '/sbin', '/boot', '/sys', '/proc',
  '/mnt/c/Windows', '/mnt/c/Program Files', '/mnt/c/ProgramData',
  'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData',
  '/root', '/var/log', '/var/lib'
];

const ALLOWED_PATH_PATTERNS = [
  /^\/mnt\/c\/(?:Users|Projects|Development|Dev|Code|Workspace)/i,
  /^\/home\/[^\/]+\/(?:Projects|Development|Dev|Code|Workspace)/i,
  /^\.{1,2}$/,  // Allow current and parent directory
  /^\.\//, // Allow relative paths from current directory
];

// Cross-platform path normalization with security validation
function normalizeProjectPath(projectPath: string): string {
  let normalizedPath = projectPath;
  
  // Convert Windows paths to WSL/Unix format
  if (projectPath.match(/^[A-Za-z]:\\/)) {
    const drive = projectPath.charAt(0).toLowerCase();
    const pathWithoutDrive = projectPath.slice(3).replace(/\\/g, '/');
    normalizedPath = `/mnt/${drive}/${pathWithoutDrive}`;
  }
  // Handle UNC paths \\server\share -> /server/share  
  else if (projectPath.startsWith('\\\\')) {
    normalizedPath = projectPath.replace(/\\/g, '/').substring(1);
  }
  
  // Security validation: Check against dangerous paths
  const isDangerous = DANGEROUS_PATHS.some(dangerousPath => 
    normalizedPath.toLowerCase().startsWith(dangerousPath.toLowerCase())
  );
  
  if (isDangerous) {
    throw new Error(`Access denied: Path '${projectPath}' is restricted for security reasons. Please use workspace/project directories only.`);
  }
  
  // Check if path matches allowed patterns (for public deployment)
  const isAllowed = ALLOWED_PATH_PATTERNS.some(pattern => 
    pattern.test(normalizedPath) || pattern.test(projectPath)
  );
  
  if (!isAllowed) {
    throw new Error(`Access denied: Path '${projectPath}' is not in an allowed workspace directory. Please use paths like 'C:\\Users\\YourName\\Projects' or '/home/user/Projects'.`);
  }
  
  return normalizedPath;
}

// Gemini Codebase Analyzer Schema
const GeminiCodebaseAnalyzerSchema = z.object({
  projectPath: z.string().min(1).describe("Path to your project directory (e.g., 'C:\\Users\\YourName\\Projects\\MyProject' or '/home/user/Projects/MyProject'). Only workspace/project directories are allowed for security."),
  question: z.string().min(1).max(2000).describe("Your question about the codebase"),
  geminiApiKey: z.string().min(1).optional().describe("Your Gemini API key (can be set via environment)")
});

// Gemini Code Search Schema - for targeted, fast searches
const GeminiCodeSearchSchema = z.object({
  projectPath: z.string().min(1).describe("Path to your project directory. Only workspace/project directories are allowed for security."),
  searchQuery: z.string().min(1).max(500).describe("Specific code pattern, function, or feature to find (e.g., 'authentication logic', 'error handling', 'database connection')"),
  fileTypes: z.array(z.string()).optional().describe("File extensions to search (e.g., ['.ts', '.js', '.py']). Leave empty for all code files."),
  maxResults: z.number().min(1).max(20).optional().describe("Maximum number of relevant code snippets to analyze (default: 5)"),
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
      {
        name: "gemini_code_search",
        description: "Fast, targeted search through your codebase using Gemini AI - finds specific code patterns, functions, or features quickly by analyzing only relevant parts of your project.",
        inputSchema: zodToJsonSchema(GeminiCodeSearchSchema),
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
        
        // Normalize Windows paths to WSL/Linux format  
        const normalizedPath = normalizeProjectPath(params.projectPath);
        
        // Use API key from environment (Smithery config) or from params
        const apiKey = process.env.GEMINI_API_KEY || params.geminiApiKey;
        
        if (!apiKey || apiKey === "API_KEY_PLACEHOLDER" || apiKey === "your-api-key-here") {
          return {
            content: [
              {
                type: "text",
                text: `# Gemini Codebase Analysis - Demo Mode

**Status:** API key not configured

## Project Structure Analysis (No AI Analysis)

**Project Path:** ${params.projectPath} (normalized: ${normalizedPath})
**Question:** ${params.question}

### Demo Response
This is a demo response without AI analysis. To get full Gemini AI-powered analysis:

1. Get your API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Configure it in Smithery or pass as parameter

### Basic Project Info
- Target directory: ${params.projectPath}
- Analysis requested: ${params.question}
- Status: Waiting for valid API key

*To enable full analysis, provide a valid Gemini API key*`,
              },
            ],
          };
        }

        // Validate normalized project path exists (with better error handling)
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            throw new Error(`ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${params.projectPath}')`);
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }
        
        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        // Prepare project context using normalized path
        const fullContext = await prepareFullContext(normalizedPath);
        
        if (fullContext.length === 0) {
          throw new Error("No readable files found in the project directory");
        }

        // Initialize Gemini AI with optimal generation config
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ 
          model: "gemini-2.5-pro",
          generationConfig: {
            maxOutputTokens: 65536,
            temperature: 0.5,
            topK: 40,
            topP: 0.95,
          }
        });

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
*Normalized Path:* ${normalizedPath}

**Question:** ${params.question}

**Files Processed:** ${filesProcessed}  
**Total Characters:** ${fullContext.length.toLocaleString()}

---

## Analysis

${analysis}

---

*Analysis powered by Gemini 2.5 Pro*`,
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let troubleshootingTips = [];
        
        // Provide specific tips based on error type
        if (errorMessage.includes('ENOENT')) {
          troubleshootingTips = [
            "✗ **Path Error**: The specified directory doesn't exist or isn't accessible",
            "• Check the path spelling and ensure it exists",
            "• For WSL/Linux paths, use absolute paths starting with /",
            "• For Windows paths, try converting to WSL format",
            `• Attempted path: ${(error as any)?.path || 'unknown'}`
          ];
        } else if (errorMessage.includes('API key')) {
          troubleshootingTips = [
            "✗ **API Key Error**: Invalid or missing Gemini API key",
            "• Get your key from [Google AI Studio](https://makersuite.google.com/app/apikey)",
            "• Configure it in Smithery during installation",
            "• Or pass it as geminiApiKey parameter"
          ];
        } else if (errorMessage.includes('timeout')) {
          troubleshootingTips = [
            "✗ **Timeout Error**: Request took too long",
            "• Try with a smaller project directory",
            "• Check your internet connection",
            "• Reduce the scope of your question"
          ];
        } else {
          troubleshootingTips = [
            "✗ **General Error**: Something went wrong",
            "• Verify the project path exists and is accessible",
            "• Ensure your Gemini API key is valid",
            "• Check that the project directory contains readable files",
            "• Try with a smaller project or more specific question"
          ];
        }

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Codebase Analysis - Error

**Error:** ${errorMessage}

### Troubleshooting Guide

${troubleshootingTips.join('\n')}

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Try with a simpler question or smaller project

*Error occurred during: ${errorMessage.includes('ENOENT') ? 'Path validation' : errorMessage.includes('API key') ? 'API key validation' : 'AI analysis'}*`,
            },
          ],
          isError: true,
        };
      }

    case "gemini_code_search":
      try {
        const params = GeminiCodeSearchSchema.parse(request.params.arguments);
        
        // Normalize Windows paths to WSL/Linux format  
        const normalizedPath = normalizeProjectPath(params.projectPath);
        
        // Use API key from environment (Smithery config) or from params
        const apiKey = process.env.GEMINI_API_KEY || params.geminiApiKey;
        
        if (!apiKey || apiKey === "API_KEY_PLACEHOLDER" || apiKey === "your-api-key-here") {
          return {
            content: [
              {
                type: "text",
                text: `# Gemini Code Search - Demo Mode

**Status:** API key not configured

## Search Query: "${params.searchQuery}"
**Project Path:** ${params.projectPath} (normalized: ${normalizedPath})
**File Types:** ${params.fileTypes?.join(', ') || 'All files'}
**Max Results:** ${params.maxResults || 5}

### Demo Response
This tool performs fast, targeted search through your codebase using AI analysis. To enable full functionality:

1. Get your API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Configure it in Smithery or pass as parameter

### How it works:
- Scans your project for files matching the search query
- Uses relevance scoring to find the most relevant code snippets  
- Analyzes only the most relevant parts (much faster than full analysis)
- Perfect for finding specific functions, patterns, or features

*To enable full search, provide a valid Gemini API key*`,
              },
            ],
          };
        }

        // Validate normalized project path exists
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            throw new Error(`ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${params.projectPath}')`);
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }
        
        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        // Find relevant code snippets
        const maxResults = params.maxResults || 5;
        const searchResult = await findRelevantCodeSnippets(
          normalizedPath, 
          params.searchQuery, 
          params.fileTypes, 
          maxResults
        );
        
        if (searchResult.snippets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `# Gemini Code Search Results

## Search Query: "${params.searchQuery}"
**Project:** ${params.projectPath}
**Files Scanned:** ${searchResult.totalFiles}
**Results Found:** 0

### No Matching Code Found

The search didn't find any relevant code snippets matching your query. Try:

- Using different keywords or terms
- Checking if the feature exists in this codebase
- Using broader search terms
- Trying the comprehensive analyzer instead

*Search powered by Gemini 2.5 Pro*`,
              },
            ],
          };
        }

        // Prepare context from relevant snippets
        let searchContext = '';
        for (const snippet of searchResult.snippets) {
          searchContext += `--- File: ${snippet.file} (${snippet.relevance}) ---\n`;
          searchContext += snippet.content;
          searchContext += '\n\n';
        }

        // Initialize Gemini AI with optimal generation config
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ 
          model: "gemini-2.5-pro",
          generationConfig: {
            maxOutputTokens: 65536,
            temperature: 0.5,
            topK: 40,
            topP: 0.95,
          }
        });

        const searchPrompt = `You are a senior AI Software Engineer analyzing specific code snippets from a project. Your task is to help another coding AI understand the most relevant parts of the codebase related to their search query.

SEARCH QUERY: "${params.searchQuery}"

RELEVANT CODE SNIPPETS:
${searchContext}

YOUR TASK:
1. Analyze the provided code snippets that are most relevant to the search query
2. Explain what you found and how it relates to the search query  
3. Provide specific code examples and explanations
4. If multiple relevant patterns are found, organize your response clearly
5. Focus on practical, actionable insights about the found code

RESPONSE FORMAT:
- Use clear Markdown formatting
- Include specific code snippets with explanations
- Provide file paths and line references when relevant
- Be concise but comprehensive
- Focus on answering the search query specifically`;

        // Send to Gemini AI
        const result = await model.generateContent(searchPrompt);
        const response = await result.response;
        const analysis = response.text();

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Code Search Results

## Search Query: "${params.searchQuery}"
**Project:** ${params.projectPath}
*Normalized Path:* ${normalizedPath}

**Files Scanned:** ${searchResult.totalFiles}  
**Relevant Files Found:** ${searchResult.snippets.length}
**Analysis Mode:** Targeted Search (fast)

---

## Analysis

${analysis}

---

### Search Summary
- **Query:** ${params.searchQuery}
- **File Types:** ${params.fileTypes?.join(', ') || 'All files'}
- **Max Results:** ${maxResults}
- **Found:** ${searchResult.snippets.length} relevant code snippets

*Search powered by Gemini 2.5 Pro*`,
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let troubleshootingTips = [];
        
        // Provide specific tips based on error type
        if (errorMessage.includes('ENOENT')) {
          troubleshootingTips = [
            "✗ **Path Error**: The specified directory doesn't exist or isn't accessible",
            "• Check the path spelling and ensure it exists",
            "• For WSL/Linux paths, use absolute paths starting with /",
            "• For Windows paths, try converting to WSL format",
            `• Attempted path: ${(error as any)?.path || 'unknown'}`
          ];
        } else if (errorMessage.includes('API key')) {
          troubleshootingTips = [
            "✗ **API Key Error**: Invalid or missing Gemini API key",
            "• Get your key from [Google AI Studio](https://makersuite.google.com/app/apikey)",
            "• Configure it in Smithery during installation",
            "• Or pass it as geminiApiKey parameter"
          ];
        } else if (errorMessage.includes('search')) {
          troubleshootingTips = [
            "✗ **Search Error**: Problem during code search",
            "• Try with a simpler search query",
            "• Check if the project directory is accessible",
            "• Verify file types are correct (e.g., ['.ts', '.js'])"
          ];
        } else {
          troubleshootingTips = [
            "✗ **General Error**: Something went wrong during search",
            "• Verify the project path exists and is accessible",
            "• Ensure your Gemini API key is valid",
            "• Try with a simpler search query",
            "• Check that the project directory contains readable files"
          ];
        }

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Code Search - Error

**Error:** ${errorMessage}

### Troubleshooting Guide

${troubleshootingTips.join('\n')}

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Try with a simpler search query or use the comprehensive analyzer

*Error occurred during: ${errorMessage.includes('ENOENT') ? 'Path validation' : errorMessage.includes('API key') ? 'API key validation' : errorMessage.includes('search') ? 'Code search' : 'AI analysis'}*`,
            },
          ],
          isError: true,
        };
      }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// Helper function for smart code search - finds relevant code snippets
async function findRelevantCodeSnippets(
  projectPath: string, 
  searchQuery: string, 
  fileTypes?: string[], 
  maxResults: number = 5
): Promise<{ snippets: Array<{file: string, content: string, relevance: string}>, totalFiles: number }> {
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

    // Build file pattern based on fileTypes
    let patterns = ['**/*'];
    if (fileTypes && fileTypes.length > 0) {
      patterns = fileTypes.map(ext => `**/*${ext.startsWith('.') ? ext : '.' + ext}`);
    }

    let allFiles: string[] = [];
    for (const pattern of patterns) {
      const files = await glob(pattern, {
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
      allFiles.push(...files);
    }

    // Remove duplicates
    allFiles = [...new Set(allFiles)];

    const relevantSnippets: Array<{file: string, content: string, relevance: string}> = [];
    
    // Simple keyword-based relevance scoring (can be enhanced with embeddings later)
    const searchTerms = searchQuery.toLowerCase().split(/\s+/);
    
    for (const file of allFiles.slice(0, 50)) { // Limit files to process for performance
      try {
        const filePath = path.join(projectPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        // Skip very large files
        if (content.length > 100000) continue;
        
        // Calculate relevance score
        const contentLower = content.toLowerCase();
        let score = 0;
        let matchedTerms: string[] = [];
        
        for (const term of searchTerms) {
          const matches = (contentLower.match(new RegExp(term, 'g')) || []).length;
          if (matches > 0) {
            score += matches;
            matchedTerms.push(term);
          }
        }
        
        // Boost score for files with terms in filename
        const fileLower = file.toLowerCase();
        for (const term of searchTerms) {
          if (fileLower.includes(term)) {
            score += 5;
            matchedTerms.push(`${term} (in filename)`);
          }
        }
        
        if (score > 0) {
          relevantSnippets.push({
            file,
            content: content.length > 5000 ? content.substring(0, 5000) + '\n...(truncated)' : content,
            relevance: `Score: ${score}, Matched: ${[...new Set(matchedTerms)].join(', ')}`
          });
        }
      } catch (error) {
        // Skip unreadable files
        continue;
      }
    }

    // Sort by relevance score and take top results
    relevantSnippets.sort((a, b) => {
      const scoreA = parseInt(a.relevance.match(/Score: (\d+)/)?.[1] || '0');
      const scoreB = parseInt(b.relevance.match(/Score: (\d+)/)?.[1] || '0');
      return scoreB - scoreA;
    });

    return {
      snippets: relevantSnippets.slice(0, maxResults),
      totalFiles: allFiles.length
    };
  } catch (error) {
    throw new Error(`Failed to search codebase: ${error}`);
  }
}

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

// Start the server (Smithery will run this directly)
(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini MCP Server running on stdio");
})().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});