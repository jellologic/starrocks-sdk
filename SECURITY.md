# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this package, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email **security@jellologic.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. You will receive a response within 48 hours
4. A fix will be released as a patch version as soon as possible

## Security Measures

This SDK implements the following security practices:

- **SQL identifier validation**: All database/table names are validated against `^[a-zA-Z_][a-zA-Z0-9_]*$`
- **No credential exposure**: Credentials are never included in error messages or logs
- **Input validation**: All user-provided options are validated before use
- **Dependency pinning**: CI uses `--frozen-lockfile` to prevent supply chain attacks
- **Tagged errors**: All errors use Effect's `Schema.TaggedError` for safe, typed error handling
