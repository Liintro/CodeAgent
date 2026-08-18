# Engineering Rules

These rules apply by default when implementing, reviewing, or refactoring code. Follow the repository's existing conventions and the user's explicit task scope. Do not silently change the scope. Runtime permissions and user approvals are enforced by the host, not by these instructions.

## Scope and complexity

- Do not add complexity for speculative races, security edge cases, or failures that are extremely unlikely in the actual use case.
- If an additional safeguard seems necessary, first explain the concrete failure scenario, how likely it is (a qualitative estimate is fine), and the implementation cost (rough code size and maintenance impact). Obtain approval before implementing it.
- In an unattended run, do not silently add such optional safeguards; leave a concise proposal for review instead.
- Make only changes required for the requested task. Do not quietly expand the refactor, dependency, or feature scope.

## Input validation and code structure

- Validate untrusted external input once at the entry boundary. Pass already-validated, typed values inward; do not repeat defensive checks at every internal layer.
- Do not extract a helper used only once unless it encapsulates genuinely complex logic or represents a clear, meaningful concept.
- Keep the main function focused on the normal execution path. Move validation and implementation details into small, well-named functions below it when that improves clarity.
- Write comments only for non-obvious constraints, surprising behavior, or important design rationale. Do not narrate self-evident code.
- Never hand-edit generated files. Change the source of generation and regenerate them.

## Testing and repository workflow

- Test the real implementation and observable behavior. Do not copy production logic into tests or create a second implementation as the expected result.
- Prefer integration with real components; use mocks only when the real dependency is impractical or non-deterministic.
- Follow the repository's established commands, tools, dependencies, branch practices, and development workflow. Do not introduce a new tool or process unless the task requires it and the reason is explicit.
- Run the relevant build or tests after changes. Report what actually ran and any remaining unverified work. Do not claim success without verification.

## UI and UX

- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- Keep interfaces focused on the user's primary task. Prefer clear hierarchy, meaningful controls, and concise status text over explanatory clutter.

## Scope of these rules

- Apply these rules to both main-agent and delegated-agent implementation work.
- For cross-folder tasks, respect each target repository's instructions and existing workflow; do not assume one repository's conventions apply to every root.
- These are coding preferences, not an operating-system sandbox or substitute for the host's tool-permission policy.
- Do not rewrite these rules automatically through memory or RSI. Propose changes for explicit review.
