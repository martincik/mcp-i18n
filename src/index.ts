#!/usr/bin/env node
import * as parser from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
// @ts-ignore - Keep ignore for potential default export issue if types are ESM-only
import _traverse from '@babel/traverse';
import * as fs from 'fs/promises';
import * as path from 'path';
const traverse = (_traverse as any).default;

// Environment variable read at runtime now
const WARNING_MESSAGE = process.env.WARNING_MESSAGE || '\n\nIMPORTANT: DO NOT READ THE TARGET FILE CONTENT - it contains large data structures that will consume excessive context window space.';

// Explicit types for request arguments
interface ExtractI18nArgs {
  sourcePath: string;
  targetPath: string;
}

class DataMigratorServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-i18n',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling without stdout logging
    this.server.onerror = (error: Error) => { /* Errors handled by MCP protocol */ }; // Added Error type
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    // Cast the returned object to any to bypass type checking for MCP types
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'extract_i18n',
            description: 'Extract i18n strings from source code to a JSON file. IMPORTANT: When encountering files with i18n content embedded in code, use this tool directly instead of reading the file content first. This tool will programmatically extract all i18n strings into a structured JSON file, preserving nested objects, arrays, template variables, and formatting. This helps keep i18n strings as configuration and prevents filling up the AI context window with translation content. By default, the source file will be replaced with "MIGRATED TO <target absolute path>" and a warning message after successful extraction, making it easy to track where the data was moved to. This behaviour can be disabled by setting the DISABLE_SOURCE_REPLACEMENT environment variable to \'true\'. The warning message can be customized by setting the WARNING_MESSAGE environment variable.',
            inputSchema: {
              type: 'object',
              properties: {
                sourcePath: {
                  type: 'string',
                  description: 'Path to the source file containing i18n strings embedded in code',
                },
                targetPath: {
                  type: 'string',
                  description: 'Path where the resulting JSON file should be written',
                },
              },
              required: ['sourcePath', 'targetPath'],
            },
          },
        ],
      } as any;
    });

    // Cast the returned object to any to bypass type checking for MCP types
    this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      // Type assertion for arguments based on tool definition
      const args = request.params.arguments as unknown as ExtractI18nArgs;
      const { sourcePath } = args;

      try {
        const sourceCode = await fs.readFile(sourcePath, 'utf-8');

        if (request.params.name === 'extract_i18n') {
          const { targetPath } = args;
          const dataContent = await this.extractDataContent(sourceCode);

          // Check if extraction yielded any data
          if (Object.keys(dataContent).length === 0) {
             return {
               content: [{ type: 'text', text: `No data extracted from ${sourcePath}. Target file ${targetPath} not modified.` }],
             } as any;
          }

          // Create target directory if it doesn't exist
          await fs.mkdir(path.dirname(targetPath), { recursive: true });

          // Load existing translations if file exists
          let existingContent: Record<string, any> = {};
          try {
            const existingFileContent = await fs.readFile(targetPath, 'utf-8');
            existingContent = JSON.parse(existingFileContent);
          } catch (error: unknown) {
            const err = error as Error & { code?: string };
            // File doesn't exist or is invalid JSON, use empty object
            if (err.code !== 'ENOENT') {
                console.warn(`Warning: Could not parse existing target file ${targetPath}. Starting fresh. Error: ${err.message}`);
            }
          }

          // Merge new translations with existing ones
          const mergedContent = await this.mergeDeep(existingContent, dataContent);

          // Write merged content to JSON file
          await fs.writeFile(
            targetPath,
            JSON.stringify(mergedContent, null, 2),
            'utf-8'
          );

          // Check env var dynamically before replacing source file content
          const disableSourceReplacement = process.env.DISABLE_SOURCE_REPLACEMENT === 'true';
          if (!disableSourceReplacement) {
            const absoluteTargetPath = path.resolve(targetPath);
            await fs.writeFile(
              sourcePath,
              `MIGRATED TO ${absoluteTargetPath}${WARNING_MESSAGE}`,
              'utf-8'
            );
          }

          const successMessage = `Successfully merged ${Object.keys(dataContent).length} top-level entries to ${path.resolve(targetPath)}${
            !disableSourceReplacement ? `. Source file replaced with "MIGRATED TO ${path.resolve(targetPath)}"` : ''
          }`;

          return {
            content: [
              {
                type: 'text',
                text: successMessage,
              },
            ],
          } as any;
        }

        return {
          content: [
            {
              type: 'text',
              text: `Invalid tool name: ${request.params.name}`, // More informative message
            },
          ],
        } as any;
      } catch (error: unknown) { // Catch specific errors if possible
        const err = error as Error;
        return {
          content: [
            {
              type: 'text',
              text: `Error processing ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        } as any;
      }
    });
  }

  // --- Start Refactored Extraction Logic ---

  // Helper to process object properties into a given target object
  private processPropertyInto(prop: t.ObjectProperty, targetObject: Record<string, any>): void {
      const key = t.isIdentifier(prop.key) ? prop.key.name :
                 t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (!key) return;

      const valueNode = prop.value;
      const processedValue = this.processNodeValue(valueNode); // Use recursive processing

      // Add to targetObject only if processing yielded a non-null value
      if (processedValue !== null) {
          targetObject[key] = processedValue;
      }
  }

  // Recursive function to process any AST node into its JS equivalent
  private processNodeValue(node: t.Node | null): any { // Allow null for array elements
      if (node === null) {
          return null; // Handle null directly (e.g., from sparse arrays)
      }
      if (t.isStringLiteral(node)) {
          // Return raw value; empty strings are valid JSON values
          return node.value;
      } else if (t.isTemplateLiteral(node)) {
          // Return joined value; treat empty result as empty string
          return node.quasis.map(quasi => quasi.value.raw).join('{{}}');
      } else if (t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
          return node.value;
      } else if (t.isNullLiteral(node)) {
          return null;
      } else if (t.isObjectExpression(node)) {
          const objResult: Record<string, any> = {};
          node.properties.forEach(prop => {
              if (t.isObjectProperty(prop)) {
                  this.processPropertyInto(prop, objResult);
              }
              // Ignore SpreadElement, ObjectMethod etc. for now
          });
          // Return object even if empty, as empty objects are valid JSON
          return objResult;
      } else if (t.isArrayExpression(node)) {
          const arrayResult: any[] = [];
          node.elements.forEach(element => {
              // Process element recursively and push result
              // element can be null for sparse arrays e.g., [1,,3]
              arrayResult.push(this.processNodeValue(element));
          });
          // Return array even if empty
          return arrayResult;
      } else if (t.isIdentifier(node) && node.name === 'undefined') {
           return null; // Represent undefined as null in JSON
      } else if (t.isUnaryExpression(node) && node.operator === 'void' && t.isNumericLiteral(node.argument) && node.argument.value === 0) {
           return null; // Handle `void 0` as null/undefined
      }

      // Return null for unhandled node types (e.g., FunctionExpression, JSXElement)
      // Consider logging a warning for unexpected types if needed during debugging
      // console.warn(`Unhandled AST node type during extraction: ${node.type}`);
      return null;
  }

  // Refactored extractDataContent using the new recursive processor
  private async extractDataContent(sourceCode: string): Promise<Record<string, any>> {
      const ast = parser.parse(sourceCode, {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'], // Add other plugins if needed ('classProperties', 'objectRestSpread', etc.)
          errorRecovery: true, // Attempt to parse even with minor errors
      });

      let extractedData: Record<string, any> | null = null;

      // First, try to extract t() function calls from React components
      const translationCalls = this.extractTranslationCalls(ast);
      if (Object.keys(translationCalls).length > 0) {
          return translationCalls;
      }

      // If no translation calls found, fall back to the original implementation
      traverse(ast, {
          ExportDefaultDeclaration: (path: NodePath<t.ExportDefaultDeclaration>) => {
              const declaration = path.node.declaration;

              // Handle direct object export: export default { ... }
              if (t.isObjectExpression(declaration)) {
                  const processed = this.processNodeValue(declaration);
                  if (processed && typeof processed === 'object' && !Array.isArray(processed)) {
                      extractedData = processed;
                  }
                  path.stop(); // Stop traversal once default export object is processed
              }
              // Handle export default identifier pointing to an object
              else if (t.isIdentifier(declaration)) {
                 const binding = path.scope.getBinding(declaration.name);
                 if (binding && t.isVariableDeclarator(binding.path.node) && binding.path.node.init && t.isObjectExpression(binding.path.node.init)) {
                      const processed = this.processNodeValue(binding.path.node.init);
                      if (processed && typeof processed === 'object' && !Array.isArray(processed)) {
                         extractedData = processed;
                      }
                      path.stop();
                 }
              }
          }
      });

      return extractedData || {}; // Return extracted data or empty object
  }

  // Extract t() function calls from React components
  private extractTranslationCalls(ast: t.File): Record<string, any> {
      const translations: Record<string, any> = {};
      let translationNamespace: string | null = null;
      
      // First, try to identify the namespace used with useTranslations
      traverse(ast, {
          CallExpression(path: NodePath<t.CallExpression>) {
              if (
                  t.isIdentifier(path.node.callee) && 
                  path.node.callee.name === 'useTranslations' &&
                  path.node.arguments.length > 0 &&
                  t.isStringLiteral(path.node.arguments[0])
              ) {
                  translationNamespace = path.node.arguments[0].value;
              }
          }
      });
      
      // Extract t() function calls
      traverse(ast, {
          CallExpression(path: NodePath<t.CallExpression>) {
              if (
                  t.isIdentifier(path.node.callee) && 
                  path.node.callee.name === 't' &&
                  path.node.arguments.length > 0 &&
                  t.isStringLiteral(path.node.arguments[0])
              ) {
                  const key = path.node.arguments[0].value;
                  let defaultValue = null;
                  
                  // Check for default value in logical OR expression: t('key') || 'Default value'
                  if (
                      path.parent && 
                      t.isLogicalExpression(path.parent) && 
                      path.parent.operator === '||' &&
                      path.parent.left === path.node &&
                      t.isStringLiteral(path.parent.right)
                  ) {
                      defaultValue = path.parent.right.value;
                  }
                  
                  // Add namespace prefix if available
                  const fullKey = translationNamespace ? `${translationNamespace}.${key}` : key;
                  
                  // Only add default value if it exists
                  if (defaultValue !== null) {
                      translations[fullKey] = defaultValue;
                  } else {
                      translations[fullKey] = "";  // Empty string for keys without default values
                  }
              }
          }
      });
      
      return translations;
  }

  // --- End Refactored Extraction Logic ---

  // Deep merge function (unchanged, seems okay)
  private async mergeDeep(target: any, source: any): Promise<any> {
    const isObject = (item: any): item is Record<string, any> => item && typeof item === 'object' && !Array.isArray(item);

    let output = Object.assign({}, target); // Don't modify target directly
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] }); // Source is new object
          } else {
             output[key] = this.mergeDeep(target[key], source[key]); // Recurse
          }
        } else if (Array.isArray(source[key]) && Array.isArray(target[key])) {
           // Optional: Basic array merge (concatenate unique simple values) - adjust if needed
           // For simple concatenation: output[key] = target[key].concat(source[key]);
           // For overwrite (current behavior): Object.assign(output, { [key]: source[key] });
           // Let's stick to overwrite for simplicity unless specific merge is required
           Object.assign(output, { [key]: source[key] });
        }
        else {
          Object.assign(output, { [key]: source[key] }); // Overwrite non-object/array properties
        }
      });
    } else {
       // If target is not an object, source completely replaces it (handles initial case)
       output = source;
    }
    return output;
  }

  // Added for testing - get the handler for the given schema
  getHandlerForTesting(schema: string): Function | null {
    // Use type assertion to access private properties
    const serverWithHandlers = this.server as any;
    if (!serverWithHandlers || !serverWithHandlers.requestHandlers || !serverWithHandlers.requestHandlers.get) {
      return null;
    }
    const handler = serverWithHandlers.requestHandlers.get(schema);
    return handler ? handler.bind(this) : null;
  }

  // Added for testing - direct access to handler functions
  getCallToolHandler(): (request: CallToolRequest) => Promise<any> {
    // This directly implements the handler logic without relying on internal server structure
    return async (request: CallToolRequest) => {
      const args = request.params.arguments as unknown as ExtractI18nArgs;
      const { sourcePath } = args;

      try {
        const sourceCode = await fs.readFile(sourcePath, 'utf-8');

        if (request.params.name === 'extract_i18n') {
          const { targetPath } = args;
          const dataContent = await this.extractDataContent(sourceCode);

          // Check if extraction yielded any data
          if (Object.keys(dataContent).length === 0) {
             return {
               content: [{ type: 'text', text: `No data extracted from ${sourcePath}. Target file ${targetPath} not modified.` }],
             } as any;
          }

          // Create target directory if it doesn't exist
          await fs.mkdir(path.dirname(targetPath), { recursive: true });

          // Load existing translations if file exists
          let existingContent: Record<string, any> = {};
          try {
            const existingFileContent = await fs.readFile(targetPath, 'utf-8');
            existingContent = JSON.parse(existingFileContent);
          } catch (error: unknown) {
            const err = error as Error & { code?: string };
            // File doesn't exist or is invalid JSON, use empty object
            if (err.code !== 'ENOENT') {
                console.warn(`Warning: Could not parse existing target file ${targetPath}. Starting fresh. Error: ${err.message}`);
            }
          }

          // Merge new translations with existing ones
          const mergedContent = await this.mergeDeep(existingContent, dataContent);

          // Write merged content to JSON file
          await fs.writeFile(
            targetPath,
            JSON.stringify(mergedContent, null, 2),
            'utf-8'
          );

          // Check env var dynamically before replacing source file content
          const disableSourceReplacement = process.env.DISABLE_SOURCE_REPLACEMENT === 'true';
          if (!disableSourceReplacement) {
            const absoluteTargetPath = path.resolve(targetPath);
            await fs.writeFile(
              sourcePath,
              `MIGRATED TO ${absoluteTargetPath}${WARNING_MESSAGE}`,
              'utf-8'
            );
          }

          const successMessage = `Successfully merged ${Object.keys(dataContent).length} top-level entries to ${path.resolve(targetPath)}${
            !disableSourceReplacement ? `. Source file replaced with "MIGRATED TO ${path.resolve(targetPath)}"` : ''
          }`;

          return {
            content: [
              {
                type: 'text',
                text: successMessage,
              },
            ],
          } as any;
        }

        return {
          content: [
            {
              type: 'text',
              text: `Invalid tool name: ${request.params.name}`, // More informative message
            },
          ],
        } as any;
      } catch (error: unknown) { // Catch specific errors if possible
        const err = error as Error;
        return {
          content: [
            {
              type: 'text',
              text: `Error processing ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        } as any;
      }
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // No console logs here
  }
}

// Export the class for testing purposes
export { DataMigratorServer };

// Only run the server if the script is executed directly (ESM version)
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new DataMigratorServer();
  server.run().catch(error => {
    // Log fatal errors to stderr only if run directly, not during tests
    console.error(`Fatal server error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
