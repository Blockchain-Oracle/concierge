# Concierge

Autonomous AI agent for Mantle DeFi — a composable primitive consumable from any agent runtime (Vercel AI SDK, OpenAI, LangChain, Coinbase AgentKit, MCP), distributed across four surfaces: web app, MCP server (stdio-first), Claude Agent Skill, and npm SDK.

The user sets a plain-English goal; the agent runs `plan → simulate → propose → execute → record` across 7 Mantle protocols (Aave V3, Mantle DEXes, Ethena sUSDe, Ondo USDY, mETH staking, Li.Fi bridging, ERC-8004) with reputation attested per tick.

Setup instructions in `story-200-readme-finalize`. Architecture in [`docs/architecture.md`](docs/architecture.md) (19 ADRs). Story-by-story execution map in [`docs/sprint-status.yaml`](docs/sprint-status.yaml) (110 stories across 16 epics).

License: MIT.
