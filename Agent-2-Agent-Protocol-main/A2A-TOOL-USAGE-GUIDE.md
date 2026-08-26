# A2A Protocol Tool Usage & Agent Commerce Guide

## 📚 Overview

### Agent 2 Agent (A2A) Protocol
- **Official Spec**: [Google A2A Protocol](https://google.github.io/A2A/)
- **Purpose**: Enable AI agents to communicate and collaborate as **agents**, not just tools
- **Key Features**:
  - Agent discovery via Agent Cards (`/.well-known/agent.json`)
  - JSON-RPC 2.0 over HTTP(S)
  - Task-based communication
  - Rich data exchange (text, files, structured data)
  - Streaming support (SSE)
  - Artifacts for tool outputs

### Agent Commerce Protocol
- **Note**: There isn't a separate "Agent Commerce Protocol" - this is likely a conceptual term referring to agents transacting/communicating with each other using A2A Protocol
- **Concept**: Agents can "trade" services, information, or capabilities using A2A Protocol
- **Implementation**: Uses A2A Protocol's task system, artifacts, and skills

---

## 🔧 Tool Usage in A2A Protocol

A2A Protocol doesn't have traditional "function calling" like OpenAI's tool calling. Instead, it uses:

### 1. **Artifacts** - Tool Outputs
Artifacts are structured outputs that agents can produce and exchange. They're like tool results.

**Structure**:
```typescript
interface Artifact {
  name?: string | null;
  description?: string | null;
  parts: Part[];  // Can contain text, data (JSON), or files
  index?: number;
  append?: boolean | null;
  lastChunk?: boolean | null;
  metadata?: Record<string, any> | null;
}
```

**Part Types**:
- `TextPart`: Plain text content
- `DataPart`: Structured JSON data (`{ type: 'data', data: {...} }`)
- `FilePart`: Files (images, documents, etc.)

### 2. **Skills** - Agent Capabilities
Skills are defined in the Agent Card and describe what the agent can do.

**Structure**:
```typescript
interface AgentSkill {
  id: string;
  name: string;
  description?: string | null;
  tags?: string[] | null;
  examples?: string[] | null;
  inputModes?: string[] | null;  // e.g., ['application/json', 'text/plain']
  outputModes?: string[] | null;  // e.g., ['application/json', 'image/png']
}
```

### 3. **Task Artifacts** - Returning Tool Results
Agents can return artifacts in task responses:

```typescript
const task: Task = {
  id: taskId,
  status: {
    state: TaskState.Completed,
    message: { /* response message */ }
  },
  artifacts: [
    {
      name: 'Analysis Result',
      description: 'Data analysis output',
      parts: [
        {
          type: 'data',
          data: { result: 'analysis', value: 42 }
        }
      ]
    }
  ]
};
```

---

## 🛠️ How to Implement Tool Usage in a2a-js SDK

### Option 1: Using Artifacts (Recommended for Tool Outputs)

**In Agent Executor (Agent B)**:
```javascript
async onMessageSend(request, task) {
  // Parse the request to understand what tool/operation is needed
  const messageText = request.params.message.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
  
  // Check if it's a tool request (e.g., "calculate 5+3" or structured data)
  let result;
  if (messageText.includes('calculate')) {
    // Perform tool operation
    result = performCalculation(messageText);
  }
  
  // Return task with artifact containing tool result
  const taskObj = task || { /* create new task */ };
  
  taskObj.artifacts = [
    {
      name: 'Calculation Result',
      description: 'Result of the calculation',
      parts: [
        {
          type: 'data',
          data: { result: result, operation: messageText }
        }
      ]
    }
  ];
  
  taskObj.status = {
    state: TaskState.Completed,
    message: {
      role: Role.Agent,
      parts: [{ type: 'text', text: `Calculation complete: ${result}` }]
    }
  };
  
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: taskObj
  };
}
```

### Option 2: Using Structured Data (DataPart)

**Sending tool request**:
```javascript
// Agent A sends structured data request
const task = await client.sendTask({
  id: uuidv4(),
  message: {
    role: Role.User,
    parts: [
      {
        type: 'data',
        data: {
          tool: 'calculate',
          operation: 'add',
          operands: [5, 3]
        },
        metadata: {
          desiredOutputMimeType: 'application/json'
        }
      }
    ]
  }
});
```

**Receiving structured response**:
```javascript
// Agent B processes and responds
const toolRequest = request.params.message.parts.find(p => p.type === 'data');
if (toolRequest && toolRequest.data.tool === 'calculate') {
  const result = calculate(toolRequest.data.operation, toolRequest.data.operands);
  
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      ...task,
      status: {
        state: TaskState.Completed,
        message: {
          role: Role.Agent,
          parts: [
            {
              type: 'data',
              data: { result: result }
            }
          ]
        }
      }
    }
  };
}
```

### Option 3: Using Files (FilePart)

**Sending file for processing**:
```javascript
// Agent A sends file
const task = await client.sendTask({
  id: uuidv4(),
  message: {
    role: Role.User,
    parts: [
      { type: 'text', text: 'Analyze this image' },
      {
        type: 'file',
        file: {
          name: 'image.png',
          mimeType: 'image/png',
          bytes: base64EncodedImage  // or uri: 'https://...'
        }
      }
    ]
  }
});
```

---

## 📋 Current Implementation Status

### What We Have:
✅ **Basic A2A Communication**
- Agent discovery
- Task sending/receiving
- Message exchange
- Conversation history

❌ **Missing Tool Usage**:
- No artifacts in responses
- No structured data (DataPart) exchange
- No file exchange
- No tool definitions in skills

### What We Need to Add:

1. **Define Skills with Tool Capabilities**:
```javascript
const skill = {
  id: 'calculator',
  name: 'Calculator Tool',
  description: 'Performs mathematical calculations',
  tags: ['math', 'calculator', 'tool'],
  examples: ['calculate 5+3', 'add 10 and 20'],
  inputModes: ['text/plain', 'application/json'],
  outputModes: ['application/json']
};
```

2. **Implement Tool Execution**:
```javascript
// Parse tool requests and execute
function executeTool(toolName, params) {
  switch(toolName) {
    case 'calculate':
      return performCalculation(params);
    case 'search':
      return performSearch(params);
    // etc.
  }
}
```

3. **Return Artifacts**:
```javascript
taskObj.artifacts = [{
  name: 'Tool Result',
  parts: [{
    type: 'data',
    data: toolResult
  }]
}];
```

---

## 🔄 Agent Commerce Concept

While not a separate protocol, "Agent Commerce" can be implemented using A2A:

1. **Service Discovery**: Agents advertise capabilities via Agent Cards
2. **Service Request**: Agent A requests service from Agent B via tasks
3. **Service Delivery**: Agent B performs operation and returns result
4. **Payment/Billing**: Could use metadata or separate commerce layer

**Example Flow**:
```
Agent A (Client)           Agent B (Service Provider)
    |                              |
    |-- tasks/send -------------->|
    |   (Request: "Process image") |
    |                              |
    |                              | Execute tool
    |                              | (Image processing)
    |                              |
    |<-- Task Response -----------|
    |   (Artifact: processed image)|
```

---

## 🎯 Next Steps for Implementation

1. **Add Tool Definitions** to Agent Cards (skills)
2. **Implement Tool Parsing** in executors
3. **Return Artifacts** in task responses
4. **Handle Structured Data** (DataPart) for tool I/O
5. **Support File Exchange** for file-based tools

---

## 📖 References

- [A2A Protocol Specification](https://google.github.io/A2A/specification/)
- [A2A Protocol Documentation](https://google.github.io/A2A/)
- [A2A-JS SDK Repository](https://github.com/techurbanist/a2a-js)
- SDK Examples: `node_modules/a2a-js/dist/examples/common-workflows/`

