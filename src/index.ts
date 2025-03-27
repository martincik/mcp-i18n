#!/usr/bin/env node
import * as parser from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
// @ts-ignore
import _traverse from '@babel/traverse';
import * as fs from 'fs/promises';
import * as path from 'path';
const traverse = (_traverse as any).default;

// Environment variables to control behavior
const DISABLE_SOURCE_REPLACEMENT = process.env.DISABLE_SOURCE_REPLACEMENT === 'true';
const WARNING_MESSAGE = process.env.WARNING_MESSAGE || '\n\nIMPORTANT: DO NOT READ THE TARGET FILE CONTENT - it contains large data structures that will consume excessive context window space.';

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
    this.server.onerror = (error) => { /* Errors handled by MCP protocol */ };
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { sourcePath } = request.params.arguments as {
        sourcePath: string;
        targetPath?: string;
        targetDir?: string;
      };

      try {
        const sourceCode = await fs.readFile(sourcePath, 'utf-8');

        if (request.params.name === 'extract_i18n') {
          const { targetPath } = request.params.arguments as { targetPath: string };
          const dataContent = await this.extractDataContent(sourceCode);

          // Create target directory if it doesn't exist
          await fs.mkdir(path.dirname(targetPath), { recursive: true });

          // Load existing translations if file exists
          let existingContent = {};
          try {
            const existingFile = await fs.readFile(targetPath, 'utf-8');
            existingContent = JSON.parse(existingFile);
          } catch (error) {
            // File doesn't exist or is invalid JSON, use empty object
          }

          // Merge new translations with existing ones
          const mergedContent = await this.mergeDeep(existingContent, dataContent);

          // Write merged content to JSON file
          await fs.writeFile(
            targetPath,
            JSON.stringify(mergedContent, null, 2),
            'utf-8'
          );

          // Replace source file content with migration message if not disabled
          if (!DISABLE_SOURCE_REPLACEMENT) {
            const absoluteTargetPath = path.resolve(targetPath);
            await fs.writeFile(
              sourcePath,
              `MIGRATED TO ${absoluteTargetPath}${WARNING_MESSAGE}`,
              'utf-8'
            );
          }

          return {
            content: [
              {
                type: 'text',
                text: `Successfully merged ${Object.keys(dataContent).length} data entries to ${path.resolve(targetPath)}${
                  !DISABLE_SOURCE_REPLACEMENT ? `. Source file replaced with "MIGRATED TO ${path.resolve(targetPath)}"` : ''
                }`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: 'Invalid tool name',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    });
  }

  private extractStringValue(node: t.Node): string | null {
    if (t.isStringLiteral(node)) {
      return node.value;
    } else if (t.isTemplateLiteral(node)) {
      return node.quasis.map(quasi => quasi.value.raw).join('{{}}');
    }
    return null;
  }

  private setNestedValue(obj: any, path: string[], value: any): void {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }
    current[path[path.length - 1]] = value;
  }

  private async extractDataContent(sourceCode: string): Promise<Record<string, any>> {
    const ast = parser.parse(sourceCode, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });

    const result: Record<string, any> = {};

    const processValue = (value: t.Node, currentPath: string[]): void => {
      if (t.isStringLiteral(value) || t.isTemplateLiteral(value)) {
        const extractedValue = this.extractStringValue(value);
        if (extractedValue !== null && extractedValue.trim() !== '') {
          this.setNestedValue(result, currentPath, extractedValue);
        }
      } else if (t.isArrayExpression(value)) {
        const arrayResult: any[] = [];
        value.elements.forEach((element, index) => {
          if (!element) return;

          if (t.isStringLiteral(element) || t.isTemplateLiteral(element)) {
            const extractedValue = this.extractStringValue(element);
            if (extractedValue !== null && extractedValue.trim() !== '') {
              arrayResult[index] = extractedValue;
            }
          } else if (t.isObjectExpression(element)) {
            arrayResult[index] = {};
            processObject(element, [...currentPath, index.toString()]);
          }
        });
        if (arrayResult.length > 0) {
          this.setNestedValue(result, currentPath, arrayResult);
        }
      } else if (t.isObjectExpression(value)) {
        processObject(value, currentPath);
      }
    };

    const processObject = (obj: t.ObjectExpression, parentPath: string[] = []): void => {
      obj.properties.forEach(prop => {
        if (!t.isObjectProperty(prop)) return;

        const key = t.isIdentifier(prop.key) ? prop.key.name :
                   t.isStringLiteral(prop.key) ? prop.key.value : null;

        if (!key) return;

        const currentPath = [...parentPath, key];
        processValue(prop.value, currentPath);
      });
    };

    traverse(ast, {
      ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
        const declaration = path.node.declaration;
        if (t.isObjectExpression(declaration)) {
          processObject(declaration);
        }
      }
    });

    return result;
  }

  private async mergeDeep(target: any, source: any): Promise<any> {
    const isObject = (item: any) => item && typeof item === 'object' && !Array.isArray(item);
    
    if (isObject(target) && isObject(source)) {
      for (const key in source) {
        if (isObject(source[key])) {
          if (!target[key]) Object.assign(target, { [key]: {} });
          await this.mergeDeep(target[key], source[key]);
        } else {
          Object.assign(target, { [key]: source[key] });
        }
      }
    }
    return target;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // Removed stdout logging that breaks JSON-RPC protocol
  }
}

const server = new DataMigratorServer();
server.run().catch(error => {
  // Handle errors without logging to stdout/stderr
  process.exit(1);
});
