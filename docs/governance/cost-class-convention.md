# Cost Class Convention

## Purpose

This document establishes the convention for classifying AI agents by cost class in the moklabs Paperclip system. The classification enables rename-proof, data-driven governor exemptions based on `metadata.costClass` rather than name matching.

## Background

Previously, the system used name-based matching to determine which agents were exempt from certain governor policies. This approach had several limitations:

- **Fragility**: Agent renames would break policy exemptions
- **Maintenance**: Required updating policy rules when agents were renamed
- **Inconsistency**: Different policies could have different name patterns

The new approach uses a dedicated `metadata.costClass` field that is:
- **Persistent**: Survives agent renames
- **Explicit**: Clear classification attached to each agent
- **Centralized**: Single source of truth for agent cost classification

## Cost Classes

### Platform (platform)
Agents that are core infrastructure and should always run regardless of cost considerations.

- `paperclip-orchestrator`
- `paperclip-monitor`
- `paperclip-governor`
- `sentinel`
- `moklabs-sentinel`
- `kindra-sentinel`

### Core Thesis (core-thesis)
Agents that directly implement the core business value proposition.

- `thesis-governor`
- `thesis-agent`

### Secondary (secondary)
Agents that provide important but non-core functionality.

- All other operational agents that provide business value
- Support agents for monitoring, reporting, optimization
- Specialized task agents

### Parked (parked)
Agents that are temporarily or permanently inactive.

- Agents in development or testing
- Deprecated agents being kept for reference
- Seasonal or intermittent agents

## Implementation

The cost class is stored in the agent's metadata field:

```json
{
  "metadata": {
    "costClass": "platform|core-thesis|secondary|parked"
  }
}
```

### API Endpoint

Agent metadata can be queried and updated via the Paperclip API:

- **GET** `/api/agents` - List all agents with their metadata
- **PATCH** `/api/agents/{agentId}` - Update agent metadata

### Governor Integration

Governor policies should reference `agent.metadata.costClass` instead of agent name matching:

**Old approach (deprecated):**
```javascript
if (agent.name.includes('sentinel') || agent.name.includes('governor')) {
  // Exempt from policy
}
```

**New approach:**
```javascript
if (agent.metadata.costClass === 'platform' || agent.metadata.costClass === 'core-thesis') {
  // Exempt from policy
}
```

## Agent Classification Table

| Agent Name | Cost Class | Notes |
|------------|------------|-------|
| paperclip-orchestrator | platform | Core orchestration |
| paperclip-monitor | platform | Infrastructure monitoring |
| paperclip-governor | platform | Policy enforcement |
| sentinel | platform | Security sentinel |
| moklabs-sentinel | platform | Moklabs security sentinel |
| kindra-sentinel | platform | Kindra security sentinel |
| thesis-governor | core-thesis | Core thesis governance |
| thesis-agent | core-thesis | Core thesis implementation |

*Note: Additional secondary and parked agents should be classified based on their current operational status and business criticality.*

## Maintenance

### Adding New Agents

When creating new agents, assign the appropriate cost class in the metadata:

1. Determine the appropriate class based on the agent's purpose
2. Set `metadata.costClass` during agent creation
3. Update this documentation if the agent is platform or core-thesis

### Renaming Agents

When renaming agents, the cost class is preserved automatically since it's stored in metadata, not derived from the name.

### Auditing

Regular audits should ensure:
- All agents have a cost class assigned
- Cost classes reflect current business priorities
- No agents are classified as "unmapped"

## Future Considerations

### Cost-Based Routing

Future implementations may use cost class for:
- **Resource allocation**: Prioritizing platform agents during resource constraints
- **Cost optimization**: Different billing rates or quotas per class
- **Performance tuning**: Different runtime parameters per class

### Billing Integration

While `billingCode` is not currently settable on individual agents (only at organization level), the cost class field provides a foundation for future cost allocation and reporting capabilities.

## Related Documentation

- [Paperclip API Documentation](/docs/api/paperclip-api.md)
- [Governor Policies](/docs/governance/governor-policies.md)
- [Agent Lifecycle Management](/docs/operations/agent-lifecycle.md)