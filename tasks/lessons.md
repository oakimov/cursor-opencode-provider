# Lessons index

Lessons explain past failures and point to their guards. Current requirements
belong in [AGENTS.md](../AGENTS.md); operator instructions belong in [docs](../docs/).

| Read | Covers |
|------|--------|
| [OpenCode general](lessons/opencode.md) | Investigation, protocol, sessions, tools, planning, caching, storage, shell supervision, auth, testing and releases |
| [OpenCode 1.x](lessons/opencode-1.md) | Classic and 1.18 v2 plugins, hooks, patch semantics, planning and result projection |
| [OpenCode 2.x](lessons/opencode-2.md) | Plugin lifecycle, direct tools, permissions, daemon state, shell ownership and early steers |
| [Pricing](lessons/pricing.md) | Pricing source order, provider list price, Fast mode, long context, Auto, and the version-bump gate |

Read the general file and the relevant host file before changing a behavior.
Read the pricing file before changing a price.
Add a lesson beside the closest existing one; merge repeated causes and remove
superseded advice. Keep the incident and regression reference, not a transcript
or a second copy of the architecture contract. Use symbols and test names
rather than drifting source line numbers. Dated acceptance results stay in
separate private run reports.
