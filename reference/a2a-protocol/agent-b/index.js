import { Role, A2AServer, DefaultA2ARequestHandler, OperationNotSupportedError, TaskState } from 'a2a-js';

/**
 * Agent 2: Product Service Agent
 * 
 * This agent has access to an ACP (Agent Commerce Protocol) Tool endpoint.
 * It receives product inventory requests from Agent 1 via A2A Protocol,
 * calls the ACP tool endpoint to get product data, and returns results
 * as A2A artifacts.
 * 
 * A2A Protocol Flow:
 * 1. Receives task via tasks/send (JSON-RPC 2.0)
 * 2. Parses product request from message
 * 3. Calls ACP Tool endpoint (external HTTP API)
 * 4. Transforms ACP response into A2A artifacts
 * 5. Returns task with artifacts containing product data
 */

const ACP_TOOL_ENDPOINT = 'https://shopify.actory.ai/api/actory/catalog/acp-store-8881.myshopify.com';


/**
 * ACP Tool Integration
 * Calls the external ACP-compatible endpoint to get product inventory
 */
class ACPToolClient {
  /**
   * Fetch products from ACP endpoint
   * 
   * The ACP endpoint returns a Shopify catalog in ACP format:
   * {
   *   "products": [
   *     {
   *       "id": "gid://shopify/Product/...",
   *       "name": "Product Name",
   *       "price": { "amount": 100, "currency": "EUR" },
   *       "availability": { "inStock": true, "quantity": 50 },
   *       ...
   *     }
   *   ],
   *   "shop": { ... },
   *   "metadata": { ... }
   * }
   * 
   * @param {Object} filters - Optional filters for products (category, etc.)
   * @returns {Promise<Object>} Product inventory data in normalized format
   */
  async getProducts(filters = {}) {
    try {
      console.log(`   🔗 Calling ACP Tool: ${ACP_TOOL_ENDPOINT}`);
      
      const response = await fetch(ACP_TOOL_ENDPOINT, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`ACP endpoint error: ${response.status} ${response.statusText}`);
      }
      
      const acpResponse = await response.json();
      console.log(`   ✅ ACP Tool Response: Received ${acpResponse.products?.length || 0} products`);
      
      const normalizedProducts = (acpResponse.products || []).map(product => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
        description: product.description || '',
        price: product.price?.amount || 0,
        currency: product.price?.currency || 'USD',
        inStock: product.availability?.inStock || false,
        quantity: product.availability?.quantity || 0,
        category: product.category || '',
        vendor: product.attributes?.vendor || '',
        tags: product.attributes?.tags || []
      }));
      
      return {
        products: normalizedProducts,
        metadata: {
          total: acpResponse.metadata?.total || normalizedProducts.length,
          shop: acpResponse.shop?.name || 'Unknown',
          currency: acpResponse.shop?.currency || 'USD',
          lastSync: acpResponse.shop?.lastSync || null
        }
      };
      
    } catch (error) {
      console.error(`   ❌ ACP Tool Error: ${error.message}`);
      throw error; // Re-throw to let caller handle it
    }
  }
}

/**
 * Product Service Agent Executor
 * Implements the A2A AgentExecutor interface
 * Handles product inventory requests and integrates with ACP Tool
 */
class ProductServiceExecutor {
  constructor() {
    this.acpTool = new ACPToolClient();
  }

