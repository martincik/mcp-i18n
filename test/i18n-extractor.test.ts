import * as fs from 'fs/promises';
import * as path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { DataMigratorServer } from '../src/index.js'; // Add .js extension for ESM

// Get current file path in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define our own CallToolRequest interface for testing that matches what the MPC SDK expects
interface CallToolRequest {
    params: {
        type: 'call_tool',
        name: string,
        arguments: Record<string, unknown>,
    };
    method: 'tools/call';
    id?: string;
    time?: string;
    sender?: { role: string };
}

// Helper to create mock CallToolRequest objects
const mockCallToolRequest = (name: string, args: any): CallToolRequest => ({
    method: 'tools/call',
    id: `test-req-${Date.now()}`,
    time: new Date().toISOString(),
    sender: { role: 'user' },
    params: {
        type: 'call_tool',
        name: name,
        arguments: args,
    }
});

const TEST_DIR = path.resolve(__dirname);
const INPUT_DIR = path.join(TEST_DIR, 'input');
const OUTPUT_DIR = path.join(TEST_DIR, 'output');

// Store original env values
const originalEnv = { ...process.env };

describe('i18n Extractor Tool', () => {
    let serverInstance: DataMigratorServer;
    let handler: (request: CallToolRequest) => Promise<any>; // Handler function type

    beforeAll(async () => {
        // Ensure directories exist (might have been created by previous steps)
        await fs.mkdir(INPUT_DIR, { recursive: true });
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        
        // Create base merge file
        await fs.writeFile(path.join(OUTPUT_DIR, 'merge_existing.json'), JSON.stringify({
            existingKey: "Existing Value",
            anotherKey: "Another Value",
            nested: {
                existing: true
            }
        }, null, 2), 'utf-8');

        // Instantiate server ONCE and get handler
        serverInstance = new DataMigratorServer();
        
        // Get the handler using the direct method
        handler = serverInstance.getCallToolHandler();
    });

    beforeEach(async () => {
        // Reset env variables before each test
        process.env = { ...originalEnv };
        // Clean up potentially generated output files before each test
        try {
            const files = await fs.readdir(OUTPUT_DIR);
            for (const file of files) {
                if (file !== 'merge_existing.json') { // Keep the base file
                    await fs.unlink(path.join(OUTPUT_DIR, file));
                }
            }
        } catch (error: any) {
             if (error.code !== 'ENOENT') throw error; // Ignore if dir doesn't exist yet
        }
        
        // Create test input files
        await fs.mkdir(INPUT_DIR, { recursive: true });
        
        // Simple key-value object
        await fs.writeFile(path.join(INPUT_DIR, 'simple.js'), `
export default {
    key: "Simple Value",
    anotherKey: "Another simple value"
};
`, 'utf-8');

        // Complex object with nested structures, arrays, etc.
        await fs.writeFile(path.join(INPUT_DIR, 'complex.js'), `
export default {
    greeting: 'Hello, {{name}}!',
    farewell: 'Goodbye!',
    level: 1,
    active: true,
    nested: {
        message: "Nested Message",
        deeper: {
            value: 123
        },
        emptyObj: {}
    },
    items: [
        "Item 1",
        { id: 1, text: "Item Object" },
        'Template {{value}}',
        null,
        ["Sub", "Array"],
        undefined,
        void 0
    ],
    emptyArray: []
};
`, 'utf-8');

        // File for merge test
        await fs.writeFile(path.join(INPUT_DIR, 'merge_add.js'), `
export default {
    newKey: "New Value",
    anotherNewKey: "Another New Value",
    items: ["New Item 1", "New Item 2"]
};
`, 'utf-8');

        // File for testing no replacement
        await fs.writeFile(path.join(INPUT_DIR, 'no_replace.js'), `
export default { key: "No Replace Value" };
`, 'utf-8');

        // File exported from variable
        await fs.writeFile(path.join(INPUT_DIR, 'var_export.js'), `
const data = { exportedKey: "Exported from variable" };
export default data;
`, 'utf-8');

        // File with no default export
        await fs.writeFile(path.join(INPUT_DIR, 'no_export.js'), `
// Just a comment, no exports
`, 'utf-8');
    });

     afterAll(async () => {
        // Restore original env
        process.env = { ...originalEnv };
        // Optional: Clean up all test files/dirs after suite runs
        // await fs.rm(INPUT_DIR, { recursive: true, force: true });
        // await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
    });

    test('should extract simple key-value pairs', async () => {
        const sourcePath = path.join(INPUT_DIR, 'simple.js');
        const targetPath = path.join(OUTPUT_DIR, 'simple.json');
        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });

        const response = await handler(request);
        expect(response.content[0].text).toContain('Successfully merged 2 top-level entries'); // key, anotherKey

        const outputJson = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
        expect(outputJson).toEqual({
            key: "Simple Value",
            anotherKey: "Another simple value"
        });

        const sourceContent = await fs.readFile(sourcePath, 'utf-8');
        const expectedMigrationPath = path.resolve(targetPath);
        expect(sourceContent).toContain(`MIGRATED TO ${expectedMigrationPath}`);
    });

     test('should extract complex structures (nested, array, template, types)', async () => {
        const sourcePath = path.join(INPUT_DIR, 'complex.js');
        const targetPath = path.join(OUTPUT_DIR, 'complex.json');
        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });

        const response = await handler(request);
        // greeting, farewell, level, active, nested, items, emptyArray = 7 entries
        expect(response.content[0].text).toContain('Successfully merged 7 top-level entries');

        const outputJson = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
        expect(outputJson).toEqual({
            greeting: 'Hello, {{name}}!',
            farewell: 'Goodbye!',
            level: 1,
            active: true,
            nested: {
                message: "Nested Message",
                deeper: {
                    value: 123
                },
                emptyObj: {}
            },
            items: [
                "Item 1",
                { id: 1, text: "Item Object" },
                'Template {{value}}',
                null,
                ["Sub", "Array"],
                null, // undefined becomes null
                null // void 0 becomes null
            ],
            emptyArray: []
        });

        const sourceContent = await fs.readFile(sourcePath, 'utf-8');
        const expectedMigrationPath = path.resolve(targetPath);
        expect(sourceContent).toContain(`MIGRATED TO ${expectedMigrationPath}`);
    });

    test('should merge with existing JSON file', async () => {
        const sourcePath = path.join(INPUT_DIR, 'merge_add.js');
        // Target the existing file
        const targetPath = path.join(OUTPUT_DIR, 'merge_existing.json');
        // Make a backup of the original target to restore later if needed, or check content carefully
        const originalTargetContent = await fs.readFile(targetPath, 'utf-8');

        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });

        try {
            const response = await handler(request);
            // newKey, anotherNewKey, items = 3 entries
            expect(response.content[0].text).toContain('Successfully merged 3 top-level entries');

            const outputJson = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
            expect(outputJson).toEqual({
                // From existing:
                existingKey: "Existing Value",
                // From new (merged/overwritten):
                anotherKey: "Another Value",
                newKey: "New Value",
                anotherNewKey: "Another New Value",
                items: ["New Item 1", "New Item 2"],
                nested: {
                    existing: true
                }
            });

            const sourceContent = await fs.readFile(sourcePath, 'utf-8');
            const expectedMigrationPath = path.resolve(targetPath);
            expect(sourceContent).toContain(`MIGRATED TO ${expectedMigrationPath}`);
        } finally {
             // Restore original merge target file if needed for other tests
             // await fs.writeFile(targetPath, originalTargetContent, 'utf-8');
        }
    });

    test('should not replace source file if DISABLE_SOURCE_REPLACEMENT is true', async () => {
        const sourcePath = path.join(INPUT_DIR, 'no_replace.js');
        const targetPath = path.join(OUTPUT_DIR, 'no_replace.json');
        const originalSourceContent = await fs.readFile(sourcePath, 'utf-8');

        // Set env var for this test
        process.env.DISABLE_SOURCE_REPLACEMENT = 'true';

        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });
        const response = await handler(request);

        expect(response.content[0].text).toContain('Successfully merged 1 top-level entries');
        expect(response.content[0].text).not.toContain('Source file replaced');

        const outputJson = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
        expect(outputJson).toEqual({ key: "No Replace Value" });

        // Verify source file content is unchanged
        const currentSourceContent = await fs.readFile(sourcePath, 'utf-8');
        expect(currentSourceContent).toEqual(originalSourceContent);

        // Clean up env var setting for subsequent tests (done in beforeEach)
    });

    test('should extract from variable exported by default', async () => {
        const sourcePath = path.join(INPUT_DIR, 'var_export.js');
        const targetPath = path.join(OUTPUT_DIR, 'var_export.json');
        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });

        const response = await handler(request);
        expect(response.content[0].text).toContain('Successfully merged 1 top-level entries'); // exportedKey

        const outputJson = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
        expect(outputJson).toEqual({
            exportedKey: "Exported from variable"
        });

        const sourceContent = await fs.readFile(sourcePath, 'utf-8');
        const expectedMigrationPath = path.resolve(targetPath);
        expect(sourceContent).toContain(`MIGRATED TO ${expectedMigrationPath}`);
    });

     test('should handle files with no default export gracefully', async () => {
        const sourcePath = path.join(INPUT_DIR, 'no_export.js');
        const targetPath = path.join(OUTPUT_DIR, 'no_export.json');
        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });

        const response = await handler(request);
        // Expect a message indicating no data was extracted
        expect(response.content[0].text).toContain('No data extracted from');
        expect(response.content[0].text).toContain('Target file');
        expect(response.content[0].text).toContain('not modified');

        // Ensure target file was NOT created
        try {
            await fs.access(targetPath);
            fail('Target file should not exist');
        } catch (error) {
            // Expected - file should not exist
        }

        // Source file should NOT be replaced if no data was extracted
        const sourceContent = await fs.readFile(sourcePath, 'utf-8');
        expect(sourceContent).not.toContain('MIGRATED TO');
    });

    test('should handle non-existent source file', async () => {
        const sourcePath = path.join(INPUT_DIR, 'non_existent.js');
        const targetPath = path.join(OUTPUT_DIR, 'non_existent.json');
        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });

        const response = await handler(request);
        expect(response.content[0].text).toMatch(/Error processing .*non_existent.js: .*ENOENT.*/i); // Check for ENOENT error

         // Ensure target file was NOT created
         try {
            await fs.access(targetPath);
            fail('Target file should not exist');
        } catch (error) {
            // Expected - file should not exist
        }
    });

    test('should extract t() function calls from React components', async () => {
        // Create test input file with React component
        const testReactCode = `
'use client'

import { useTranslations } from 'next-intl'

export function MyComponent() {
  const t = useTranslations('pages.mypage')
  
  return (
    <div>
      <h1>{t('title') || 'Default Title'}</h1>
      <p>{t('description') || 'This is a default description'}</p>
      <button>{t('button_label')}</button>
    </div>
  )
}
`;
        
        const sourcePath = path.join(INPUT_DIR, 'react_component.tsx');
        const targetPath = path.join(OUTPUT_DIR, 'react_translations.json');
        
        // Write test file
        await fs.writeFile(sourcePath, testReactCode, 'utf-8');
        
        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });
        const response = await handler(request);
        
        expect(response.content[0].text).toContain('Successfully merged 3 top-level entries'); // 3 translation keys
        
        const outputJson = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
        expect(outputJson).toEqual({
            'pages.mypage.title': 'Default Title',
            'pages.mypage.description': 'This is a default description',
            'pages.mypage.button_label': '' // No default value
        });
    });

    test('should extract t() function calls from AutomationsPageForm component', async () => {
        // Create test input file with AutomationsPageForm component (simplified version)
        const automationsPageFormCode = `
'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { toast } from 'sonner'

export function AutomationsPageForm() {
  const t = useTranslations('pages.agents.new.steps.automations')
  
  const handleAction = () => {
    toast.success(
      t('automation_created') || 'Automation created successfully'
    )
  }
  
  const updateAction = () => {
    toast.success(
      t('automation_updated') || 'Automation updated successfully'
    )
  }
  
  const validateForm = () => {
    if (someCondition) {
      toast.error(
        t('client_automationType_required') ||
          'Please select a client and automation type to continue'
      )
      setError('automationType', {
        message:
          t('automationType.validation.required') ||
          'Please select an automation type to continue'
      })
    }
    
    if (anotherCondition) {
      toast.error(
        t('templateId.validation.required') || 'Please select a template'
      )
    }
  }
  
  return (
    <div>
      <h1>
        {isEditing ? t('edit_automation') : t('new_automation')}
      </h1>
    </div>
  )
}
`;
        
        const sourcePath = path.join(INPUT_DIR, 'automations_page_form.tsx');
        const targetPath = path.join(OUTPUT_DIR, 'automations_translations.json');
        
        // Write test file
        await fs.writeFile(sourcePath, automationsPageFormCode, 'utf-8');
        
        const request = mockCallToolRequest('extract_i18n', { sourcePath, targetPath });
        const response = await handler(request);
        
        expect(response.content[0].text).toContain('Successfully merged 7 top-level entries'); // 7 translation keys
        
        const outputJson = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
        expect(outputJson).toEqual({
            'pages.agents.new.steps.automations.automation_created': 'Automation created successfully',
            'pages.agents.new.steps.automations.automation_updated': 'Automation updated successfully',
            'pages.agents.new.steps.automations.client_automationType_required': 'Please select a client and automation type to continue',
            'pages.agents.new.steps.automations.automationType.validation.required': 'Please select an automation type to continue',
            'pages.agents.new.steps.automations.templateId.validation.required': 'Please select a template',
            'pages.agents.new.steps.automations.edit_automation': '',
            'pages.agents.new.steps.automations.new_automation': ''
        });
    });

}); 