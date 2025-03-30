# MCP I18n Extractor

A Model Context Protocol (MCP) tool for extracting i18n strings from JavaScript/TypeScript code into JSON files.

## Features

- Extracts i18n strings from direct object exports (`export default { ... }`)
- Preserves nested objects and arrays
- Handles template strings with variable interpolation
- Supports various data types (strings, numbers, booleans, null, undefined)
- Merges with existing JSON files when present
- Replaces source files with a migration message (configurable)

## Installation

```bash
npm install @access-intelligence/mcp-i18n
```

## Usage with MCP

When used via MCP, the tool offers a single operation:

- `extract_i18n`: Extract i18n strings from source code to a JSON file

### Example

```
extract_i18n(
  sourcePath: "/path/to/translations.js",
  targetPath: "/path/to/output.json"
)
```

## Environment Variables

- `DISABLE_SOURCE_REPLACEMENT`: Set to 'true' to prevent replacement of source files after extraction
- `WARNING_MESSAGE`: Customize the warning message added to replaced source files

## Testing

```bash
npm test
```

## License

MIT