  /**
   * Handle message send request (tasks/send)
   * This is called when Agent 1 sends a task via A2A Protocol
   * 
   * @param {Object} request - JSON-RPC request with message
   * @param {Object} task - Existing task (if continuing a conversation)
   * @returns {Object} JSON-RPC response with Task object
   */
  async onMessageSend(request, task) {
    try {
      console.log(`\n📥 Received A2A Request (tasks/send)`);
      console.log(`   Request ID: ${request.id}`);
      console.log(`   Method: ${request.method}`);
      
      // Extract the message from the A2A request
      // The message is in request.params.message
      const message = request.params.message;
      
      // Extract text from message parts
      const messageText = message.parts
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
      
      const dataPart = message.parts.find(part => part.type === 'data');
      const structuredRequest = dataPart ? dataPart.data : null;
      
      console.log(`   Message: ${messageText}`);
      if (structuredRequest) {
        console.log(`   Structured Data:`, JSON.stringify(structuredRequest));
      }
      
      // Determine if this is a product inventory request
      const isProductRequest = 
        messageText.toLowerCase().includes('product') ||
        messageText.toLowerCase().includes('inventory') ||
        messageText.toLowerCase().includes('get') ||
        (structuredRequest && structuredRequest.action === 'get_products');
      
      if (!isProductRequest) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32602,
            message: 'This agent only handles product inventory requests'
          }
        };
      }
      
      const filters = structuredRequest?.filters || {};
      
      // Call ACP Tool to get product inventory
      console.log(`\n🔧 Step 1: Calling ACP Tool for product inventory`);
      const productData = await this.acpTool.getProducts(filters);
      
      console.log(`\n🔧 Step 2: Transforming ACP response to A2A format`);
      
      const taskId = request.params.id;
      const sessionId = request.params.sessionId || null;
      
      const taskObj = task || {
        id: taskId,
        sessionId: sessionId,
        status: {
          state: TaskState.Working,
          message: null,
          timestamp: new Date().toISOString()
        },
        history: [],
        artifacts: [],
        metadata: {}
      };
      
      // Add user message to history
      if (!taskObj.history) {
        taskObj.history = [];
      }
      taskObj.history.push(message);
      
      const agentMessage = {
        role: Role.Agent,
        parts: [
          {
            type: 'text',
            text: `Found ${productData.products?.length || 0} products in inventory.`
          }
        ]
      };
      
      // Add agent response to history
      taskObj.history.push(agentMessage);
      
      const productArtifact = {
        name: 'Product Inventory',
        description: 'Current inventory of available products',
        parts: [
          {
            type: 'data',  // DataPart for structured JSON data
            data: productData  // The actual product data from ACP tool
          }
        ],
        index: 0,
        metadata: {
          source: 'ACP Tool',
          timestamp: new Date().toISOString()
        }
      };
      
      // Update task with completed status and artifacts
      taskObj.status = {
        state: TaskState.Completed,
        message: agentMessage,
        timestamp: new Date().toISOString()
      };
      
      taskObj.artifacts = [productArtifact];
      
      console.log(`\n✅ A2A Response Prepared`);
      console.log(`   Task State: ${taskObj.status.state}`);
      console.log(`   Artifacts: ${taskObj.artifacts.length}`);
      console.log(`   Products in Artifact: ${productData.products?.length || 0}`);
      
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: taskObj  // Return Task object (not just Message)
      };
      
    } catch (error) {
      console.error(`\n❌ Error processing request: ${error.message}`);
      
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: error.message || 'Internal error processing product request'
        }
      };
    }
  }

  /**
   * Handle streaming message send (tasks/sendSubscribe)
   * For now, we'll use the same logic as onMessageSend
   */
  async *onMessageStream(request, task) {
    
    const response = await this.onMessageSend(request, task);
    
    if (response.result) {
      // Yield task status update event
      yield {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          type: 'taskStatusUpdate',
          id: response.result.id,
          status: response.result.status,
          final: true
        }
      };
      
      // If there are artifacts, yield artifact update event
      if (response.result.artifacts && response.result.artifacts.length > 0) {
        for (const artifact of response.result.artifacts) {
          yield {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              type: 'taskArtifactUpdate',
              id: response.result.id,
              artifact: artifact
            }
          };
        }
      }
    } else {
      // Yield error
      yield {
        jsonrpc: '2.0',
        id: request.id,
        error: response.error
      };
    }
  }

  /**
   * Handle task cancellation
   */
  async onCancel(request, task) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: new OperationNotSupportedError()
    };
  }

  /**
   * Handle task resubscription
   */
  async *onResubscribe(request, task) {
    yield {
      jsonrpc: '2.0',
      id: request.id,
      error: new OperationNotSupportedError()
    };
  }
}

/**
 * Define Agent Card for Agent 2
 * The Agent Card describes what this agent can do (its skills)
 * Agent 1 discovers this via /.well-known/agent.json
 */
const productInventorySkill = {
  id: 'product_inventory',
  name: 'Product Inventory Service',
  description: 'Retrieves product information from inventory via ACP Tool',
  tags: ['products', 'inventory', 'commerce', 'acp'],
  examples: [
    'Get all products',
    'Show me inventory',
    'List products',
    'Get product catalog'
  ],
  inputModes: ['text/plain', 'application/json'],  // Accepts text or JSON
  outputModes: ['application/json']  // Returns structured JSON data
};

const agentCard = {
  name: 'Product Service Agent',
  description: 'Provides product inventory information by integrating with ACP Tool. Receives requests via A2A Protocol and returns product data as artifacts.',
  url: 'http://localhost:3001/',
  version: '1.0.0',
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['application/json'],
  capabilities: { 
    streaming: true  // Support streaming responses
  },
  skills: [productInventorySkill],  // Advertise product inventory skill
  authentication: {
    schemes: ['public']  // No authentication required (adjust for production)
  }
};

/**
 * Custom Request Handler
 * Extends DefaultA2ARequestHandler to properly save tasks
 * The default handler checks for "taskId" but Task objects use "id"
 */
class CustomRequestHandler extends DefaultA2ARequestHandler {
  /**
   * Override onMessageSend to ensure tasks are saved correctly
   * The SDK's default handler has a bug where it checks for "taskId"
   * but Task objects use "id" property
   */
  async onMessageSend(request) {
    const response = await super.onMessageSend(request);
    
    if ("result" in response &&
        response.result &&
        typeof response.result === "object" &&
        "id" in response.result &&
        "status" in response.result) {
      await this.taskStore.save(response.result);
    }
    
    return response;
  }
}

const requestHandler = new CustomRequestHandler(new ProductServiceExecutor());

const server = new A2AServer(agentCard, requestHandler);

const port = 3001;
server.start({ port });

console.log(`🛍️  Agent 2 (Product Service) running on http://localhost:${port}`);
console.log(`📋 Agent Card: http://localhost:${port}/.well-known/agent.json`);
console.log(`\n🔧 Configuration:`);
console.log(`   ACP Tool Endpoint: ${ACP_TOOL_ENDPOINT}`);
console.log(`   Skill: Product Inventory Service`);
console.log(`\n📡 A2A Protocol Endpoints:`);
console.log(`   GET  /.well-known/agent.json  - Agent Discovery`);
console.log(`   POST /                        - JSON-RPC 2.0 Endpoint`);
console.log(`\n📝 Supported Methods:`);
console.log(`   - tasks/send                  - Receive product requests`);
console.log(`   - tasks/get                   - Retrieve task status`);
console.log(`   - tasks/sendSubscribe         - Streaming requests`);
console.log(`\n🔄 Ready to serve product inventory requests via A2A Protocol!`);
console.log();
