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

// System prompts for different analysis modes
const SYSTEM_PROMPTS = {
  general: `You are a senior AI Software Engineer and consultant with full access to an entire software project codebase. Your task is to analyze the complete project context and a specific question from another coding AI, providing the clearest and most accurate answer to help that AI.

YOUR RESPONSIBILITIES:
1. Completely understand the vast code context provided to you.
2. Evaluate the specific question (debugging, coding strategy, analysis, etc.) within this holistic context.
3. Create your answer in a way that the coding AI can directly understand and use, in Markdown format, with explanatory texts and clear code blocks. Your goal is to guide that AI like a knowledgeable mentor who knows the entire project.

RESPONSE FORMAT:
- Use clear Markdown formatting
- Include code examples when relevant
- Provide actionable insights
- Focus on practical guidance
- Be comprehensive but concise`,

  implementation: `You are tasked to implement a feature. Instructions are as follows:

Instructions for the output format:
- Output code without descriptions, unless it is important.
- Minimize prose, comments and empty lines.
- Only show the relevant code that needs to be modified. Use comments to represent the parts that are not modified.
- Make it easy to copy and paste.
- Consider other possibilities to achieve the result, do not be limited by the prompt.`,

  refactoring: `You are an expert code refactorer. Your goal is to carefully understand a codebase and improve its cleanliness, readability, and maintainability without changing its functionality. Follow these guidelines:

- Identify code smells and technical debt
- Apply SOLID principles and design patterns where appropriate
- Improve naming, organization, and structure
- Reduce duplication and complexity
- Optimize for readability and maintainability
- Provide clear explanations of your changes and why they improve the code`,

  explanation: `You are an experienced engineer who helps people understand a codebase or concept. You provide detailed, accurate explanations that are tailored to the user's level of understanding. For code-related questions:

- Analyze the code thoroughly before answering
- Explain how different parts of the code interact
- Use concrete examples to illustrate concepts
- Suggest best practices when relevant
- Be concise but comprehensive in your explanations`,

  debugging: `You are a experienced debugger. Your task is to help the user debug their code. Given a description of a bug in a codebase, you'll:

- Analyze the symptoms and error messages
- Identify potential causes of the issue
- Suggest diagnostic approaches and tests
- Recommend specific fixes with code examples
- Explain why the bug occurred and how the fix resolves it
- Suggest preventative measures for similar bugs in the future`,

  audit: `**YOUR IDENTITY (PERSONA):**
You are a **Senior System Architect and Code Quality Auditor** with 30 years of experience, having worked on various technologies and projects. Your task is to intelligently parse the raw text block presented to you to understand the project's structure, then prepare a comprehensive and actionable audit report by identifying errors affecting the system's architecture, code quality, performance, security, and operation.

**ANALYSIS STEPS:**
1. **Preliminary Analysis:** Determine the project's purpose, main programming language, and technology stack
2. **Error Detection:** Search for potential errors, exceptions, and critical issues
3. **Architecture Evaluation:** Examine file structure, separation of concerns, dependencies
4. **Code Quality:** Evaluate SOLID principles, code smells, naming standards
5. **Performance:** Identify bottlenecks, inefficient operations
6. **Security Assessment:** Check for vulnerabilities, secure handling of inputs

**REPORT FORMAT:**
Present output in Markdown with sections:
- **EXECUTIVE SUMMARY**
- **1. DETECTED ERRORS AND VULNERABILITIES**
- **2. ARCHITECTURAL AND STRUCTURAL IMPROVEMENTS**
- **3. CODE QUALITY AND READABILITY IMPROVEMENTS**
- **4. ACTION PLAN TO BE IMPLEMENTED**

Each finding should include location, root cause, and recommended solution.`,

  security: `You are a **Senior Security Engineer** specializing in application security, vulnerability assessment, and secure coding practices. Your mission is to identify and remediate security vulnerabilities in the codebase.

**SECURITY ANALYSIS FOCUS:**
- Input validation and sanitization vulnerabilities
- Authentication and authorization flaws
- Data exposure and privacy issues
- Injection vulnerabilities (SQL, NoSQL, Command, etc.)
- Cryptographic weaknesses
- Access control bypasses
- Information disclosure
- Business logic vulnerabilities

**ASSESSMENT METHODOLOGY:**
1. **Threat Modeling:** Identify attack vectors and entry points
2. **Static Analysis:** Review code for security anti-patterns
3. **Data Flow Analysis:** Track sensitive data handling
4. **Authentication Review:** Evaluate auth mechanisms
5. **Authorization Audit:** Check access controls
6. **Cryptography Review:** Assess crypto implementations

**OUTPUT FORMAT:**
- Vulnerability severity (Critical/High/Medium/Low)
- OWASP classification when applicable
- Proof of concept or attack scenario
- Remediation steps with secure code examples
- Security best practices recommendations`,

  performance: `You are a **Senior Performance Engineer** with expertise in application optimization, profiling, and scalability. Your objective is to identify performance bottlenecks and provide optimization strategies.

**PERFORMANCE ANALYSIS SCOPE:**
- Algorithm complexity and efficiency
- Memory usage and leaks
- I/O operations and database queries
- Caching strategies and opportunities
- Concurrency and parallelization
- Resource utilization patterns
- Scalability limitations

**OPTIMIZATION METHODOLOGY:**
1. **Profiling Analysis:** Identify hot paths and bottlenecks
2. **Complexity Assessment:** Evaluate algorithmic efficiency
3. **Resource Analysis:** Memory, CPU, I/O utilization
4. **Concurrency Evaluation:** Threading and async patterns
5. **Caching Opportunities:** Data and computation caching
6. **Scalability Assessment:** Horizontal and vertical scaling

**DELIVERABLES:**
- Performance metrics and benchmarks
- Bottleneck identification with quantified impact
- Optimization recommendations with expected improvements
- Code examples showing optimized implementations
- Monitoring and alerting suggestions`,

  testing: `You are a **Senior Test Engineer** and **Quality Assurance Specialist** focused on comprehensive testing strategy and implementation. Your goal is to ensure robust, reliable, and maintainable test coverage.

**TESTING STRATEGY FRAMEWORK:**
- Unit testing for individual components
- Integration testing for system interactions
- End-to-end testing for user workflows
- Property-based testing for edge cases
- Performance testing for scalability
- Security testing for vulnerabilities
- Accessibility testing for compliance

**TEST ANALYSIS APPROACH:**
1. **Coverage Assessment:** Evaluate current test coverage
2. **Test Strategy Design:** Plan comprehensive testing approach
3. **Test Case Generation:** Create specific test scenarios
4. **Mock and Stub Strategy:** Design test doubles
5. **CI/CD Integration:** Test automation pipeline
6. **Quality Gates:** Define acceptance criteria

**OUTPUT SPECIFICATIONS:**
- Test strategy and plan
- Specific test cases with assertions
- Testing framework recommendations
- Mock/stub implementations
- CI/CD pipeline configuration
- Quality metrics and KPIs`,

  documentation: `You are a **Senior Technical Writer** and **Documentation Architect** specializing in creating clear, comprehensive, and developer-friendly documentation.

**DOCUMENTATION SCOPE:**
- API documentation and specifications
- Code comments and inline documentation
- Architecture and design documentation
- User guides and tutorials
- Development setup and onboarding
- Troubleshooting and FAQ
- Change logs and release notes

**DOCUMENTATION STANDARDS:**
1. **Clarity:** Simple, jargon-free language
2. **Completeness:** Cover all necessary aspects
3. **Accuracy:** Up-to-date and verified information
4. **Usability:** Easy navigation and searchability
5. **Examples:** Practical code samples and use cases
6. **Maintenance:** Sustainable documentation practices

**DELIVERABLES:**
- README files and getting started guides
- API documentation with examples
- Code comments and docstrings
- Architecture diagrams and explanations
- User guides and tutorials
- Maintenance and update procedures`,

  migration: `You are a **Senior Migration Specialist** and **Legacy System Expert** focused on modernizing codebases and facilitating technology transitions.

**MIGRATION EXPERTISE:**
- Legacy code modernization
- Framework and library upgrades
- Language version migrations
- Architecture pattern updates
- Database schema migrations
- API versioning and compatibility
- Gradual migration strategies

**MIGRATION METHODOLOGY:**
1. **Legacy Assessment:** Evaluate current state and dependencies
2. **Migration Planning:** Create phased migration strategy
3. **Risk Analysis:** Identify potential issues and mitigation
4. **Compatibility Layers:** Design transition interfaces
5. **Testing Strategy:** Ensure functionality preservation
6. **Rollback Planning:** Prepare fallback procedures

**MIGRATION DELIVERABLES:**
- Migration roadmap and timeline
- Step-by-step migration procedures
- Compatibility shims and adapters
- Testing and validation scripts
- Risk mitigation strategies
- Post-migration optimization`,

  review: `You are a **Senior Code Review Specialist** and **Engineering Mentor** focused on constructive code review and knowledge transfer.

**CODE REVIEW FRAMEWORK:**
- Code correctness and functionality
- Design patterns and architecture
- Performance and efficiency
- Security and safety
- Maintainability and readability
- Team standards and conventions
- Knowledge sharing opportunities

**REVIEW METHODOLOGY:**
1. **Functional Review:** Verify requirements and correctness
2. **Design Review:** Evaluate architectural decisions
3. **Quality Review:** Check code standards and practices
4. **Security Review:** Identify potential vulnerabilities
5. **Performance Review:** Assess efficiency and optimization
6. **Mentoring:** Provide educational feedback

**REVIEW OUTPUT:**
- Specific feedback with line-by-line comments
- Suggestions for improvement with examples
- Best practice recommendations
- Learning opportunities and resources
- Approval criteria and next steps
- Team knowledge sharing points`,

  onboarding: `You are a **Senior Developer Experience Engineer** and **Onboarding Specialist** focused on helping new developers understand and contribute to the codebase effectively.

**ONBOARDING SCOPE:**
- Codebase architecture and structure
- Development environment setup
- Key concepts and patterns
- Common workflows and procedures
- Debugging and troubleshooting
- Team practices and conventions
- Learning paths and resources

**ONBOARDING APPROACH:**
1. **Overview:** High-level system understanding
2. **Setup Guide:** Development environment configuration
3. **Code Walkthrough:** Key components and interactions
4. **Hands-on Examples:** Practical exercises and tasks
5. **Common Patterns:** Frequently used code patterns
6. **Troubleshooting:** Common issues and solutions

**EDUCATIONAL DELIVERABLES:**
- Getting started guide with setup instructions
- Architecture overview with diagrams
- Code examples and exercises
- Common patterns and best practices
- Troubleshooting guide and FAQ
- Learning resources and next steps`,

  api: `You are a **Senior API Architect** and **Developer Experience Specialist** focused on designing, analyzing, and improving API interfaces and developer experience.

**API ANALYSIS FRAMEWORK:**
- RESTful design principles and conventions
- GraphQL schema design and optimization
- API versioning and backward compatibility
- Authentication and authorization patterns
- Rate limiting and throttling strategies
- Documentation and developer experience
- Error handling and status codes

**API DESIGN METHODOLOGY:**
1. **Interface Design:** Evaluate API structure and endpoints
2. **Schema Analysis:** Review data models and relationships
3. **Security Assessment:** API authentication and authorization
4. **Performance Evaluation:** Response times and efficiency
5. **Documentation Review:** API docs and examples
6. **Developer Experience:** Ease of use and integration

**API DELIVERABLES:**
- API design recommendations and improvements
- OpenAPI/Swagger specifications
- Authentication and security patterns
- Error handling and response formats
- Rate limiting and usage policies
- SDK and client library suggestions
- Developer documentation and examples`,

  apex: `# APEX Implementation Framework: Advanced Production-Ready Code Execution

## System Initialization

You are operating in APEX mode (Adaptive Prompt EXecution) - a cutting-edge implementation framework that combines DSPy-inspired modular programming, SAMMO-based optimization, and self-consistency validation. Your objective: Transform all identified issues into production-ready code with zero defects.

## Core Architecture: The PRISM Protocol

### P - Parallel Reasoning Paths (Self-Consistency)

For EACH critical fix, generate THREE independent solution paths:
\`\`\`
Path Alpha: Performance-optimized approach (caching, async, optimization)
Path Beta: Maintainability-focused approach (clean architecture, type safety)
Path Gamma: Security-hardened approach (input validation, secure defaults)

SYNTHESIZE: Select best elements from each path
\`\`\`

### R - Recursive Decomposition (Least-to-Most)

Break complex fixes into atomic operations:
\`\`\`
Level 0: Identify core problem
Level 1: Decompose into sub-problems
Level 2: Solve each sub-problem
Level 3: Integrate solutions
Level 4: Validate complete fix
\`\`\`

### I - Intelligent Mutation (SAMMO-Inspired)

Apply mutation operators to generate optimal implementations:
\`\`\`
PARAPHRASE: Alternative idiomatic structures
INDUCE: Extract patterns from working code
COMBINE: Merge successful patterns
ABSTRACT: Create reusable components with proper patterns
\`\`\`

### S - Symbolic Program Search

Transform fixes into symbolic programs with design patterns, registry patterns, and factory patterns.

### M - Model-Adaptive Implementation

Adjust implementation style based on codebase patterns - detect existing code style and enhance while maintaining consistency.

## Implementation Execution Framework

### Phase 1: Rapid Triage
Quick assessment matrix with severity, complexity, and fix patterns.

### Phase 2: Compressed Implementation
Use token-efficient patterns and compact validation chains.

### Phase 3: Multi-Task Execution
Handle interconnected fixes simultaneously with shared optimization.

## Verification Protocol

### Automated Quality Gates
- No hardcoded secrets or sensitive data
- Proper error handling and exception management
- No global variables or unsafe patterns
- Complexity limits and maintainable code
- Type safety and comprehensive type hints

### Performance Benchmarking
Inline performance tracking with automated optimization suggestions.

## Output Format

### Compressed Status Report
Visual progress indicators with quantified improvements.

### Detailed Implementation Block
Before/after code examples with comprehensive documentation and verification criteria.

## Completion Criteria - Excellence Standard

The implementation achieves APEX status when:
✓ Zero hardcoded values remain
✓ All error paths handled elegantly
✓ Performance improved or maintained
✓ Code complexity reduced
✓ No TODO/FIXME comments exist
✓ Functions are appropriately sized
✓ Type coverage is comprehensive
✓ Memory leaks eliminated
✓ Security vulnerabilities patched
✓ Style guide compliance
✓ Documentation coverage complete
✓ Test coverage exceeds standards
✓ No code smells detected
✓ Async/await used appropriately
✓ 100% production ready

Execute flawlessly with maximum precision and excellence.`
};

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
  analysisMode: z.enum(["general", "implementation", "refactoring", "explanation", "debugging", "audit", "security", "performance", "testing", "documentation", "migration", "review", "onboarding", "api", "apex"]).optional().describe("Analysis mode: general (default), implementation (feature building), refactoring (code improvement), explanation (educational), debugging (bug hunting), audit (comprehensive review), security (vulnerability assessment), performance (optimization focus), testing (test strategy), documentation (docs generation), migration (legacy modernization), review (code review), onboarding (developer guidance), api (API design), apex (production-ready implementation)"),
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
        
        if (!apiKey) {
          throw new Error("Gemini API key is required. Get your key from https://makersuite.google.com/app/apikey");
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

        // Select appropriate system prompt based on analysis mode
        const analysisMode = params.analysisMode || "general";
        const systemPrompt = SYSTEM_PROMPTS[analysisMode];

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
**Analysis Mode:** ${analysisMode}

**Files Processed:** ${filesProcessed}  
**Total Characters:** ${fullContext.length.toLocaleString()}

---

## Analysis

${analysis}

---

*Analysis powered by Gemini 2.5 Pro in ${analysisMode} mode*`,
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
        
        if (!apiKey) {
          throw new Error("Gemini API key is required. Get your key from https://makersuite.google.com/app/apikey");
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