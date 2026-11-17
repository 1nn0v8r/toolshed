# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repo's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion.

Include:

- the affected tool and version
- what an attacker could do
- steps to reproduce, or a proof of concept

You should get a first response within 7 days. Once a fix is released, the report is credited in the tool's changelog unless you prefer to stay anonymous.

## Supported versions

Only the latest released version of each tool receives security fixes.

## Scope notes

Some tools are powerful by design. For example, dev-context-mcp over stdio can run shell commands as the local user, because it only serves the assistant on your own machine. Reports are most useful when they show a tool doing something outside its documented security model, such as escaping its path sandbox, bypassing HTTP authentication or capability tiers, or reaching private network addresses through its SSRF guard.
